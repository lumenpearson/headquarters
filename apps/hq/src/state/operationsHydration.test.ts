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

  /*
   * R4 tail (corrections register): undo, redo and restore replay the whole
   * content-overrides record out of this session's own ledger, and a peer's
   * edit used to reach the world through `advanced.worldSync` without ever
   * entering that ledger -- so a local undo right after had nothing of the
   * neighbor's edit to pop and reached past it into this session's own
   * history, discarding the neighbor's edit outright. The peer's move is now
   * its own reversible entry, so undo reverts specifically it.
   */
  it('records a peer world-sync content edit in the local ledger, so undo reverts specifically it', () => {
    const channel = installChannel();
    const seedTitle = operationsStore.getState().cases['CASE-03']?.title;
    try {
      dispose = initializeOperationsClient();
      operationsStore
        .getState()
        .applyContentPatch([{ id: 'case.title', entityId: 'CASE-04', value: 'МЕСТНОЕ ИЗМЕНЕНИЕ' }]);
      const world = channel.posted.at(-1) ?? {};

      channel.deliver({
        ...world,
        content: {
          overrides: {
            'case.title@CASE-04': 'МЕСТНОЕ ИЗМЕНЕНИЕ',
            'case.title@CASE-03': 'МАРШРУТ / СОСЕД',
          },
        },
      });
      expect(operationsStore.getState().cases['CASE-03']?.title).toBe('МАРШРУТ / СОСЕД');

      operationsStore.getState().undoSettingsDraft();
    } finally {
      channel.restore();
    }

    // The neighbor's edit is undone -- it landed last -- and the local edit
    // that preceded it survives untouched.
    expect(operationsStore.getState().cases['CASE-03']?.title).toBe(seedTitle);
    expect(operationsStore.getState().cases['CASE-04']?.title).toBe('МЕСТНОЕ ИЗМЕНЕНИЕ');
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

  /*
   * `startup.restoreWorld` names what the simulation did -- alerts, tasks, the
   * audit trail -- and the store says in as many words that a content edit is
   * not one of those and comes back whatever the setting says. Both settings
   * are run, because "regardless" is a claim about two answers and a case that
   * only ever asks one of them cannot make it.
   *
   * The setting is seeded to `false` in the first case, which is not its
   * default (`true`): a case seeded with the default passes against a build
   * where the setting was deleted, and proves nothing about it (C51).
   */
  for (const restoreWorld of [false, true]) {
    it(`brings content edits back with startup.restoreWorld ${restoreWorld}`, () => {
      const state = operationsStore.getState();
      const { snapshots: _snapshots, ...production } = state.production;
      const alertId = Object.keys(state.alerts)[0];
      const seededAlert = alertId === undefined ? undefined : state.alerts[alertId];
      if (alertId === undefined || seededAlert === undefined) {
        throw new Error('the seed has no alert to restore');
      }
      // A lifecycle the seed does not hold for this alert, so "the blob won"
      // and "the seed won" are two readings this case can tell apart.
      const storedLifecycle = seededAlert.lifecycle === 'RESOLVED' ? 'NEW' : 'RESOLVED';
      const seedTitle = operationsStore.getState().cases['CASE-05']?.title;
      localStorage.setItem(
        persistedStateKey,
        JSON.stringify({
          version: 5,
          ui: state.ui,
          production,
          alerts: { ...state.alerts, [alertId]: { ...seededAlert, lifecycle: storedLifecycle } },
          tasks: state.tasks,
          personalization: {
            ...state.personalization,
            draft: {
              ...state.personalization.draft,
              values: {
                ...state.personalization.draft.values,
                'startup.restoreWorld': restoreWorld,
              },
            },
          },
          content: { overrides: { 'case.title@CASE-05': 'ДЕЛО / ВОССТАНОВЛЕНО' } },
        }),
      );

      dispose = initializeOperationsClient();

      // The promise itself: the correction the operator made is on the screen
      // again, on both answers.
      expect(operationsStore.getState().cases['CASE-05']?.title).toBe('ДЕЛО / ВОССТАНОВЛЕНО');
      expect(operationsStore.getState().content.overrides).toEqual({
        'case.title@CASE-05': 'ДЕЛО / ВОССТАНОВЛЕНО',
      });
      expect(seedTitle).not.toBe('ДЕЛО / ВОССТАНОВЛЕНО');
      // And the setting was read, so the first case is not passing because
      // everything comes back: what it governs followed it.
      expect(operationsStore.getState().alerts[alertId]?.lifecycle).toBe(
        restoreWorld ? storedLifecycle : seededAlert.lifecycle,
      );
    });
  }

  /*
   * `startupComplete` gates the first-launch keybind intro (R11) off the boot
   * readout. It is process-scoped like `productionPanelOpen`/`drawer`: a
   * second launch that restores everything else must still play its own
   * startup sequence and gate its own intro, not resume with last session's
   * "already finished".
   */
  it('resets startupComplete on hydrate even when the stored blob says it finished', () => {
    const state = operationsStore.getState();
    const { snapshots: _snapshots, ...production } = state.production;
    localStorage.setItem(
      persistedStateKey,
      JSON.stringify({
        version: 5,
        // `globalFilter` rides in the same `ui` merge as `startupComplete` --
        // a neighbouring field with no special-cased reset, distinct from its
        // own default ('all'). Asserting it below proves the blob's `ui` was
        // actually merged rather than the whole hydrate call being a no-op
        // that happens to leave `startupComplete` at its own default of
        // `false` regardless of what this test does.
        ui: { ...state.ui, startupComplete: true, globalFilter: 'flagged' },
        production,
        personalization: state.personalization,
      }),
    );

    dispose = initializeOperationsClient();

    expect(operationsStore.getState().ui.startupComplete).toBe(false);
    expect(operationsStore.getState().ui.globalFilter).toBe('flagged');
  });

  it('keeps this session startupComplete local when a peer says it already finished', () => {
    const channel = installChannel();
    try {
      dispose = initializeOperationsClient();
      expect(operationsStore.getState().ui.startupComplete).toBe(false);

      // A harmless local change to obtain a real world snapshot in the shape
      // the broadcast handler expects, the same way the content-sync cases
      // above do.
      operationsStore.getState().setGlobalFilter('all');
      const world = channel.posted.at(-1) ?? {};
      channel.deliver({
        ...world,
        // `searchQuery` rides in `remoteUi` next to `startupComplete`, at a
        // value distinct from this session's own default (''). Asserting it
        // below proves the peer's `ui` was actually applied through this
        // handler, rather than the assertion on `startupComplete` passing
        // because the handler discarded the whole message.
        ui: { ...operationsStore.getState().ui, startupComplete: true, searchQuery: 'peer-marker' },
      });
    } finally {
      channel.restore();
    }

    expect(operationsStore.getState().ui.searchQuery).toBe('peer-marker');
    // The peer's own startup readout finishing is not a fact about this
    // window's; adopting it would let a sibling window silently skip the
    // gate here.
    expect(operationsStore.getState().ui.startupComplete).toBe(false);
  });
});
