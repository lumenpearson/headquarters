// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeOperationsClient, operationsStore } from './operationsStore';

const persistedStateKey = 'gremuchaya-hq:operations:v3';
const snapshotStateKey = 'gremuchaya-hq:production-snapshots:v3';

type WorldMessage = Record<string, unknown>;

/**
 * A stand-in for the world channel that both records what this session posts
 * and hands back the receiving end, so the branch that applies another
 * session's world can be driven directly. `BroadcastChannel` delivers to every
 * *other* context, never to the sender, which is why the receiving side had no
 * test at all until this one.
 */
function installChannel(): {
  readonly posted: readonly WorldMessage[];
  readonly deliver: (message: WorldMessage) => void;
  readonly restore: () => void;
} {
  const posted: WorldMessage[] = [];
  let receiver: ((event: MessageEvent<unknown>) => void) | null = null;
  class RecordingChannel {
    set onmessage(handler: ((event: MessageEvent<unknown>) => void) | null) {
      receiver = handler;
    }
    constructor(readonly name: string) {}
    postMessage(message: unknown): void {
      posted.push(message as WorldMessage);
    }
    close(): void {}
  }
  const original = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = RecordingChannel as unknown as typeof BroadcastChannel;
  return {
    posted,
    // Structured-cloned on the wire, so the peer's message is never the
    // sender's own object graph.
    deliver: (message) =>
      receiver?.({ data: JSON.parse(JSON.stringify(message)) } as MessageEvent<unknown>),
    restore: () => {
      globalThis.BroadcastChannel = original;
    },
  };
}

describe('initializeOperationsClient', () => {
  let dispose: () => void = () => undefined;

  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
    operationsStore.setState((state) => ({
      production: { ...state.production, snapshots: [] },
    }));
  });

  afterEach(() => {
    dispose();
    dispose = () => undefined;
  });

  it('keeps personalization out of what one session broadcasts to the others', () => {
    const posted: unknown[] = [];
    class RecordingChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      constructor(readonly name: string) {}
      postMessage(message: unknown): void {
        posted.push(message);
      }
      close(): void {}
    }
    const original = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = RecordingChannel as unknown as typeof BroadcastChannel;
    try {
      dispose = initializeOperationsClient();
      operationsStore.getState().applySettingsPatch([{ id: 'themes.id', value: 'amber-crt' }]);
    } finally {
      globalThis.BroadcastChannel = original;
    }

    expect(posted.length).toBeGreaterThan(0);
    // `advanced.liveEdit` is the opt-in that decides whether a settings change
    // reaches the other sessions, and it defaults to off. The world snapshot
    // carried the whole personalization state on every store change, so the
    // opt-in governed nothing and every same-origin session followed a theme
    // change immediately.
    for (const message of posted) {
      expect(Object.keys(message as Record<string, unknown>)).not.toContain('personalization');
    }
    // The change is still persisted: storage is what makes a preference outlive
    // a restart, and that is not what the opt-in is about.
    const stored = JSON.parse(localStorage.getItem(persistedStateKey) ?? '{}') as {
      personalization?: { draft?: { values?: Record<string, unknown> } };
    };
    expect(stored.personalization?.draft?.values?.['themes.id']).toBe('amber-crt');
  });

  it('clears the snapshot key it could not read, not the state key', () => {
    localStorage.setItem(persistedStateKey, JSON.stringify({ version: 5 }));
    localStorage.setItem(snapshotStateKey, 'not json');

    dispose = initializeOperationsClient();

    // One shared catch used to remove `persistedStateKey`, so the corrupt
    // snapshot blob survived and threw again on every reload.
    expect(localStorage.getItem(snapshotStateKey)).toBeNull();
    expect(localStorage.getItem(persistedStateKey)).not.toBeNull();
  });

  it('refuses a snapshot list whose entries are not snapshots', () => {
    localStorage.setItem(snapshotStateKey, JSON.stringify([{ id: 'SNAP-1' }, 42]));

    dispose = initializeOperationsClient();

    expect(operationsStore.getState().production.snapshots).toEqual([]);
  });

  it('restores a well-formed snapshot list', () => {
    const snapshot = {
      id: 'SNAP-1',
      name: 'rehearsal',
      createdAt: '2026-08-21T10:00:00.000Z',
      route: 'overview',
      selectedObjectId: 'K-22',
      selectedCameraId: 'CAM-04',
      selectedCaseId: 'CASE-08',
      mapCenter: [55.75, 37.61],
      mapZoom: 12,
      mapLayers: operationsStore.getState().ui.mapLayers,
      activeAlertIds: [],
      preset: 'DEFAULT',
      simulationPaused: false,
      fixedTime: '12:00:00',
    };
    localStorage.setItem(snapshotStateKey, JSON.stringify([snapshot]));

    dispose = initializeOperationsClient();

    expect(operationsStore.getState().production.snapshots.map((entry) => entry.id)).toEqual([
      'SNAP-1',
    ]);
  });

  it('brings content edits back over the seed on the next launch', () => {
    dispose = initializeOperationsClient();
    operationsStore
      .getState()
      .applyContentPatch([{ id: 'case.title', entityId: 'CASE-03', value: 'МАРШРУТ / ПРОВЕРЕНО' }]);
    dispose();
    dispose = () => undefined;

    // A fresh session starts from the seed and reads the blob.
    operationsStore.getState().resetWorld();
    expect(operationsStore.getState().cases['CASE-03']?.title).not.toBe('МАРШРУТ / ПРОВЕРЕНО');
    dispose = initializeOperationsClient();

    expect(operationsStore.getState().cases['CASE-03']?.title).toBe('МАРШРУТ / ПРОВЕРЕНО');
    expect(operationsStore.getState().content.overrides).toEqual({
      'case.title@CASE-03': 'МАРШРУТ / ПРОВЕРЕНО',
    });
  });

  it('keeps this session content edits when a peer says nothing about content', () => {
    const channel = installChannel();
    try {
      dispose = initializeOperationsClient();
      operationsStore
        .getState()
        .applyContentPatch([
          { id: 'case.title', entityId: 'CASE-03', value: 'МАРШРУТ / ПРОВЕРЕНО' },
        ]);
      const world = channel.posted.at(-1);
      expect(world?.['content']).toBeDefined();

      // A session on a build from before R4 broadcasts no `content` member.
      const { content: _content, ...withoutContent } = world ?? {};
      channel.deliver(withoutContent);
    } finally {
      channel.restore();
    }

    // Absent is not empty. The peer said nothing about content, so this
    // session keeps its own -- the reading `audit` already gets.
    expect(operationsStore.getState().content.overrides).toEqual({
      'case.title@CASE-03': 'МАРШРУТ / ПРОВЕРЕНО',
    });
    expect(operationsStore.getState().cases['CASE-03']?.title).toBe('МАРШРУТ / ПРОВЕРЕНО');
    // The receive path writes through the same subscriber as every other
    // change, so an erasure here was an erasure on disk on the next launch.
    const stored = JSON.parse(localStorage.getItem(persistedStateKey) ?? '{}') as {
      content?: { overrides?: Record<string, unknown> };
    };
    expect(stored.content?.overrides).toEqual({ 'case.title@CASE-03': 'МАРШРУТ / ПРОВЕРЕНО' });
  });

  it('clears content when a peer states it has none, and adopts the overrides it does send', () => {
    const channel = installChannel();
    const seedTitle = operationsStore.getState().cases['CASE-03']?.title;
    try {
      dispose = initializeOperationsClient();
      operationsStore
        .getState()
        .applyContentPatch([
          { id: 'case.title', entityId: 'CASE-03', value: 'МАРШРУТ / ПРОВЕРЕНО' },
        ]);
      const world = channel.posted.at(-1) ?? {};

      // A peer that reset its content said so, and a statement still clears.
      channel.deliver({ ...world, content: { overrides: {} } });
      expect(operationsStore.getState().content.overrides).toEqual({});
      expect(operationsStore.getState().cases['CASE-03']?.title).toBe(seedTitle);

      channel.deliver({
        ...world,
        content: { overrides: { 'case.title@CASE-03': 'МАРШРУТ / СОСЕД' } },
      });
    } finally {
      channel.restore();
    }

    expect(operationsStore.getState().content.overrides).toEqual({
      'case.title@CASE-03': 'МАРШРУТ / СОСЕД',
    });
    expect(operationsStore.getState().cases['CASE-03']?.title).toBe('МАРШРУТ / СОСЕД');
  });

  it('drops a stored content override it cannot validate and keeps the rest', () => {
    const state = operationsStore.getState();
    const { snapshots: _snapshots, ...production } = state.production;
    localStorage.setItem(
      persistedStateKey,
      JSON.stringify({
        version: 5,
        ui: state.ui,
        production,
        personalization: state.personalization,
        content: {
          overrides: {
            'case.createdAt@CASE-01': '2026-02-30',
            'case.title@CASE-99': 'НЕТ ТАКОГО ДЕЛА',
            'case.title@CASE-01': 'ДЕЛО / ПРОВЕРЕНО',
          },
        },
      }),
    );
    const seedCreatedAt = state.cases['CASE-01']?.createdAt;

    dispose = initializeOperationsClient();

    // The blob is a trust boundary: a value the field refuses never reaches
    // the world, and an entity the seed lacks has nothing to project onto.
    expect(operationsStore.getState().content.overrides).toEqual({
      'case.title@CASE-01': 'ДЕЛО / ПРОВЕРЕНО',
    });
    expect(operationsStore.getState().cases['CASE-01']?.createdAt).toBe(seedCreatedAt);
    expect(operationsStore.getState().cases['CASE-01']?.title).toBe('ДЕЛО / ПРОВЕРЕНО');
  });
});
