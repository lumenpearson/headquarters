import { beforeEach, describe, expect, it } from 'vitest';

import { ContentPatchError, seedContentValue } from '../application/edit/contentFields';
import { operationsSeed } from '../data/operationsSeed';
import { querySettingsHistory } from '../infrastructure/settings/SettingsHistoryLedger';
import { operationsStore } from './operationsStore';

describe('operationsStore', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.setState((state) => ({
      production: { ...state.production, snapshots: [] },
    }));
  });

  it('keeps entity selections and alerts in one shared world', () => {
    const store = operationsStore.getState();
    store.selectObject('K-22');
    store.selectCamera('CAM-04');
    store.selectCase('CASE-08');
    store.acknowledgeAlert('AL-101');

    const next = operationsStore.getState();
    expect(next.ui.selectedObjectId).toBe('K-22');
    expect(next.ui.selectedCameraId).toBe('CAM-04');
    expect(next.ui.selectedCaseId).toBe('CASE-08');
    expect(next.alerts['AL-101']?.lifecycle).toBe('ACKNOWLEDGED');
    expect(next.audit[0]?.entityId).toBe('AL-101');
  });

  it('persists tactical layer and camera controls in the shared UI state', () => {
    const store = operationsStore.getState();
    const sensorsInitiallyVisible = store.ui.mapLayers.sensors;
    store.toggleMapLayer('sensors');
    store.setMapView([34, 67], 2.4);
    store.adjustPtz('pan', 12);
    store.adjustPtz('zoom', 0.5);

    const next = operationsStore.getState();
    expect(next.ui.mapLayers.sensors).toBe(!sensorsInitiallyVisible);
    expect(next.ui.mapCenter).toEqual([34, 67]);
    expect(next.ui.mapZoom).toBe(2.4);
    expect(next.ui.ptz.pan).toBe(12);
    expect(next.ui.ptz.zoom).toBe(1.5);
  });

  it('sets playback intent explicitly without relying on an inverse toggle', () => {
    const store = operationsStore.getState();
    store.setVideoPlaying(false);
    expect(operationsStore.getState().ui.videoPlaying).toBe(false);
    operationsStore.getState().setVideoPlaying(true);
    expect(operationsStore.getState().ui.videoPlaying).toBe(true);
  });

  it('applies production presets and restores continuity snapshots', () => {
    const store = operationsStore.getState();
    store.setRoute('map');
    store.selectObject('K-17');
    store.setMapView([61, 43], 1.9);
    store.applyPreset('CRITICAL');
    store.saveSnapshot('КРИТИЧЕСКИЙ КАДР');

    const snapshot = operationsStore.getState().production.snapshots[0];
    expect(snapshot).toBeDefined();
    operationsStore.getState().setRoute('overview');
    operationsStore.getState().setMapView([50, 50], 1);
    operationsStore.getState().applyPreset('NORMAL');
    operationsStore.getState().restoreSnapshot(snapshot?.id ?? 'missing');

    const restored = operationsStore.getState();
    expect(restored.ui.route).toBe('map');
    expect(restored.ui.mapCenter).toEqual([61, 43]);
    expect(restored.ui.mapZoom).toBe(1.9);
    expect(restored.production.preset).toBe('CRITICAL');
  });

  it('advances deterministically and freezes when simulation is paused', () => {
    const before = operationsStore.getState();
    before.simulationTick();
    const afterTick = operationsStore.getState();
    expect(afterTick.metrics.simulationStep).toBe(1);
    expect(afterTick.objects['K-17']?.lastSeenAt).not.toBe(before.objects['K-17']?.lastSeenAt);

    afterTick.setProductionOption('paused', true);
    operationsStore.getState().simulationTick();
    expect(operationsStore.getState().metrics.simulationStep).toBe(1);
  });

  it('completes linked tasks without mutating the seed contract', () => {
    const task = Object.values(operationsStore.getState().tasks).find(
      (candidate) => candidate.status !== 'completed',
    );
    expect(task).toBeDefined();
    operationsStore.getState().completeTask(task?.id ?? 'missing');
    expect(operationsStore.getState().tasks[task?.id ?? '']?.status).toBe('completed');
    expect(operationsStore.getState().tasks[task?.id ?? '']?.progress).toBe(100);
  });

  it('keeps personalization as a versioned draft with independent category reset and publish', () => {
    const store = operationsStore.getState();
    store.applySettingsPatch([
      { id: 'themes.id', value: 'cold-cyan' },
      { id: 'layout.density', value: 'mainframe' },
    ]);
    store.resetSettingsCategory('themes');

    let current = operationsStore.getState();
    expect(current.personalization.draft.values['themes.id']).toBe('terminal-red');
    expect(current.personalization.draft.values['layout.density']).toBe('mainframe');
    store.publishSettingsDraft();

    current = operationsStore.getState();
    expect(current.personalization.published.revision).toBe(1);
    expect(current.personalization.published.values['layout.density']).toBe('mainframe');
    expect(current.personalization.draft.changedIds).toEqual([]);
  });

  it('keeps local settings history reversible without mutating the published revision', () => {
    const store = operationsStore.getState();
    store.applySettingsPatch([{ id: 'themes.id', value: 'cold-cyan' }]);
    store.applySettingsPatch([{ id: 'layout.density', value: 'mainframe' }]);

    let current = operationsStore.getState();
    expect(current.personalization.history).toHaveLength(2);
    expect(current.personalization.undoStack).toHaveLength(2);
    expect(current.personalization.draft.values['layout.density']).toBe('mainframe');

    store.undoSettingsDraft();
    current = operationsStore.getState();
    expect(current.personalization.draft.values['themes.id']).toBe('cold-cyan');
    expect(current.personalization.draft.values['layout.density']).toBe('dense');
    expect(current.personalization.redoStack).toHaveLength(1);
    expect(current.personalization.published.revision).toBe(0);

    store.redoSettingsDraft();
    current = operationsStore.getState();
    expect(current.personalization.draft.values['layout.density']).toBe('mainframe');

    const historicalTheme = current.personalization.history.find(
      (entry) => entry.operation === 'patch' && entry.changedIds.includes('themes.id'),
    );
    expect(historicalTheme).toBeDefined();
    current.restoreSettingsHistoryEntry(historicalTheme?.id ?? 'missing');
    expect(operationsStore.getState().personalization.draft.values['themes.id']).toBe('cold-cyan');
  });
});

describe('edit mode', () => {
  beforeEach(() => {
    operationsStore.getState().exitEditMode();
  });

  it('opens and closes without touching the settings draft', () => {
    const before = operationsStore.getState().personalization.draft;

    operationsStore.getState().enterEditMode();
    expect(operationsStore.getState().edit.active).toBe(true);

    operationsStore.getState().exitEditMode();
    expect(operationsStore.getState().edit.active).toBe(false);
    // Edit mode is a lens over the existing draft, never a second copy of it.
    expect(operationsStore.getState().personalization.draft).toBe(before);
  });

  it('clears the selected element when the mode closes', () => {
    operationsStore.getState().enterEditMode();
    operationsStore.getState().selectEditElement('tile.overview.alerts');
    expect(operationsStore.getState().edit.selectedElementId).toBe('tile.overview.alerts');

    operationsStore.getState().exitEditMode();
    // A stale selection would outlive the mode and reappear on the next entry.
    expect(operationsStore.getState().edit.selectedElementId).toBe('');
  });

  it('keeps the panel edge across a close and reopen', () => {
    operationsStore.getState().enterEditMode();
    operationsStore.getState().dockEditPanel('left');
    operationsStore.getState().exitEditMode();
    operationsStore.getState().enterEditMode();

    // Where the operator parked the panel is a preference for the session,
    // unlike the selection, which belongs to one editing pass.
    expect(operationsStore.getState().edit.dockEdge).toBe('left');
  });
});

describe('advanced depth and privacy settings', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('bounds the settings history by the depth the operator set', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'advanced.historyDepth', value: 50 }]);

    for (let index = 0; index < 60; index += 1) {
      operationsStore
        .getState()
        .applySettingsPatch([
          { id: 'layout.density', value: index % 2 === 0 ? 'dense' : 'mainframe' },
        ]);
    }

    // The history is paged, filtered and sorted on the settings screen, so its
    // depth is what an operator can still look back through.
    expect(operationsStore.getState().personalization.history.length).toBe(50);
  });

  it('bounds the undo stack by the depth the operator set', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'advanced.undoDepth', value: 20 }]);

    for (let index = 0; index < 40; index += 1) {
      operationsStore
        .getState()
        .applySettingsPatch([
          { id: 'layout.density', value: index % 2 === 0 ? 'dense' : 'mainframe' },
        ]);
    }

    expect(operationsStore.getState().personalization.undoStack.length).toBe(20);
  });
});

describe('domain content edits (R4)', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('applies a content patch to the world at once and records it in the settings ledger', () => {
    const store = operationsStore.getState();
    store.applyContentPatch([
      { id: 'case.title', entityId: 'CASE-01', value: 'НАБЛЮДЕНИЕ / K-01 / ПРОВЕРЕНО' },
    ]);

    const next = operationsStore.getState();
    expect(next.cases['CASE-01']?.title).toBe('НАБЛЮДЕНИЕ / K-01 / ПРОВЕРЕНО');
    expect(next.content.overrides).toEqual({
      'case.title@CASE-01': 'НАБЛЮДЕНИЕ / K-01 / ПРОВЕРЕНО',
    });
    const entry = next.personalization.history[0];
    expect(entry).toMatchObject({
      operation: 'patch',
      category: 'information',
      scope: 'device',
      changedIds: ['case.title@CASE-01'],
    });
    expect(entry?.content).toEqual({
      before: {},
      after: { 'case.title@CASE-01': 'НАБЛЮДЕНИЕ / K-01 / ПРОВЕРЕНО' },
    });
    // The settings draft is not what changed.
    expect(next.personalization.draft.changedIds).toEqual([]);
    expect(next.personalization.undoStack).toHaveLength(1);
    expect(next.audit[0]?.action).toBe('ИЗМЕНЕНО СОДЕРЖИМОЕ');
  });

  it('moves a case date by the calendar day the registry prints', () => {
    operationsStore
      .getState()
      .applyContentPatch([{ id: 'case.createdAt', entityId: 'CASE-02', value: '2026-09-01' }]);

    const createdAt = operationsStore.getState().cases['CASE-02']?.createdAt ?? '';
    expect(new Date(createdAt).toLocaleDateString('ru-RU')).toBe('01.09.2026');
  });

  it('undoes and redoes a content edit through the shared stack, leaving the draft alone', () => {
    const store = operationsStore.getState();
    store.applySettingsPatch([{ id: 'themes.id', value: 'cold-cyan' }]);
    store.applyContentPatch([
      { id: 'event.title', entityId: 'EV-1001', value: 'K-17: СИГНАЛ ВОССТАНОВЛЕН' },
    ]);
    const title = () =>
      operationsStore.getState().events.find((event) => event.id === 'EV-1001')?.title;
    expect(operationsStore.getState().personalization.undoStack).toHaveLength(2);

    store.undoSettingsDraft();
    let current = operationsStore.getState();
    expect(title()).toBe('K-17: ПОТЕРЯ СИГНАЛА');
    expect(current.content.overrides).toEqual({});
    // The theme change beneath it is untouched by undoing a content edit.
    expect(current.personalization.draft.values['themes.id']).toBe('cold-cyan');
    expect(current.personalization.redoStack).toHaveLength(1);

    store.redoSettingsDraft();
    expect(title()).toBe('K-17: СИГНАЛ ВОССТАНОВЛЕН');

    store.undoSettingsDraft();
    store.undoSettingsDraft();
    current = operationsStore.getState();
    expect(title()).toBe('K-17: ПОТЕРЯ СИГНАЛА');
    expect(current.personalization.draft.values['themes.id']).toBe('terminal-red');
  });

  it('refuses an unknown field and a bad date without touching the state or the ledger', () => {
    const store = operationsStore.getState();

    expect(() =>
      store.applyContentPatch([{ id: 'case.priority', entityId: 'CASE-01', value: '1' }]),
    ).toThrow(ContentPatchError);
    expect(() =>
      store.applyContentPatch([{ id: 'case.createdAt', entityId: 'CASE-01', value: '2026-02-30' }]),
    ).toThrow(ContentPatchError);

    const current = operationsStore.getState();
    expect(current.personalization.history).toHaveLength(0);
    expect(current.content.overrides).toEqual({});
    expect(current.cases['CASE-01']?.createdAt).toBe(operationsSeed.cases[0]?.createdAt);
  });

  it('resets one field by patching the seed value back, and every field at once', () => {
    const store = operationsStore.getState();
    const seedBirthDate = seedContentValue('person.birthDate', 'P-01');
    store.applyContentPatch([{ id: 'person.birthDate', entityId: 'P-01', value: '1980-01-15' }]);
    store.applyContentPatch([
      { id: 'report.title', entityId: 'REP-01', value: 'ОПЕРАТИВНАЯ СВОДКА / ГС / ЧЕРНОВИК' },
    ]);

    store.applyContentPatch([{ id: 'person.birthDate', entityId: 'P-01', value: seedBirthDate }]);
    let current = operationsStore.getState();
    expect(current.people['P-01']?.birthDate).toBe(seedBirthDate);
    expect(Object.keys(current.content.overrides)).toEqual(['report.title@REP-01']);

    store.resetContentEdits();
    current = operationsStore.getState();
    expect(current.content.overrides).toEqual({});
    expect(current.reports['REP-01']?.title).toBe(operationsSeed.reports[0]?.title);
    expect(current.personalization.history[0]).toMatchObject({
      operation: 'reset-category',
      category: 'information',
      changedIds: ['report.title@REP-01'],
    });
    // Nothing to reset is not a change, so no entry claims one.
    const entries = current.personalization.history.length;
    store.resetContentEdits();
    expect(operationsStore.getState().personalization.history).toHaveLength(entries);
  });

  it('restores a content entry from the history into the world', () => {
    const store = operationsStore.getState();
    store.applyContentPatch([
      { id: 'operation.title', entityId: 'OP-GS-042', value: 'ГРЕМУЧАЯ СМЕСЬ II' },
    ]);
    const entry = operationsStore.getState().personalization.history[0];
    store.resetContentEdits();
    expect(operationsStore.getState().operation.title).toBe('ГРЕМУЧАЯ СМЕСЬ');

    operationsStore.getState().restoreSettingsHistoryEntry(entry?.id ?? 'missing');

    expect(operationsStore.getState().operation.title).toBe('ГРЕМУЧАЯ СМЕСЬ II');
    expect(operationsStore.getState().content.overrides).toEqual({
      'operation.title@OP-GS-042': 'ГРЕМУЧАЯ СМЕСЬ II',
    });
  });

  it('is found by the history query under the information category and by its key', () => {
    operationsStore
      .getState()
      .applyContentPatch([{ id: 'case.createdAt', entityId: 'CASE-04', value: '2026-09-02' }]);
    operationsStore.getState().applySettingsPatch([{ id: 'themes.id', value: 'cold-cyan' }]);

    const page = querySettingsHistory(operationsStore.getState().personalization.history, {
      page: 1,
      pageSize: 10,
      order: 'newest',
      category: 'information',
      settingId: 'CASE-04',
    });

    expect(page.total).toBe(1);
    expect(page.items[0]?.changedIds).toEqual(['case.createdAt@CASE-04']);
  });

  it('gives consecutive ledger entries distinct ids even within one millisecond', () => {
    const store = operationsStore.getState();
    store.applyContentPatch([{ id: 'case.title', entityId: 'CASE-05', value: 'ДЕЛО / А' }]);
    store.applyContentPatch([{ id: 'case.title', entityId: 'CASE-05', value: 'ДЕЛО / Б' }]);

    const ids = operationsStore.getState().personalization.history.map((entry) => entry.id);
    // The history list keys rows by id and restore finds an entry by it; two
    // changes in the same millisecond used to share one.
    expect(new Set(ids).size).toBe(ids.length);
  });
});
