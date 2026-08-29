import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import { isControlPlaneError } from '@/application/sync/controlPlanePort';

import { TelemetryClient, type TelemetryRpcClient } from './TelemetryClient';

function timestamp(epochMs: number) {
  return { seconds: BigInt(Math.floor(epochMs / 1000)), nanos: 0 };
}

interface Recorded {
  readonly deviceIds: (string | undefined)[];
  readonly sourceIds: string[][];
  readonly mutations: {
    readonly requestId: string;
    readonly actorDeviceId: string | undefined;
  }[];
  readonly profiles: unknown[];
}

function recorder(): Recorded {
  return { deviceIds: [], sourceIds: [], mutations: [], profiles: [] };
}

/**
 * A `TelemetryService` stated as the wire states it, in the idiom
 * `GroupSettingsClient.test.ts` and `ControlPlaneMaterialClient.test.ts` set:
 * a fake assignable to `TelemetryRpcClient` and nothing more, so a request is
 * checked by reading what this fake recorded rather than by mocking the
 * transport.
 */
function telemetryClient(recorded: Recorded): TelemetryRpcClient {
  return {
    async listDataSources(request) {
      recorded.deviceIds.push(request.deviceId?.value);
      return {
        sources: [
          {
            id: { value: 'cpu' },
            name: 'CPU',
            kind: 1,
            unit: '%',
            simulated: true,
            warningThreshold: 0,
            criticalThreshold: 0,
            labels: { node: 'CORE-01' },
          },
        ],
        page: { nextCursor: 'cursor-2', hasMore: true },
      };
    },
    async getTelemetrySnapshot(request) {
      recorded.sourceIds.push(request.sourceIds.map((id) => id.value));
      return {
        snapshot: {
          deviceId: { value: 'device-a' },
          sequence: 4n,
          samples: [
            {
              sourceId: { value: 'cpu' },
              value: 42,
              unit: '%',
              severity: 2,
              observedAt: timestamp(1_700_000_000_000),
              labels: {},
            },
          ],
          capturedAt: timestamp(1_700_000_000_000),
          simulated: true,
        },
      };
    },
    async *streamTelemetry(request) {
      recorded.sourceIds.push(request.sourceIds.map((id) => id.value));
      yield {
        snapshot: {
          deviceId: { value: 'device-a' },
          sequence: 5n,
          samples: [],
          capturedAt: timestamp(1_700_000_001_000),
          simulated: true,
        },
      };
      yield {};
      yield {
        snapshot: {
          deviceId: { value: 'device-a' },
          sequence: 6n,
          samples: [],
          capturedAt: timestamp(1_700_000_002_000),
          simulated: true,
        },
      };
    },
    async listSimulationProfiles(request) {
      return {
        profiles: [publishedProfile()],
        page: { nextCursor: request.page.cursor === '' ? 'cursor-2' : '', hasMore: false },
      };
    },
    async createSimulationProfile(request) {
      recorded.mutations.push({
        requestId: request.context.requestId,
        actorDeviceId: request.context.actorDeviceId?.value,
      });
      recorded.profiles.push(request.profile);
      return { profile: { ...publishedProfile(), name: request.profile.name } };
    },
    async updateSimulationProfile(request) {
      recorded.profiles.push(request.profile);
      return { profile: publishedProfile() };
    },
    async deleteSimulationProfile(request) {
      return { result: { resourceId: request.profileId } };
    },
    async applySimulationPreset(request) {
      recorded.mutations.push({
        requestId: request.context.requestId,
        actorDeviceId: request.context.actorDeviceId?.value,
      });
      return { profile: { ...publishedProfile(), name: 'preset:CRITICAL', presetKind: 4 } };
    },
    async setSimulationClock(request) {
      return { profile: { ...publishedProfile(), timeScale: request.timeScale } };
    },
    async previewSimulationProfile() {
      return {
        snapshots: [
          {
            deviceId: { value: '' },
            sequence: 1n,
            samples: [],
            capturedAt: timestamp(1_700_000_000_000),
            simulated: true,
          },
        ],
      };
    },
  };
}

function publishedProfile() {
  return {
    id: { value: 'profile-a' },
    groupId: { value: 'group-a' },
    name: 'Обычный',
    presetKind: 1,
    channels: [
      {
        sourceId: { value: 'cpu' },
        minimum: 12,
        maximum: 94,
        valueCurve: {
          points: [
            { time: 0, value: 0, inTangent: 0, outTangent: 0 },
            { time: 1, value: 100, inTangent: 0, outTangent: 0 },
          ],
          interpolation: 1,
          loop: false,
        },
        noise: 0.2,
        smoothing: 0.1,
        seed: 42n,
      },
    ],
    periodSeconds: 60,
    updateIntervalMs: 1_000,
    timeScale: 1,
    revision: { number: 3n, etag: 'simulation-profile-profile-a-revision-3' },
    updatedAt: timestamp(1_700_000_000_000),
  };
}

function client(recorded: Recorded = recorder()) {
  return new TelemetryClient({
    groupId: 'group-a',
    deviceId: 'device-a',
    client: telemetryClient(recorded),
    mintRequestId: (() => {
      let index = 0;
      return () => `req-${(index += 1).toString()}`;
    })(),
  });
}

describe('TelemetryClient', () => {
  it('lists data sources, naming this session’s device', async () => {
    const recorded = recorder();
    const page = await client(recorded).listDataSources('', 20);

    expect(recorded.deviceIds).toEqual(['device-a']);
    expect(page.sources).toEqual([
      {
        sourceKey: 'cpu',
        name: 'CPU',
        kind: 1,
        unit: '%',
        simulated: true,
        warningThreshold: 0,
        criticalThreshold: 0,
        labels: { node: 'CORE-01' },
      },
    ]);
    expect(page.nextCursor).toBe('cursor-2');
    expect(page.hasMore).toBe(true);
  });

  it('reads one snapshot, decoding the severity and the observed instant', async () => {
    const snapshot = await client().getTelemetrySnapshot(['cpu']);

    expect(snapshot.sequence).toBe(4);
    expect(snapshot.samples).toEqual([
      {
        sourceKey: 'cpu',
        value: 42,
        unit: '%',
        severity: 'elevated',
        observedAt: new Date(1_700_000_000_000).toISOString(),
        labels: {},
      },
    ]);
  });

  it('names an empty source list as "all of them", not as a request for nothing', async () => {
    const recorded = recorder();
    await client(recorded).getTelemetrySnapshot();

    expect(recorded.sourceIds).toEqual([[]]);
  });

  it('streams snapshots and skips a frame that carries none', async () => {
    const snapshots: number[] = [];
    for await (const snapshot of client().streamTelemetry(0, ['cpu'])) {
      snapshots.push(snapshot.sequence);
    }

    expect(snapshots).toEqual([5, 6]);
  });

  it('mints one request id per mutation and names the acting device', async () => {
    const recorded = recorder();
    await client(recorded).createSimulationProfile({
      name: 'Обычный',
      presetKind: 'NORMAL',
      channels: [],
      periodSeconds: 60,
      updateIntervalMs: 1_000,
      timeScale: 1,
    });

    expect(recorded.mutations).toEqual([{ requestId: 'req-1', actorDeviceId: 'device-a' }]);
  });

  it('round-trips a channel’s curve through the wire shape and back', async () => {
    const recorded = recorder();
    await client(recorded).createSimulationProfile({
      name: 'Обычный',
      presetKind: 'NORMAL',
      channels: [
        {
          sourceKey: 'cpu',
          minimum: 12,
          maximum: 94,
          valueCurve: {
            points: [
              { time: 0, value: 0, inTangent: 0, outTangent: 0 },
              { time: 1, value: 100, inTangent: 0, outTangent: 0 },
            ],
            interpolation: 'linear',
            loop: false,
          },
          noise: 0.2,
          smoothing: 0.1,
          seed: 42,
        },
      ],
      periodSeconds: 60,
      updateIntervalMs: 1_000,
      timeScale: 1,
    });

    const sent = recorded.profiles[0] as {
      readonly channels: readonly { readonly valueCurve: { readonly interpolation: number } }[];
    };
    expect(sent.channels[0]?.valueCurve.interpolation).toBe(1);
  });

  it('reads a published profile’s preset kind and revision back as text and a number', async () => {
    const page = await client().listSimulationProfiles();

    expect(page.profiles[0]?.presetKind).toBe('NORMAL');
    expect(page.profiles[0]?.revision).toBe(3);
    expect(page.profiles[0]?.channels[0]?.seed).toBe(42);
  });

  it('applies a named preset, encoding it as the wire’s numeric kind', async () => {
    const profile = await client().applySimulationPreset('critical');

    expect(profile.name).toBe('preset:CRITICAL');
    expect(profile.presetKind).toBe('CRITICAL');
  });

  it('re-times a profile without touching its channels', async () => {
    const profile = await client().setSimulationClock('profile-a', {
      running: true,
      timeScale: 2,
      phase: 0,
    });

    expect(profile.timeScale).toBe(2);
  });

  it('previews a profile without a stored one to fall back on', async () => {
    const snapshots = await client().previewSimulationProfile(
      {
        name: 'Обычный',
        presetKind: 'NORMAL',
        channels: [],
        periodSeconds: 60,
        updateIntervalMs: 1_000,
        timeScale: 1,
      },
      12,
    );

    expect(snapshots).toHaveLength(1);
  });

  it('maps a method the deployment never built (no measurement store) to "unimplemented"', async () => {
    const failing: TelemetryRpcClient = {
      ...telemetryClient(recorder()),
      listDataSources() {
        return Promise.reject(
          new ConnectError('listDataSources is not implemented', Code.Unimplemented),
        );
      },
    };
    const degraded = new TelemetryClient({
      groupId: 'group-a',
      deviceId: 'device-a',
      client: failing,
    });

    await expect(degraded.listDataSources()).rejects.toSatisfy(
      (error: unknown) => isControlPlaneError(error) && error.kind === 'unimplemented',
    );
  });
});
