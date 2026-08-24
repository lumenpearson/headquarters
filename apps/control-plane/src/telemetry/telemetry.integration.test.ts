import { randomBytes } from 'node:crypto';

import { create, fromJson, type JsonValue } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { HandlerContext } from '@connectrpc/connect';
import { ResourceIdSchema, RevisionSchema, telemetryV1 } from '@gremuchaya/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { createTelemetryService } from './service.js';
import { DurableSimulationProfileStore } from './store.js';

/**
 * Real PostgreSQL proof for the simulation half of `TelemetryService`.
 *
 * Every scenario here is a property a scripted `SqlClient` cannot show. Two
 * concurrent updates land on consecutive revisions only because the profile
 * lock serializes them; a duplicate name is refused only because migration
 * 0008's unique index is really there; a retry bumps the revision once only
 * because the receipt claim commits before the statement that completes it; a
 * deleted group takes its profiles and their history with it only because the
 * foreign keys cascade. Statement text asserts the intent of all four and
 * proves none of them.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('durable simulation profiles against real PostgreSQL', () => {
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '');
  let database: SqlClient;

  beforeAll(async () => {
    const swept = await pool.sweep();
    if (swept.dropped.length > 0) {
      process.stderr.write(`Swept abandoned test databases: ${swept.dropped.join(', ')}\n`);
    }
    database = await pool.create();
    await runMigrations(database);
  }, networkTimeoutMs);

  afterAll(async () => {
    await pool.dropAll();
  }, networkTimeoutMs);

  it(
    'gives two concurrent updates consecutive revisions and no duplicate version',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const profile = await store.create({
        groupId: owner.groupId,
        deviceId: owner.authenticated.device.id,
        profileId: crypto.randomUUID(),
        name: `Смена ${uniqueSuffix()}`,
        presetKind: 'CUSTOM',
        profile: profileBody('Смена'),
      });

      // Both writers start from revision 1. Only the lock the update takes on
      // the profile row stops them from computing revision 2 twice, and the
      // unique index on (profile_id, revision) would turn that into a failure
      // rather than a silent overwrite.
      const [first, second] = await Promise.all([
        store.update({
          groupId: owner.groupId,
          deviceId: owner.authenticated.device.id,
          profileId: profile.id,
          name: `Смена ${uniqueSuffix()}`,
          presetKind: 'CUSTOM',
          profile: profileBody('Смена A'),
        }),
        store.update({
          groupId: owner.groupId,
          deviceId: owner.authenticated.device.id,
          profileId: profile.id,
          name: `Смена ${uniqueSuffix()}`,
          presetKind: 'CUSTOM',
          profile: profileBody('Смена B'),
        }),
      ]);

      expect([first.revision, second.revision].sort()).toEqual([2n, 3n]);
      const versions = await database.query<{ total: number; distinct: number; highest: string }>({
        text: `SELECT
                 count(*)::int AS total,
                 count(DISTINCT revision)::int AS distinct,
                 max(revision)::text AS highest
               FROM simulation_versions WHERE profile_id = $1`,
        values: [profile.id],
      });
      expect(versions[0]).toEqual({ total: 3, distinct: 3, highest: '3' });
    },
    networkTimeoutMs,
  );

  it(
    'bumps the revision once however many times one update is retried',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const name = `Смена ${uniqueSuffix()}`;
      const profile = await store.create({
        groupId: owner.groupId,
        deviceId: owner.authenticated.device.id,
        profileId: crypto.randomUUID(),
        name,
        presetKind: 'CUSTOM',
        profile: profileBody('Смена'),
      });
      const requestId = `simulation-update-${uniqueSuffix()}`;
      const retried = {
        groupId: owner.groupId,
        deviceId: owner.authenticated.device.id,
        profileId: profile.id,
        name,
        presetKind: 'CUSTOM',
        profile: profileBody('Смена, переписанная'),
        mutation: { requestId },
      };

      const first = await store.update(retried);
      const again = await store.update(retried);

      expect(first.revision).toBe(2n);
      expect(again.revision).toBe(first.revision);
      expect(again.profile).toEqual(first.profile);
      const stored = await database.query<{ revision: string; versions: number }>({
        text: `SELECT
                 (SELECT revision::text FROM simulation_profiles WHERE id = $1) AS revision,
                 (SELECT count(*)::int FROM simulation_versions WHERE profile_id = $1) AS versions`,
        values: [profile.id],
      });
      // The retry wrote nothing: the profile still stands at the revision the
      // first attempt produced, and history gained no second entry for it.
      expect(stored[0]).toEqual({ revision: '2', versions: 2 });
    },
    networkTimeoutMs,
  );

  it(
    'replays a stored version into the published profile from that row alone',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const service = createTelemetryService({ runtime, profiles: store });
      const owner = await bootstrapGroup(runtime);
      const createProfile = requireMethod(service.createSimulationProfile);

      const response = await createProfile(
        create(telemetryV1.CreateSimulationProfileRequestSchema, {
          profile: publishedProfile(owner.groupId, `Смена ${uniqueSuffix()}`),
        }),
        bearer(owner.accessToken),
      );
      const published = requireProfile(response);

      const version = await store.readVersion({
        groupId: owner.groupId,
        deviceId: owner.authenticated.device.id,
        profileId: published.id?.value ?? '',
        revision: published.revision?.number ?? 0n,
      });

      // Nothing but this one row takes part in the reconstruction: the body
      // carries everything the client authored, and the row's own three
      // columns carry what the server owns. A version table of patches could
      // not answer this without replaying every version before it.
      const replayed = fromJson(telemetryV1.SimulationProfileSchema, version.profile as JsonValue);
      replayed.id = create(ResourceIdSchema, { value: version.profileId });
      replayed.revision = create(RevisionSchema, {
        number: version.revision,
        etag: `simulation-profile-${version.profileId}-revision-${version.revision.toString()}`,
      });
      replayed.updatedAt = timestampFromDate(version.createdAt);

      expect(replayed).toEqual(published);
      expect(replayed.channels).toHaveLength(1);
      expect(replayed.channels[0]?.valueCurve?.points).toHaveLength(2);
    },
    networkTimeoutMs,
  );

  it(
    'rewinds to an earlier profile by appending it, never by removing history',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const name = `Смена ${uniqueSuffix()}`;
      const actor = { groupId: owner.groupId, deviceId: owner.authenticated.device.id };
      const original = await store.create({
        ...actor,
        profileId: crypto.randomUUID(),
        name,
        presetKind: 'CUSTOM',
        profile: profileBody('Исходная'),
      });
      await store.update({
        ...actor,
        profileId: original.id,
        name,
        presetKind: 'CUSTOM',
        profile: profileBody('Переписанная'),
      });

      const rewound = await store.readVersion({
        ...actor,
        profileId: original.id,
        revision: original.revision,
      });
      const reverted = await store.update({
        ...actor,
        profileId: original.id,
        name,
        presetKind: 'CUSTOM',
        profile: rewound.profile,
      });

      expect(reverted.revision).toBe(3n);
      expect(reverted.profile).toEqual(original.profile);
      const history = await database.query<{ revision: string; body: string }>({
        text: `SELECT revision::text AS revision, profile->>'name' AS body
               FROM simulation_versions WHERE profile_id = $1 ORDER BY revision ASC`,
        values: [original.id],
      });
      // Revision 1 is still there, unchanged, and the rewind is revision 3
      // beside it rather than in place of revision 2.
      expect(history.map((row) => row.revision)).toEqual(['1', '2', '3']);
      expect(history[0]?.body).toBe('Исходная');
      expect(history[1]?.body).toBe('Переписанная');
      expect(history[2]?.body).toBe('Исходная');
    },
    networkTimeoutMs,
  );

  it(
    'keeps one name per group and lets another group reuse it',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const neighbour = await bootstrapGroup(runtime);
      const name = `Смена ${uniqueSuffix()}`;
      const actor = { groupId: owner.groupId, deviceId: owner.authenticated.device.id };
      await store.create({
        ...actor,
        profileId: crypto.randomUUID(),
        name,
        presetKind: 'CUSTOM',
        profile: profileBody('Первая'),
      });

      await expect(
        store.create({
          ...actor,
          profileId: crypto.randomUUID(),
          name,
          presetKind: 'CUSTOM',
          profile: profileBody('Вторая'),
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ALREADY_EXISTS' });

      // A rename into a taken name reaches the index itself rather than the
      // conflict clause, so this is migration 0008 refusing the write.
      const other = await store.create({
        ...actor,
        profileId: crypto.randomUUID(),
        name: `${name}-2`,
        presetKind: 'CUSTOM',
        profile: profileBody('Вторая'),
      });
      await expect(
        store.update({
          ...actor,
          profileId: other.id,
          name,
          presetKind: 'CUSTOM',
          profile: profileBody('Вторая'),
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ALREADY_EXISTS' });

      const elsewhere = await store.create({
        groupId: neighbour.groupId,
        deviceId: neighbour.authenticated.device.id,
        profileId: crypto.randomUUID(),
        name,
        presetKind: 'CUSTOM',
        profile: profileBody('Первая'),
      });
      expect(elsewhere.revision).toBe(1n);
      const counts = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM simulation_profiles WHERE name = $1',
        values: [name],
      });
      expect(counts[0]?.n).toBe(2);
    },
    networkTimeoutMs,
  );

  it(
    'refuses a viewer every write and lets it read',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const viewer = await pairDevice(runtime, owner, 'VIEWER');
      const existing = await store.create({
        groupId: owner.groupId,
        deviceId: owner.authenticated.device.id,
        profileId: crypto.randomUUID(),
        name: `Смена ${uniqueSuffix()}`,
        presetKind: 'CUSTOM',
        profile: profileBody('Первая'),
      });
      const viewerActor = { groupId: owner.groupId, deviceId: viewer.deviceId };

      await expect(
        store.create({
          ...viewerActor,
          profileId: crypto.randomUUID(),
          name: `Смена ${uniqueSuffix()}`,
          presetKind: 'CUSTOM',
          profile: profileBody('Своя'),
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
      await expect(store.delete({ ...viewerActor, profileId: existing.id })).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'PERMISSION_DENIED',
      });
      await expect(
        store.setTimeScale({ ...viewerActor, profileId: existing.id, timeScale: 4 }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });

      // The refusal is about writing, not about looking: a device allowed to
      // watch the wall may read what drives it.
      const listed = await store.list({ ...viewerActor, pageSize: 10, cursor: '' });
      expect(listed.items.map((item) => item.id)).toEqual([existing.id]);
      const written = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM simulation_profiles WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(written[0]?.n).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'takes a group’s profiles and their whole history away with the group',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const actor = { groupId: owner.groupId, deviceId: owner.authenticated.device.id };
      const name = `Смена ${uniqueSuffix()}`;
      const profile = await store.create({
        ...actor,
        profileId: crypto.randomUUID(),
        name,
        presetKind: 'CUSTOM',
        profile: profileBody('Первая'),
      });
      await store.update({
        ...actor,
        profileId: profile.id,
        name,
        presetKind: 'CUSTOM',
        profile: profileBody('Вторая'),
      });

      await database.query({ text: 'DELETE FROM groups WHERE id = $1', values: [owner.groupId] });

      const counts = await database.query<{ profiles: number; versions: number }>({
        text: `SELECT
                 (SELECT count(*)::int FROM simulation_profiles WHERE group_id = $1) AS profiles,
                 (SELECT count(*)::int FROM simulation_versions WHERE profile_id = $2) AS versions`,
        values: [owner.groupId, profile.id],
      });
      expect(counts[0]).toEqual({ profiles: 0, versions: 0 });
    },
    networkTimeoutMs,
  );

  it(
    'refuses a write whose expected revision the profile has already passed',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const actor = { groupId: owner.groupId, deviceId: owner.authenticated.device.id };
      const name = `Смена ${uniqueSuffix()}`;
      const profile = await store.create({
        ...actor,
        profileId: crypto.randomUUID(),
        name,
        presetKind: 'CUSTOM',
        profile: profileBody('Первая'),
      });
      await store.update({
        ...actor,
        profileId: profile.id,
        name,
        presetKind: 'CUSTOM',
        profile: profileBody('Вторая'),
      });

      await expect(
        store.update({
          ...actor,
          profileId: profile.id,
          name,
          presetKind: 'CUSTOM',
          profile: profileBody('Третья'),
          expectedRevision: 1n,
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ABORTED' });
      const unchanged = await database.query<{ revision: string; versions: number }>({
        text: `SELECT
                 (SELECT revision::text FROM simulation_profiles WHERE id = $1) AS revision,
                 (SELECT count(*)::int FROM simulation_versions WHERE profile_id = $1) AS versions`,
        values: [profile.id],
      });
      // A refused write consumes no revision and leaves no version behind it.
      expect(unchanged[0]).toEqual({ revision: '2', versions: 2 });
    },
    networkTimeoutMs,
  );

  it(
    'settles a preset onto one profile however often it is applied',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const service = createTelemetryService({ runtime, profiles: store });
      const owner = await bootstrapGroup(runtime);
      const applyPreset = requireMethod(service.applySimulationPreset);
      const request = create(telemetryV1.ApplySimulationPresetRequestSchema, {
        groupId: { value: owner.groupId },
        preset: telemetryV1.SimulationPresetKind.NETWORK_ATTACK,
      });

      const first = requireProfile(await applyPreset(request, bearer(owner.accessToken)));
      const second = requireProfile(await applyPreset(request, bearer(owner.accessToken)));

      expect(first.name).toBe('preset:NETWORK_ATTACK');
      expect(second.id?.value).toBe(first.id?.value);
      expect(second.revision?.number).toBe(2n);
      const profiles = await database.query<{ n: number; kind: string }>({
        text: `SELECT count(*)::int AS n, max(preset_kind) AS kind
               FROM simulation_profiles WHERE group_id = $1`,
        values: [owner.groupId],
      });
      // The upsert lands on migration 0008's unique index, so a second
      // application is a second revision of one profile and never a second row.
      expect(profiles[0]).toEqual({ n: 1, kind: 'NETWORK_ATTACK' });
    },
    networkTimeoutMs,
  );

  it(
    'carries one profile through the service from its clock to its deletion',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const service = createTelemetryService({ runtime, profiles: store });
      const owner = await bootstrapGroup(runtime);
      const token = bearer(owner.accessToken);
      const created = requireProfile(
        await requireMethod(service.createSimulationProfile)(
          create(telemetryV1.CreateSimulationProfileRequestSchema, {
            profile: publishedProfile(owner.groupId, `Смена ${uniqueSuffix()}`),
          }),
          token,
        ),
      );
      const profileId = created.id?.value ?? '';

      const retimed = requireProfile(
        await requireMethod(service.setSimulationClock)(
          create(telemetryV1.SetSimulationClockRequestSchema, {
            profileId: { value: profileId },
            running: true,
            timeScale: 3.5,
            phase: 0.25,
          }),
          token,
        ),
      );
      // `running` and `phase` have nowhere in the contract to come back from,
      // so the response reports the one clock property that was persisted.
      expect(retimed.timeScale).toBe(3.5);
      expect(retimed.revision?.number).toBe(2n);
      expect(retimed.channels).toHaveLength(1);

      const listed = (await requireMethod(service.listSimulationProfiles)(
        create(telemetryV1.ListSimulationProfilesRequestSchema, {
          groupId: { value: owner.groupId },
        }),
        token,
      )) as telemetryV1.ListSimulationProfilesResponse;
      expect(listed.profiles).toHaveLength(1);
      expect(listed.profiles[0]?.timeScale).toBe(3.5);
      expect(listed.page?.hasMore).toBe(false);
      expect(listed.page?.approximateTotal).toBe(1n);

      const deleted = (await requireMethod(service.deleteSimulationProfile)(
        create(telemetryV1.DeleteSimulationProfileRequestSchema, {
          profileId: { value: profileId },
          context: { correlationId: 'shoot-day' },
        }),
        token,
      )) as telemetryV1.DeleteSimulationProfileResponse;
      expect(deleted.result?.resourceId?.value).toBe(profileId);
      expect(deleted.result?.revision?.number).toBe(2n);
      expect(deleted.result?.correlationId).toBe('shoot-day');
      const remaining = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM simulation_profiles WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(remaining[0]?.n).toBe(0);
    },
    networkTimeoutMs,
  );

  it(
    'previews a profile deterministically and refuses one aimed at another group',
    async () => {
      const runtime = createRuntime();
      const service = createTelemetryService({ runtime, profiles: createStore(runtime) });
      const owner = await bootstrapGroup(runtime);
      const neighbour = await bootstrapGroup(runtime);
      const preview = requireMethod(service.previewSimulationProfile);
      const request = create(telemetryV1.PreviewSimulationProfileRequestSchema, {
        profile: publishedProfile(owner.groupId, 'Проба'),
        sampleCount: 8,
      });

      const first = (await preview(
        request,
        bearer(owner.accessToken),
      )) as telemetryV1.PreviewSimulationProfileResponse;
      const again = (await preview(
        request,
        bearer(owner.accessToken),
      )) as telemetryV1.PreviewSimulationProfileResponse;

      expect(first.snapshots).toHaveLength(8);
      expect(first.snapshots[0]?.sequence).toBe(1n);
      expect(first.snapshots[0]?.simulated).toBe(true);
      expect(first.snapshots[0]?.samples[0]?.sourceId?.value).toBe('cpu.total');
      // Nothing but the profile and the sample index feeds the arithmetic, so
      // two previews of one profile agree on every reading.
      expect(first.snapshots.map((snapshot) => snapshot.samples[0]?.value)).toEqual(
        again.snapshots.map((snapshot) => snapshot.samples[0]?.value),
      );
      for (const snapshot of first.snapshots) {
        const value = snapshot.samples[0]?.value ?? -1;
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }

      // The token belongs to the neighbouring group, so the profile's own
      // group is refused even though nothing would have been written.
      await expect(preview(request, bearer(neighbour.accessToken))).rejects.toMatchObject({
        name: 'ConnectError',
      });
    },
    networkTimeoutMs,
  );

  function createRuntime(): DurablePairedDeviceRuntime {
    return new DurablePairedDeviceRuntime({ database, tokenPepper });
  }

  function createStore(runtime: DurablePairedDeviceRuntime): DurableSimulationProfileStore {
    return new DurableSimulationProfileStore({ database, receipts: runtime.receiptGuard });
  }

  async function bootstrapGroup(runtime: DurablePairedDeviceRuntime): Promise<{
    readonly groupId: string;
    readonly accessToken: string;
    readonly authenticated: AuthenticatedDevice;
  }> {
    const created = await runtime.createGroup({
      name: `Terminal ${uniqueSuffix()}`,
      initialDevice: {
        name: 'HQ primary',
        publicKey: `ed25519:${uniqueSuffix()}`,
        platform: 'windows',
        applicationVersion: '0.1.0',
      },
    });
    return {
      groupId: created.group.id,
      accessToken: created.session.accessToken,
      authenticated: await runtime.authenticateAccessToken(created.session.accessToken),
    };
  }

  async function pairDevice(
    runtime: DurablePairedDeviceRuntime,
    owner: { readonly groupId: string; readonly authenticated: AuthenticatedDevice },
    role: 'EDITOR' | 'VIEWER' = 'EDITOR',
  ): Promise<{ readonly deviceId: string; readonly accessToken: string }> {
    const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, role);
    const paired = await runtime.pairDevice({
      pairingCode: grant.code,
      name: 'HQ analyst',
      publicKey: `ed25519:${uniqueSuffix()}`,
      platform: 'windows',
      applicationVersion: '0.1.0',
    });
    return { deviceId: paired.device.id, accessToken: paired.session.accessToken };
  }
});

/** The stored body shape: everything a client authors, nothing the server owns. */
function profileBody(name: string): Record<string, unknown> {
  return {
    name,
    presetKind: 'SIMULATION_PRESET_KIND_CUSTOM',
    periodSeconds: 300,
    updateIntervalMs: 1000,
    timeScale: 1,
  };
}

/** A profile with a curve on it, so "the whole profile" is worth asserting. */
function publishedProfile(groupId: string, name: string): telemetryV1.SimulationProfile {
  return create(telemetryV1.SimulationProfileSchema, {
    groupId: { value: groupId },
    name,
    presetKind: telemetryV1.SimulationPresetKind.CPU_OVERLOAD,
    periodSeconds: 120,
    updateIntervalMs: 250,
    timeScale: 2,
    channels: [
      {
        sourceId: { value: 'cpu.total' },
        minimum: 0,
        maximum: 100,
        noise: 0.05,
        smoothing: 0.4,
        seed: 42n,
        valueCurve: {
          interpolation: telemetryV1.CurveInterpolation.HERMITE,
          loop: true,
          points: [
            { time: 0, value: 12, inTangent: 0, outTangent: 40 },
            { time: 1, value: 96, inTangent: 10, outTangent: 0 },
          ],
        },
        criticalityCurve: {
          interpolation: telemetryV1.CurveInterpolation.LINEAR,
          loop: false,
          points: [
            { time: 0, value: 0.1, inTangent: 0, outTangent: 0 },
            { time: 1, value: 0.9, inTangent: 0, outTangent: 0 },
          ],
        },
      },
    ],
  });
}

function bearer(accessToken: string): HandlerContext {
  return {
    requestHeader: new Headers({ authorization: `Bearer ${accessToken}` }),
  } as unknown as HandlerContext;
}

function requireMethod<T>(method: T | undefined): T {
  if (method === undefined) {
    throw new Error('The telemetry service left this method unimplemented.');
  }
  return method;
}

function requireProfile(response: unknown): telemetryV1.SimulationProfile {
  const profile = (response as { profile?: telemetryV1.SimulationProfile }).profile;
  if (profile === undefined) throw new Error('The response carried no simulation profile.');
  return profile;
}

function uniqueSuffix(): string {
  return randomBytes(8).toString('hex');
}
