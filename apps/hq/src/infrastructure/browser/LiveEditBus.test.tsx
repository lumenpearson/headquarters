// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '../../state/operationsStore';
import { EditModeRuntime } from '@/components/edit/EditModeRuntime';
import type { LiveEditPatchSet, LiveEditTransport } from './LiveEditBus';

interface RecordingTransport extends LiveEditTransport {
  /** Every patch set that actually left this session, in order. */
  readonly sent: readonly LiveEditPatchSet[];
  /** Plays the part of another session in the group. */
  deliver(patchSet: LiveEditPatchSet): void;
}

/*
 * A transport rather than a spy on one. The claim under test is that with the
 * group's opt-in off nothing leaves the session at all, and the only way to
 * state that is to hold the whole channel and find it empty -- a mock counting
 * calls on a channel that was opened anyway would pass while a BroadcastChannel
 * carried the edit to every other tab.
 */
function recordingTransport(): RecordingTransport {
  const sent: LiveEditPatchSet[] = [];
  const listeners = new Set<(patchSet: LiveEditPatchSet) => void>();
  return {
    sent,
    deliver(patchSet) {
      for (const listener of listeners) listener(patchSet);
    },
    publish(patchSet) {
      sent.push(patchSet);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      listeners.clear();
    },
  };
}

function enableLiveEdit(): void {
  act(() => {
    operationsStore.getState().applySettingsPatch([{ id: 'advanced.liveEdit', value: true }]);
  });
}

function density(): unknown {
  return operationsStore.getState().personalization.draft.values['layout.density'];
}

function caseTitle(entityId: string): string | undefined {
  return operationsStore.getState().cases[entityId]?.title;
}

describe('advanced.liveEdit', () => {
  beforeEach(() => {
    // resetWorld rebuilds from createBaseState, so the draft comes back at the
    // schema defaults -- `advanced.liveEdit` off, `layout.density` dense --
    // and no opt-in survives from an earlier test.
    operationsStore.getState().resetWorld();
    operationsStore.getState().exitEditMode();
  });

  it('keeps an edit-mode change in this session while the group has not opted in', () => {
    const transport = recordingTransport();
    render(<EditModeRuntime transport={transport} />);

    act(() => {
      operationsStore.getState().enterEditMode();
      operationsStore
        .getState()
        .applySettingsPatch([{ id: 'layout.density', value: 'comfortable' }]);
    });

    expect(transport.sent).toEqual([]);
    // The change still happened -- off means unshared, not inert.
    expect(density()).toBe('comfortable');
  });

  it('refuses a change another session sends while the group has not opted in', () => {
    const transport = recordingTransport();
    render(<EditModeRuntime transport={transport} />);

    act(() => {
      transport.deliver({
        kind: 'settings',
        patches: [{ id: 'layout.density', value: 'comfortable' }],
      });
    });

    // The opt-in is a group decision, so a session whose group has not made it
    // is not merely silent: nothing subscribes, and a session that did opt in
    // cannot reach into one that did not.
    expect(density()).toBe('dense');
  });

  it('publishes the same change once the group has enabled live edit', () => {
    const transport = recordingTransport();
    render(<EditModeRuntime transport={transport} />);

    enableLiveEdit();
    // The opt-in itself does not travel: there is no channel until it is on.
    expect(transport.sent).toEqual([]);

    act(() => {
      operationsStore.getState().enterEditMode();
      operationsStore
        .getState()
        .applySettingsPatch([{ id: 'layout.density', value: 'comfortable' }]);
    });

    expect(transport.sent).toEqual([
      { kind: 'settings', patches: [{ id: 'layout.density', value: 'comfortable' }] },
    ]);
  });

  it('applies a change from another session without echoing it back', () => {
    const transport = recordingTransport();
    render(<EditModeRuntime transport={transport} />);

    enableLiveEdit();
    act(() => {
      transport.deliver({
        kind: 'settings',
        patches: [{ id: 'layout.density', value: 'comfortable' }],
      });
    });

    expect(density()).toBe('comfortable');
    // Landing a received patch runs the same store action that publishes one,
    // so an unguarded apply would have the two sessions echoing forever.
    expect(transport.sent).toEqual([]);
  });

  it('stops publishing as soon as the opt-in is withdrawn', () => {
    const transport = recordingTransport();
    render(<EditModeRuntime transport={transport} />);

    enableLiveEdit();
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'advanced.liveEdit', value: false }]);
    });
    // The withdrawal goes out over the connection it closes, so the group
    // learns the decision changed.
    expect(transport.sent).toEqual([
      { kind: 'settings', patches: [{ id: 'advanced.liveEdit', value: false }] },
    ]);

    act(() => {
      operationsStore
        .getState()
        .applySettingsPatch([{ id: 'layout.density', value: 'comfortable' }]);
      transport.deliver({
        kind: 'settings',
        patches: [{ id: 'layout.density', value: 'mainframe' }],
      });
    });

    expect(transport.sent).toEqual([
      { kind: 'settings', patches: [{ id: 'advanced.liveEdit', value: false }] },
    ]);
    expect(density()).toBe('comfortable');
  });

  // R4 tail: domain-content edits ride the same bus as settings, kinded apart.

  it('publishes a content edit once the group has enabled live edit', () => {
    const transport = recordingTransport();
    render(<EditModeRuntime transport={transport} />);

    enableLiveEdit();
    act(() => {
      operationsStore
        .getState()
        .applyContentPatch([{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / ПРОВЕРЕНО' }]);
    });

    expect(transport.sent).toEqual([
      {
        kind: 'content',
        patches: [{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / ПРОВЕРЕНО' }],
      },
    ]);
  });

  it('applies a content edit from another session as its own undoable entry', () => {
    const transport = recordingTransport();
    render(<EditModeRuntime transport={transport} />);
    const seedTitle = caseTitle('CASE-01');

    enableLiveEdit();
    act(() => {
      transport.deliver({
        kind: 'content',
        patches: [{ id: 'case.title', entityId: 'CASE-01', value: 'ДЕЛО / СОСЕД' }],
      });
    });

    expect(caseTitle('CASE-01')).toBe('ДЕЛО / СОСЕД');
    // Landing a received patch runs the same store action that publishes one,
    // so an unguarded apply would have the two sessions echoing forever.
    expect(transport.sent).toEqual([]);

    // R4: the neighbor's edit is its own reversible ledger entry, the same
    // way a local content patch already is -- undo reverts it specifically,
    // instead of a bulk replace from this session's own (empty) history
    // silently discarding it.
    act(() => {
      operationsStore.getState().undoSettingsDraft();
    });
    expect(caseTitle('CASE-01')).toBe(seedTitle);
  });
});
