import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import {
  ControlPlaneService,
  IntegrationService,
  MaterialService,
  ResourceIdSchema,
  SettingValueSchema,
  SettingsService,
  SyncService,
  TelemetryService,
  realtimeV1,
  syncV1,
} from './index.js';

describe('versioned Protobuf contracts', () => {
  it('round-trips resource IDs and typed setting values in binary format', () => {
    const resource = create(ResourceIdSchema, {
      value: '0192f4fc-6a47-7c31-a5b6-30e2563924bd',
    });
    const decodedResource = fromBinary(ResourceIdSchema, toBinary(ResourceIdSchema, resource));
    expect(decodedResource).toEqual(resource);

    const setting = create(SettingValueSchema, {
      kind: {
        case: 'stringList',
        value: { values: ['video', 'documents', 'reports'] },
      },
    });
    const decodedSetting = fromBinary(SettingValueSchema, toBinary(SettingValueSchema, setting));
    expect(decodedSetting.kind).toEqual(setting.kind);
  });

  it('exposes the complete control-plane service surface', () => {
    expect(methodNames(ControlPlaneService)).toEqual(['GetCapabilities', 'Health']);
    expect(methodNames(MaterialService)).toEqual([
      'BeginUpload',
      'CancelUpload',
      'CompleteUpload',
      'CreateMaterialVersion',
      'GetDownloadGrant',
      'GetMaterial',
      'GetPreviewGrant',
      'GetUploadStatus',
      'ListMaterials',
      'ListTrash',
      'ListVersions',
      'MoveToTrash',
      'PurgeMaterial',
      'RestoreMaterial',
      'UpdateMaterialMetadata',
      'WatchMaterialEvents',
    ]);
    expect(methodNames(SettingsService)).toEqual([
      'ApplyDraftPatch',
      'DiscardDraft',
      'ExportSettings',
      'GetEffectiveSettings',
      'GetSettingsSchema',
      'ImportSettings',
      'ListSettingsHistory',
      'PublishDraft',
      'ResetAll',
      'ResetCategory',
      'ResetElement',
      'RevertSettingsVersion',
      'WatchSettings',
    ]);
    expect(methodNames(SyncService)).toEqual([
      'CreateGroup',
      'CreatePairingCode',
      'GetPresence',
      'JoinGroup',
      'LeaveGroup',
      'ListDevices',
      'PairDevice',
      'PublishDocumentDelta',
      'PublishSessionCommand',
      'RefreshDeviceSession',
      'RevokeDevice',
      'SetAuthorityMode',
      'SetDeviceRole',
      'SetLeader',
      'TimeSync',
      'UpdateGroup',
      'WatchGroup',
    ]);
    expect(methodNames(TelemetryService)).toEqual([
      'ApplySimulationPreset',
      'CreateSimulationProfile',
      'DeleteSimulationProfile',
      'GetTelemetrySnapshot',
      'ListDataSources',
      'ListSimulationProfiles',
      'PreviewSimulationProfile',
      'SetSimulationClock',
      'StreamTelemetry',
      'UpdateSimulationProfile',
    ]);
    expect(methodNames(IntegrationService)).toEqual([
      'BuildIssueDraft',
      'CreateIssue',
      'CreateTranslationProposal',
      'CreateTranslationPullRequest',
      'GetIntegrationStatus',
      'GetPullRequestStatus',
      'OpenPrefilledIssue',
    ]);
  });

  it('keeps opaque device sessions inside bootstrap, pairing and refresh contracts', () => {
    const session = create(syncV1.DeviceSessionSchema, {
      accessToken: 'opaque-access-token',
      refreshToken: 'opaque-refresh-token',
      deviceId: { value: 'dev_01jbxn3r8vqf12tkr6g7ndz9wq' },
      groupId: { value: 'grp_01jbxn3r8vqf12tkr6g7ndz9wq' },
      role: syncV1.DeviceRole.EDITOR,
    });

    const roundTripped = fromBinary(
      syncV1.DeviceSessionSchema,
      toBinary(syncV1.DeviceSessionSchema, session),
    );

    expect(roundTripped).toEqual(session);
    expect(SyncService.method.refreshDeviceSession.input).toBe(
      syncV1.RefreshDeviceSessionRequestSchema,
    );
    expect(SyncService.method.refreshDeviceSession.output).toBe(
      syncV1.RefreshDeviceSessionResponseSchema,
    );
    expect(SyncService.method.pairDevice.input).toBe(syncV1.PairDeviceRequestSchema);

    const pairRequest = create(syncV1.PairDeviceRequestSchema, {
      pairingCode: 'pair-code',
      deviceName: 'Secondary workstation',
      publicKey: 'ed25519:secondary',
      platform: 'windows',
      applicationVersion: '0.1.0',
      context: { requestId: 'pair-request-01', correlationId: 'corr-01' },
    });
    const refreshRequest = create(syncV1.RefreshDeviceSessionRequestSchema, {
      refreshToken: 'opaque-refresh-token',
      context: { requestId: 'refresh-request-01', correlationId: 'corr-02' },
    });

    expect(
      fromBinary(
        syncV1.PairDeviceRequestSchema,
        toBinary(syncV1.PairDeviceRequestSchema, pairRequest),
      ),
    ).toEqual(pairRequest);
    expect(
      fromBinary(
        syncV1.RefreshDeviceSessionRequestSchema,
        toBinary(syncV1.RefreshDeviceSessionRequestSchema, refreshRequest),
      ),
    ).toEqual(refreshRequest);
  });
  it('marks realtime watchers as server-streaming RPCs', () => {
    expect(MaterialService.method.watchMaterialEvents.methodKind).toBe('server_streaming');
    expect(SettingsService.method.watchSettings.methodKind).toBe('server_streaming');
    expect(SyncService.method.watchGroup.methodKind).toBe('server_streaming');
    expect(TelemetryService.method.streamTelemetry.methodKind).toBe('server_streaming');
  });

  it('round-trips binary realtime hello and server envelopes', () => {
    const clientFrame = create(realtimeV1.RealtimeClientFrameSchema, {
      payload: {
        case: 'hello',
        value: {
          groupId: { value: 'group-01' },
          deviceId: { value: 'device-01' },
          afterSequence: 42n,
          documentStateVector: new Uint8Array([1, 2, 3]),
          accessToken: 'hq_access_opaque-binary-only',
        },
      },
    });
    const serverFrame = create(realtimeV1.RealtimeServerFrameSchema, {
      payload: {
        case: 'error',
        value: { code: 'realtime.invalid_frame', message: 'Invalid binary payload.' },
      },
    });

    expect(
      fromBinary(
        realtimeV1.RealtimeClientFrameSchema,
        toBinary(realtimeV1.RealtimeClientFrameSchema, clientFrame),
      ),
    ).toEqual(clientFrame);
    expect(
      fromBinary(
        realtimeV1.RealtimeServerFrameSchema,
        toBinary(realtimeV1.RealtimeServerFrameSchema, serverFrame),
      ),
    ).toEqual(serverFrame);
  });
});

function methodNames(service: {
  readonly methods: ReadonlyArray<{ readonly name: string }>;
}): string[] {
  return service.methods.map((method) => method.name).sort();
}
