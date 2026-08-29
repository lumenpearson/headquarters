import { settingsV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import { GroupSettingsClient, type SettingsRpcClient } from './GroupSettingsClient';

function timestamp(epochMs: number) {
  return { seconds: BigInt(Math.floor(epochMs / 1000)), nanos: 0 };
}

interface Recorded {
  readonly scopes: { readonly type: number; readonly resourceId: string }[];
  readonly cursors: { readonly cursor: string; readonly pageSize: number }[];
  readonly watches: { readonly afterRevision: bigint }[];
}

/**
 * A `SettingsService` stated as the wire states it.
 *
 * Two pages and then the end, which is the only way to show that the client
 * carries the server's cursor forward rather than counting rows itself: a fake
 * that answered one page could not tell a keyset read from an offset one.
 */
function settingsClient(
  recorded: Recorded,
  watchEvents: readonly (bigint | undefined)[] = [],
): SettingsRpcClient {
  const pages = [
    {
      entries: [historyEntry('11111111-1111-4111-8111-111111111111', 'APPLY_DRAFT_PATCH', 3)],
      page: { nextCursor: 'cursor-2', hasMore: true },
    },
    {
      entries: [historyEntry('22222222-2222-4222-8222-222222222222', 'RESET_ELEMENT', 2)],
      page: { nextCursor: '', hasMore: false },
    },
  ];
  return {
    async getEffectiveSettings() {
      return {
        document: {
          values: {
            'telemetry.source': { kind: { case: 'stringValue' as const, value: 'native' } },
            'advanced.liveEdit': { kind: { case: 'booleanValue' as const, value: true } },
            'advanced.historyDepth': { kind: { case: 'integerValue' as const, value: 40n } },
            'privacy.blurRadius': { kind: { case: 'numberValue' as const, value: 2.5 } },
            'navigation.hidden': {
              kind: { case: 'stringList' as const, value: { values: ['map', 'video'] } },
            },
            'diagnostics.blob': {
              kind: { case: 'binaryValue' as const, value: new Uint8Array([1, 2]) },
            },
          },
          revision: { number: 7n, etag: 'settings-7' },
          updatedAt: timestamp(1_700_000_000_000),
        },
      };
    },
    async applyDraftPatch(request) {
      recorded.scopes.push({
        type: request.scope.type,
        resourceId: request.scope.resourceId.value,
      });
      return { draft: { values: {}, revision: { number: 8n, etag: '' } } };
    },
    async publishDraft(request) {
      recorded.scopes.push({
        type: request.scope.type,
        resourceId: request.scope.resourceId.value,
      });
      return { published: { values: {}, revision: { number: 9n, etag: '' } } };
    },
    async resetElement() {
      return { document: { values: {}, revision: { number: 10n, etag: '' } } };
    },
    async listSettingsHistory(request) {
      recorded.cursors.push({
        cursor: request.page.cursor,
        pageSize: request.page.pageSize,
      });
      const page = request.page.cursor === '' ? pages[0] : pages[1];
      return page ?? { entries: [], page: { nextCursor: '', hasMore: false } };
    },
    async *watchSettings(request) {
      recorded.watches.push({ afterRevision: request.afterRevision });
      for (const sequence of watchEvents) {
        yield sequence === undefined ? {} : { event: { sequence } };
      }
    },
  };
}

function historyEntry(id: string, operation: string, revision: number) {
  return {
    id: { value: id },
    scope: {
      type: settingsV1.SettingsScopeType.GROUP,
      resourceId: { value: 'group-a' },
    },
    category: 'telemetry',
    elementId: 'telemetry.source',
    operation,
    patch: [
      {
        path: 'telemetry.source',
        value: { kind: { case: 'stringValue' as const, value: 'native' } },
        remove: false,
      },
    ],
    revision: { number: BigInt(revision), etag: '' },
    actorDeviceId: { value: 'device-b' },
    occurredAt: timestamp(1_700_000_000_000),
  };
}

function client(
  recorded: Recorded = { scopes: [], cursors: [], watches: [] },
  watchEvents: readonly (bigint | undefined)[] = [],
) {
  return new GroupSettingsClient({
    groupId: 'group-a',
    deviceId: 'device-a',
    client: settingsClient(recorded, watchEvents),
    mintRequestId: () => 'request-1',
  });
}

describe('GroupSettingsClient', () => {
  it('reads every value kind the schema can hold and drops the one it cannot', async () => {
    const document = await client().getEffectiveSettings(false);

    expect(document.revision).toBe(7);
    expect(document.values).toEqual({
      'telemetry.source': 'native',
      'advanced.liveEdit': true,
      'advanced.historyDepth': 40,
      'privacy.blurRadius': 2.5,
      'navigation.hidden': ['map', 'video'],
    });
    // `binaryValue` has no counterpart in the settings schema; inventing one
    // would be worse than the document arriving without it.
    expect(document.values['diagnostics.blob']).toBeUndefined();
  });

  it('names the group scope and this session own group on every write', async () => {
    const recorded: Recorded = { scopes: [], cursors: [], watches: [] };
    const settings = client(recorded);

    await settings.applyGroupDraftPatch([{ path: 'telemetry.source', value: 'native' }]);
    await settings.publishGroupDraft();

    expect(recorded.scopes).toEqual([
      { type: settingsV1.SettingsScopeType.GROUP, resourceId: 'group-a' },
      { type: settingsV1.SettingsScopeType.GROUP, resourceId: 'group-a' },
    ]);
  });

  it('pages the history by carrying the server cursor forward', async () => {
    const recorded: Recorded = { scopes: [], cursors: [], watches: [] };
    const settings = client(recorded);

    const first = await settings.listGroupHistory({ cursor: '', pageSize: 10 });
    expect(first.entries.map((entry) => entry.operation)).toEqual(['APPLY_DRAFT_PATCH']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe('cursor-2');

    const second = await settings.listGroupHistory({ cursor: first.nextCursor, pageSize: 10 });
    expect(second.entries.map((entry) => entry.operation)).toEqual(['RESET_ELEMENT']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBe('');

    expect(recorded.cursors).toEqual([
      { cursor: '', pageSize: 10 },
      { cursor: 'cursor-2', pageSize: 10 },
    ]);
  });

  it('keeps the server operation vocabulary and invents no total', async () => {
    const page = await client().listGroupHistory({ cursor: '', pageSize: 10 });
    const entry = page.entries[0];

    expect(entry?.operation).toBe('APPLY_DRAFT_PATCH');
    expect(entry?.changedIds).toEqual(['telemetry.source']);
    expect(entry?.actorDeviceId).toBe('device-b');
    expect(entry?.revision).toBe(3);
    // The page carries exactly what the server reports: rows, a cursor and a
    // flag. There is no `total` and no `pageCount` to read.
    expect(Object.keys(page).sort()).toEqual(['entries', 'hasMore', 'nextCursor']);
  });

  it('streams the group scope and carries the revision forward, dropping an unset event', async () => {
    const recorded: Recorded = { scopes: [], cursors: [], watches: [] };
    const settings = client(recorded, [11n, undefined, 12n]);

    const events = [];
    for await (const event of settings.watchSettings(5)) events.push(event);

    expect(recorded.watches).toEqual([{ afterRevision: 5n }]);
    expect(events).toEqual([{ revision: 11 }, { revision: 12 }]);
  });
});
