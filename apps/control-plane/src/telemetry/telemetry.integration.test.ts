import { randomBytes } from 'node:crypto';

import { create, fromJson, type JsonValue } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { HandlerContext } from '@connectrpc/connect';
import {
  channelSeverity,
  channelValue,
  curvePhaseAt,
  type SimulationChannelLike,
  type TelemetrySeverityKind,
} from '@gremuchaya/domain';
import { ResourceIdSchema, RevisionSchema, telemetryV1 } from '@gremuchaya/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement, SqlTransactionResults } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { DurableTelemetryMeasurementStore } from './measurement-store.js';
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
        sources: [],
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
          sources: [],
          profile: profileBody('Смена A'),
        }),
        store.update({
          groupId: owner.groupId,
          deviceId: owner.authenticated.device.id,
          profileId: profile.id,
          name: `Смена ${uniqueSuffix()}`,
          presetKind: 'CUSTOM',
          sources: [],
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
        sources: [],
        profile: profileBody('Смена'),
      });
      const requestId = `simulation-update-${uniqueSuffix()}`;
      const retried = {
        groupId: owner.groupId,
        deviceId: owner.authenticated.device.id,
        profileId: profile.id,
        name,
        presetKind: 'CUSTOM',
        sources: [],
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
        sources: [],
        profile: profileBody('Исходная'),
      });
      await store.update({
        ...actor,
        profileId: original.id,
        name,
        presetKind: 'CUSTOM',
        sources: [],
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
        sources: [],
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
        sources: [],
        profile: profileBody('Первая'),
      });

      await expect(
        store.create({
          ...actor,
          profileId: crypto.randomUUID(),
          name,
          presetKind: 'CUSTOM',
          sources: [],
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
        sources: [],
        profile: profileBody('Вторая'),
      });
      await expect(
        store.update({
          ...actor,
          profileId: other.id,
          name,
          presetKind: 'CUSTOM',
          sources: [],
          profile: profileBody('Вторая'),
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ALREADY_EXISTS' });

      const elsewhere = await store.create({
        groupId: neighbour.groupId,
        deviceId: neighbour.authenticated.device.id,
        profileId: crypto.randomUUID(),
        name,
        presetKind: 'CUSTOM',
        sources: [],
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
        sources: [],
        profile: profileBody('Первая'),
      });
      const viewerActor = { groupId: owner.groupId, deviceId: viewer.deviceId };

      await expect(
        store.create({
          ...viewerActor,
          profileId: crypto.randomUUID(),
          name: `Смена ${uniqueSuffix()}`,
          presetKind: 'CUSTOM',
          sources: [],
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
        sources: [],
        profile: profileBody('Первая'),
      });
      await store.update({
        ...actor,
        profileId: profile.id,
        name,
        presetKind: 'CUSTOM',
        sources: [],
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
        sources: [],
        profile: profileBody('Первая'),
      });
      await store.update({
        ...actor,
        profileId: profile.id,
        name,
        presetKind: 'CUSTOM',
        sources: [],
        profile: profileBody('Вторая'),
      });

      await expect(
        store.update({
          ...actor,
          profileId: profile.id,
          name,
          presetKind: 'CUSTOM',
          sources: [],
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
    'refuses an operator profile in the namespace the presets own',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const service = createTelemetryService({ runtime, profiles: store });
      const owner = await bootstrapGroup(runtime);

      // `ApplySimulationPreset` upserts on (group_id, name). A profile authored
      // under the preset's own name would be replaced by it, channels and all,
      // with nothing said about the loss.
      await expect(
        requireMethod(service.createSimulationProfile)(
          create(telemetryV1.CreateSimulationProfileRequestSchema, {
            profile: {
              groupId: { value: owner.groupId },
              name: 'preset:NETWORK_ATTACK',
              presetKind: telemetryV1.SimulationPresetKind.NETWORK_ATTACK,
              periodSeconds: 60,
              updateIntervalMs: 1000,
              timeScale: 1,
            },
          }),
          bearer(owner.accessToken),
        ),
      ).rejects.toMatchObject({ name: 'ConnectError' });

      const stored = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM simulation_profiles WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(stored[0]?.n).toBe(0);
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

  /*
   * The measurement half, against the engine.
   *
   * Everything below is a property a scripted `SqlClient` cannot show. The
   * registry follows the profile only because migration 0011's foreign key
   * really cascades; two concurrent captures land on consecutive sequences only
   * because the allocator's row lock really serializes them; a pruned snapshot
   * really takes its samples with it; and a reading is the published curve only
   * because the body that comes back out of `jsonb` is the body that went in.
   */

  it(
    'declares a group’s data sources with its profile and retires them with it',
    async () => {
      const runtime = createRuntime();
      const service = createMeasuringService(runtime);
      const owner = await bootstrapGroup(runtime);
      const createProfile = requireMethod(service.createSimulationProfile);
      const updateProfile = requireMethod(service.updateSimulationProfile);
      const deleteProfile = requireMethod(service.deleteSimulationProfile);
      const name = `Смена ${uniqueSuffix()}`;

      const published = requireProfile(
        await createProfile(
          create(telemetryV1.CreateSimulationProfileRequestSchema, {
            profile: measuredProfile(owner.groupId, name, ['cpu.total', 'network.uplink']),
          }),
          bearer(owner.accessToken),
        ),
      );

      expect(await registeredSources(owner.groupId)).toEqual([
        { source_key: 'cpu.total', kind: 'CPU', unit: '%' },
        { source_key: 'network.uplink', kind: 'NETWORK', unit: 'Mbit/s' },
      ]);

      // The second channel is replaced. The registry has to lose the key the
      // profile stopped naming and gain the one it started naming, in the same
      // statement that wrote the profile.
      await updateProfile(
        create(telemetryV1.UpdateSimulationProfileRequestSchema, {
          profile: measuredProfile(owner.groupId, name, ['cpu.total', 'memory.used'], {
            id: published.id?.value ?? '',
          }),
        }),
        bearer(owner.accessToken),
      );
      expect(await registeredSources(owner.groupId)).toEqual([
        { source_key: 'cpu.total', kind: 'CPU', unit: '%' },
        { source_key: 'memory.used', kind: 'MEMORY', unit: '%' },
      ]);

      await deleteProfile(
        create(telemetryV1.DeleteSimulationProfileRequestSchema, {
          profileId: { value: published.id?.value ?? '' },
        }),
        bearer(owner.accessToken),
      );
      // Nothing deregisters a source explicitly. The cascade on `profile_id` is
      // the whole of that path, which is why there is no second one to forget.
      expect(await registeredSources(owner.groupId)).toEqual([]);
    },
    networkTimeoutMs,
  );

  it(
    'lists a group’s sources and refuses a device the group does not hold',
    async () => {
      const runtime = createRuntime();
      const service = createMeasuringService(runtime);
      const owner = await bootstrapGroup(runtime);
      const neighbour = await bootstrapGroup(runtime);
      const listSources = requireMethod(service.listDataSources);
      await requireMethod(service.createSimulationProfile)(
        create(telemetryV1.CreateSimulationProfileRequestSchema, {
          profile: measuredProfile(owner.groupId, `Смена ${uniqueSuffix()}`, [
            'cpu.total',
            'network.uplink',
          ]),
        }),
        bearer(owner.accessToken),
      );

      const listed = (await listSources(
        create(telemetryV1.ListDataSourcesRequestSchema, {}),
        bearer(owner.accessToken),
      )) as telemetryV1.ListDataSourcesResponse;

      expect(listed.sources.map((source) => source.id?.value)).toEqual([
        'cpu.total',
        'network.uplink',
      ]);
      expect(listed.sources[0]).toMatchObject({
        kind: telemetryV1.DataSourceKind.CPU,
        unit: '%',
        simulated: true,
      });
      // The labels are facts about the declaration, which is what tells an
      // operator which profile a source came from.
      expect(listed.sources[0]?.labels.preset).toBe('CPU_OVERLOAD');
      expect(listed.page?.approximateTotal).toBe(2n);

      // A valid token for another group reads its own registry, which is empty,
      // and never this one's.
      const foreign = (await listSources(
        create(telemetryV1.ListDataSourcesRequestSchema, {}),
        bearer(neighbour.accessToken),
      )) as telemetryV1.ListDataSourcesResponse;
      expect(foreign.sources).toEqual([]);

      // Naming a device of another group is refused rather than answered, so
      // `device_id` cannot become a way to ask whether an identifier exists.
      await expect(
        listSources(
          create(telemetryV1.ListDataSourcesRequestSchema, {
            deviceId: { value: neighbour.authenticated.device.id },
          }),
          bearer(owner.accessToken),
        ),
      ).rejects.toMatchObject({ name: 'ConnectError' });
    },
    networkTimeoutMs,
  );

  it(
    'reads the published curve at the phase the shared function gives, and keeps its chain',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const publishedAt = new Date('2026-08-29T09:00:00.000Z');
      let readingAt = new Date(publishedAt.getTime() + 1_000);
      const service = createMeasuringService(runtime, {
        profileNow: () => publishedAt,
        now: () => readingAt,
      });
      await requireMethod(service.createSimulationProfile)(
        create(telemetryV1.CreateSimulationProfileRequestSchema, {
          profile: measuredProfile(owner.groupId, `Смена ${uniqueSuffix()}`, ['cpu.total']),
        }),
        bearer(owner.accessToken),
      );
      const readSnapshot = requireMethod(service.getTelemetrySnapshot);

      const first = (await readSnapshot(
        create(telemetryV1.GetTelemetrySnapshotRequestSchema, {}),
        bearer(owner.accessToken),
      )) as telemetryV1.GetTelemetrySnapshotResponse;

      // The timeline's origin is the profile's own `updated_at`, so the index
      // and the phase are a function of the profile and the clock alone.
      const firstIndex = 1_000 / 250;
      const firstPhase = curvePhaseAt({ periodSeconds: 120, timeScale: 2 }, firstIndex * 250);
      const firstValue = channelValue(measuredChannel, firstPhase, firstIndex, undefined);
      expect(first.snapshot?.sequence).toBe(1n);
      expect(first.snapshot?.simulated).toBe(true);
      expect(first.snapshot?.samples[0]?.sourceId?.value).toBe('cpu.total');
      expect(first.snapshot?.samples[0]?.value).toBe(firstValue);
      expect(first.snapshot?.samples[0]?.unit).toBe('%');
      expect(first.snapshot?.samples[0]?.severity).toBe(
        expectedSeverity(channelSeverity(measuredChannel, firstPhase)),
      );

      // Three seconds on, well past the 125 ms cadence `update_interval_ms: 250`
      // at `time_scale: 2` asks for, so this is a fresh capture and not a re-read.
      readingAt = new Date(publishedAt.getTime() + 3_000);
      const second = (await readSnapshot(
        create(telemetryV1.GetTelemetrySnapshotRequestSchema, {}),
        bearer(owner.accessToken),
      )) as telemetryV1.GetTelemetrySnapshotResponse;

      // The previous reading comes out of the store, which is what makes a
      // channel's smoothing a property of the group's history rather than of
      // whichever process answered.
      const secondIndex = 3_000 / 250;
      const secondPhase = curvePhaseAt({ periodSeconds: 120, timeScale: 2 }, secondIndex * 250);
      expect(second.snapshot?.sequence).toBe(2n);
      expect(second.snapshot?.samples[0]?.value).toBe(
        channelValue(measuredChannel, secondPhase, secondIndex, firstValue),
      );
    },
    networkTimeoutMs,
  );

  it(
    'serves one reading to every device that asks inside the group’s own cadence',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);
      const publishedAt = new Date('2026-08-29T09:00:00.000Z');
      const service = createMeasuringService(runtime, {
        profileNow: () => publishedAt,
        // Both reads happen at one instant, which is inside any cadence.
        now: () => new Date(publishedAt.getTime() + 1_000),
      });
      await requireMethod(service.createSimulationProfile)(
        create(telemetryV1.CreateSimulationProfileRequestSchema, {
          profile: measuredProfile(owner.groupId, `Смена ${uniqueSuffix()}`, ['cpu.total']),
        }),
        bearer(owner.accessToken),
      );
      const readSnapshot = requireMethod(service.getTelemetrySnapshot);
      const request = create(telemetryV1.GetTelemetrySnapshotRequestSchema, {});

      const owned = (await readSnapshot(
        request,
        bearer(owner.accessToken),
      )) as telemetryV1.GetTelemetrySnapshotResponse;
      const paired = (await readSnapshot(
        request,
        bearer(second.accessToken),
      )) as telemetryV1.GetTelemetrySnapshotResponse;

      // Two screens of one shoot must draw one number. The second read takes no
      // capture at all, which is why the sequence has not moved.
      expect(owned.snapshot?.sequence).toBe(1n);
      expect(paired.snapshot?.sequence).toBe(1n);
      expect(paired.snapshot?.samples[0]?.value).toBe(owned.snapshot?.samples[0]?.value);
      const stored = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM telemetry_snapshots WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(stored[0]?.n).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'gives two concurrent captures consecutive sequences and leaves no snapshot without samples',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const measurements = createMeasurements();
      const capturedAt = new Date('2026-08-29T09:00:00.000Z');
      const sample = {
        sourceKey: 'cpu.total',
        value: 12.5,
        unit: '%',
        severity: 'NORMAL',
        labels: {},
      };

      // Both writers start from an empty allocator. Only the row lock the
      // upsert takes stops them from claiming sequence 1 twice, and the primary
      // key on (group_id, sequence) would turn that into a failure rather than
      // a silent overwrite.
      const [first, second] = await Promise.all([
        measurements.record({
          groupId: owner.groupId,
          deviceId: owner.authenticated.device.id,
          capturedAt,
          samples: [sample],
        }),
        measurements.record({
          groupId: owner.groupId,
          deviceId: owner.authenticated.device.id,
          capturedAt,
          samples: [sample],
        }),
      ]);

      expect([first.sequence, second.sequence].sort()).toEqual([1n, 2n]);
      const counted = await database.query<{ snapshots: number; samples: number; last: string }>({
        text: `SELECT
                 (SELECT count(*)::int FROM telemetry_snapshots WHERE group_id = $1) AS snapshots,
                 (SELECT count(*)::int FROM telemetry_samples WHERE group_id = $1) AS samples,
                 (SELECT last_sequence::text FROM telemetry_sample_sequences WHERE group_id = $1)
                   AS last`,
        values: [owner.groupId],
      });
      expect(counted[0]).toEqual({ snapshots: 2, samples: 2, last: '2' });
    },
    networkTimeoutMs,
  );

  it(
    'resumes a stream from the sequence it names, in order and without repeats',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const publishedAt = new Date('2026-08-29T09:00:00.000Z');
      const measurements = createMeasurements();
      const service = createMeasuringService(runtime, {
        profileNow: () => publishedAt,
        now: () => new Date(publishedAt.getTime() + 1_000),
        measurements,
      });
      await requireMethod(service.createSimulationProfile)(
        create(telemetryV1.CreateSimulationProfileRequestSchema, {
          profile: measuredProfile(owner.groupId, `Смена ${uniqueSuffix()}`, ['cpu.total']),
        }),
        bearer(owner.accessToken),
      );
      // Three snapshots the client has partly seen already, all older than the
      // cadence so the stream's own preparation takes a fourth.
      for (let index = 0; index < 3; index += 1) {
        await measurements.record({
          groupId: owner.groupId,
          deviceId: owner.authenticated.device.id,
          capturedAt: new Date(publishedAt.getTime() - (3 - index) * 1_000),
          samples: [
            { sourceKey: 'cpu.total', value: index, unit: '%', severity: 'NORMAL', labels: {} },
          ],
        });
      }

      const controller = new AbortController();
      const stream = requireMethod(service.streamTelemetry)(
        create(telemetryV1.StreamTelemetryRequestSchema, {
          afterSequence: 1n,
          intervalMs: 60_000,
        }),
        bearer(owner.accessToken, controller.signal),
      ) as AsyncIterable<telemetryV1.StreamTelemetryResponse>;

      const delivered: bigint[] = [];
      for await (const response of stream) {
        delivered.push(response.snapshot?.sequence ?? 0n);
        if (delivered.length === 3) break;
      }
      controller.abort();

      // Sequence 1 was already seen and is not repeated; the capture the
      // preparation took arrives in sequence order behind the backlog rather
      // than ahead of what the client has not seen.
      expect(delivered).toEqual([2n, 3n, 4n]);
    },
    networkTimeoutMs,
  );

  it(
    'reads nothing further once the consumer stops taking snapshots',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const publishedAt = new Date('2026-08-29T09:00:00.000Z');
      const counting = new CountingSqlClient(database);
      const measurements = new DurableTelemetryMeasurementStore({ database: counting });
      const service = createMeasuringService(runtime, {
        profileNow: () => publishedAt,
        now: () => new Date(publishedAt.getTime() + 1_000),
        measurements,
      });
      await requireMethod(service.createSimulationProfile)(
        create(telemetryV1.CreateSimulationProfileRequestSchema, {
          profile: measuredProfile(owner.groupId, `Смена ${uniqueSuffix()}`, ['cpu.total']),
        }),
        bearer(owner.accessToken),
      );
      for (let index = 0; index < 4; index += 1) {
        await measurements.record({
          groupId: owner.groupId,
          deviceId: owner.authenticated.device.id,
          capturedAt: new Date(publishedAt.getTime() - (4 - index) * 1_000),
          samples: [
            { sourceKey: 'cpu.total', value: index, unit: '%', severity: 'NORMAL', labels: {} },
          ],
        });
      }

      const controller = new AbortController();
      const stream = requireMethod(service.streamTelemetry)(
        create(telemetryV1.StreamTelemetryRequestSchema, {
          afterSequence: 0n,
          intervalMs: 60_000,
        }),
        bearer(owner.accessToken, controller.signal),
      ) as AsyncIterable<telemetryV1.StreamTelemetryResponse>;

      let taken = 0;
      let queriesAtStop = 0;
      for await (const response of stream) {
        taken += 1;
        expect(response.snapshot?.sequence).toBe(BigInt(taken));
        if (taken === 2) {
          queriesAtStop = counting.count;
          break;
        }
      }
      controller.abort();

      // Five snapshots were waiting and two were taken. A generator that read
      // ahead of its consumer would have issued another statement by now; this
      // one suspends at every `yield`, which is the whole of the backpressure.
      expect(taken).toBe(2);
      expect(counting.count).toBe(queriesAtStop);
    },
    networkTimeoutMs,
  );

  it(
    'refuses a snapshot for a group that has declared no data source',
    async () => {
      const runtime = createRuntime();
      const service = createMeasuringService(runtime);
      const owner = await bootstrapGroup(runtime);

      // An empty success here would let a client draw a healthy wall for a
      // shoot nothing is measuring, so the answer names what is missing.
      await expect(
        requireMethod(service.getTelemetrySnapshot)(
          create(telemetryV1.GetTelemetrySnapshotRequestSchema, {}),
          bearer(owner.accessToken),
        ),
      ).rejects.toMatchObject({ name: 'ConnectError' });
    },
    networkTimeoutMs,
  );

  it(
    'keeps only the retained snapshots and takes their samples with them',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const measurements = createMeasurements(2);
      for (let index = 0; index < 4; index += 1) {
        await measurements.record({
          groupId: owner.groupId,
          deviceId: owner.authenticated.device.id,
          capturedAt: new Date(`2026-08-29T09:0${index.toString()}:00.000Z`),
          samples: [
            { sourceKey: 'cpu.total', value: index, unit: '%', severity: 'NORMAL', labels: {} },
          ],
        });
      }

      const remaining = await database.query<{ sequence: string }>({
        text: `SELECT sequence::text AS sequence
               FROM telemetry_snapshots
               WHERE group_id = $1
               ORDER BY sequence`,
        values: [owner.groupId],
      });
      expect(remaining.map((row) => row.sequence)).toEqual(['3', '4']);
      // The samples go with the snapshot because the composite foreign key
      // cascades, not because a second statement remembered to remove them.
      const orphans = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM telemetry_samples WHERE group_id = $1 AND sequence < 3',
        values: [owner.groupId],
      });
      expect(orphans[0]?.n).toBe(0);
    },
    networkTimeoutMs,
  );

  it(
    'takes a group’s registry, snapshots and samples away with the group',
    async () => {
      const runtime = createRuntime();
      const service = createMeasuringService(runtime);
      const owner = await bootstrapGroup(runtime);
      await requireMethod(service.createSimulationProfile)(
        create(telemetryV1.CreateSimulationProfileRequestSchema, {
          profile: measuredProfile(owner.groupId, `Смена ${uniqueSuffix()}`, ['cpu.total']),
        }),
        bearer(owner.accessToken),
      );
      await requireMethod(service.getTelemetrySnapshot)(
        create(telemetryV1.GetTelemetrySnapshotRequestSchema, {}),
        bearer(owner.accessToken),
      );

      await database.query({ text: 'DELETE FROM groups WHERE id = $1', values: [owner.groupId] });

      const left = await database.query<{
        sources: number;
        snapshots: number;
        samples: number;
        sequences: number;
      }>({
        text: `SELECT
                 (SELECT count(*)::int FROM telemetry_sources WHERE group_id = $1) AS sources,
                 (SELECT count(*)::int FROM telemetry_snapshots WHERE group_id = $1) AS snapshots,
                 (SELECT count(*)::int FROM telemetry_samples WHERE group_id = $1) AS samples,
                 (SELECT count(*)::int FROM telemetry_sample_sequences WHERE group_id = $1)
                   AS sequences`,
        values: [owner.groupId],
      });
      expect(left[0]).toEqual({ sources: 0, snapshots: 0, samples: 0, sequences: 0 });
    },
    networkTimeoutMs,
  );

  function createMeasurements(retainedSnapshots?: number): DurableTelemetryMeasurementStore {
    return new DurableTelemetryMeasurementStore({
      database,
      ...(retainedSnapshots === undefined ? {} : { retainedSnapshots }),
    });
  }

  /**
   * The service with both halves wired, and with both clocks under the test's
   * control: the profile's `updated_at` is the timeline's origin and the
   * service's `now` is where on that timeline a reading is taken, so a test
   * that could not set them apart could not assert a phase at all.
   */
  function createMeasuringService(
    runtime: DurablePairedDeviceRuntime,
    options: {
      readonly profileNow?: () => Date;
      readonly now?: () => Date;
      readonly measurements?: DurableTelemetryMeasurementStore;
    } = {},
  ): ReturnType<typeof createTelemetryService> {
    return createTelemetryService({
      runtime,
      profiles: new DurableSimulationProfileStore({
        database,
        receipts: runtime.receiptGuard,
        ...(options.profileNow === undefined ? {} : { now: options.profileNow }),
      }),
      measurements: options.measurements ?? createMeasurements(),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  function registeredSources(groupId: string): Promise<readonly Record<string, unknown>[]> {
    return database.query({
      text: `SELECT source_key, kind, unit
             FROM telemetry_sources
             WHERE group_id = $1
             ORDER BY source_key`,
      values: [groupId],
    });
  }

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

/**
 * A profile whose channels declare the named data sources.
 *
 * Every channel carries the same curve and seed, so the arithmetic is the one
 * `measuredChannel` below describes and a test can compute what a reading must
 * be through `@gremuchaya/domain` rather than through this module's own copy of
 * the formula.
 */
function measuredProfile(
  groupId: string,
  name: string,
  sourceKeys: readonly string[],
  options: { readonly id?: string } = {},
): telemetryV1.SimulationProfile {
  return create(telemetryV1.SimulationProfileSchema, {
    ...(options.id === undefined ? {} : { id: { value: options.id } }),
    groupId: { value: groupId },
    name,
    presetKind: telemetryV1.SimulationPresetKind.CPU_OVERLOAD,
    periodSeconds: 120,
    updateIntervalMs: 250,
    timeScale: 2,
    channels: sourceKeys.map((sourceKey) => ({
      sourceId: { value: sourceKey },
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
    })),
  });
}

/** The channel above as the shared arithmetic sees it, after the enum mapping. */
const measuredChannel: SimulationChannelLike = {
  minimum: 0,
  maximum: 100,
  noise: 0.05,
  smoothing: 0.4,
  seed: 42n,
  valueCurve: {
    interpolation: 'hermite',
    loop: true,
    points: [
      { time: 0, value: 12, inTangent: 0, outTangent: 40 },
      { time: 1, value: 96, inTangent: 10, outTangent: 0 },
    ],
  },
  criticalityCurve: {
    interpolation: 'linear',
    loop: false,
    points: [
      { time: 0, value: 0.1, inTangent: 0, outTangent: 0 },
      { time: 1, value: 0.9, inTangent: 0, outTangent: 0 },
    ],
  },
};

function expectedSeverity(severity: TelemetrySeverityKind): telemetryV1.TelemetrySeverity {
  switch (severity) {
    case 'normal':
      return telemetryV1.TelemetrySeverity.NORMAL;
    case 'elevated':
      return telemetryV1.TelemetrySeverity.ELEVATED;
    case 'degraded':
      return telemetryV1.TelemetrySeverity.DEGRADED;
    case 'critical':
      return telemetryV1.TelemetrySeverity.CRITICAL;
  }
}

/**
 * A live client that counts the statements issued through it.
 *
 * It is the only way to observe backpressure from outside: a generator that
 * read ahead of its consumer would show up here as statements issued after the
 * consumer stopped pulling, and nothing about the rows it returned would.
 */
class CountingSqlClient implements SqlClient {
  count = 0;

  constructor(private readonly inner: SqlClient) {}

  query<Row extends Record<string, unknown>>(statement: SqlStatement): Promise<readonly Row[]> {
    this.count += 1;
    return this.inner.query<Row>(statement);
  }

  transaction(statements: readonly SqlStatement[]): Promise<SqlTransactionResults | void> {
    this.count += 1;
    return this.inner.transaction(statements);
  }
}

function bearer(accessToken: string, signal?: AbortSignal): HandlerContext {
  return {
    requestHeader: new Headers({ authorization: `Bearer ${accessToken}` }),
    // A streaming handler reads the signal on every turn of its loop, so a
    // context without one would make every stream test a leak.
    signal: signal ?? new AbortController().signal,
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
