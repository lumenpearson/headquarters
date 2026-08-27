// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  disconnectedConnection,
  initialGroupMirrorSummary,
  type DeviceRole,
  type GroupDevice,
} from '@/application/sync/connection';
import type { ControlPlaneSession } from '@/application/sync/ControlPlaneSession';
import type { PairingCodeGrant } from '@/application/sync/controlPlanePort';
import { operationsStore } from '@/state/operationsStore';

import { GroupPairingDialog, openGroupPairing } from './GroupPairingDialog';

/*
 * The dialog's collaborator is the session, which the application holds in a
 * module of its own and a component test has no other way to supply. Mocking
 * the holder rather than exporting a setter from it keeps the runtime with one
 * writer, which is the reason the holder exists.
 *
 * `vi.hoisted` and a plain static import, rather than a `const` beside a
 * dynamic `await import`. `vi.mock` is lifted above the imports, so the holder
 * it closes over has to be lifted with it; the dynamic form was a way of
 * ordering the two by hand, and hand-ordered module evaluation is the kind of
 * thing that holds until the graph around it changes.
 */
const held = vi.hoisted(() => ({ session: null as FakeSession | null }));
vi.mock('./ControlPlaneRuntime', () => ({
  currentControlPlaneSession: () => held.session,
  subscribeControlPlaneSession: () => () => {},
}));

/**
 * The session as this surface uses it: a transcript of what was asked of it,
 * and the answers it was set up to give. Not a spy on a real one -- the claims
 * below are about what the dialog offers and refuses to offer, and a transcript
 * is what shows that a refused command sent nothing.
 */
class FakeSession {
  readonly calls: string[] = [];
  grant: PairingCodeGrant | null = null;
  created = true;

  /*
   * Each member is typed from the real service rather than written freely, so a
   * signature that moves breaks this file instead of leaving it passing against
   * a shape the dialog no longer calls.
   */
  readonly createGroup: ControlPlaneSession['createGroup'] = async (request) => {
    this.calls.push(`createGroup:${request.name}:${request.deviceName}:${request.bootstrapSecret}`);
    return this.created;
  };

  readonly createPairingCode: ControlPlaneSession['createPairingCode'] = async (role) => {
    this.calls.push(`createPairingCode:${role}`);
    return this.grant;
  };

  readonly renameGroup: ControlPlaneSession['renameGroup'] = async (name) => {
    this.calls.push(`renameGroup:${name}`);
    return true;
  };

  readonly setDeviceRole: ControlPlaneSession['setDeviceRole'] = async (deviceId, role) => {
    this.calls.push(`setDeviceRole:${deviceId}:${role}`);
    return true;
  };
}

function useSession(): FakeSession {
  const session = new FakeSession();
  held.session = session;
  return session;
}

/**
 * Opens the dialog and answers with the popup every query below is scoped to.
 *
 * Three things are established here rather than assumed, because a case that
 * assumes them does not fail when they stop holding -- it passes for a reason
 * that has nothing to do with what it asserts.
 *
 * - **The popup is on screen.** `TerminalDialog` renders through
 *   `Dialog.Portal`, so its content is not inside the container `render`
 *   answered with, and it does not necessarily arrive in the same tick as the
 *   state change that opened it. `findByRole` waits for the thing the case is
 *   about to inspect.
 * - **The queries are scoped to it.** Every assertion below reads this element
 *   rather than the whole document, so nothing another case left behind can
 *   satisfy or break one of them.
 * - **The mocked holder is in effect.** `.group-pairing__note` renders exactly
 *   when the dialog has no session. If the mock ever failed to apply, every
 *   command would be absent and the negative assertions would pass while
 *   proving nothing.
 */
async function open(): Promise<HTMLElement> {
  render(<GroupPairingDialog />);
  act(() => {
    openGroupPairing();
  });
  const dialog = await screen.findByRole('dialog');
  expect(dialog.querySelector('.group-pairing__note')).toBeNull();
  return dialog;
}

function button(dialog: HTMLElement, name: RegExp): HTMLButtonElement {
  return within(dialog).getByRole('button', { name }) as HTMLButtonElement;
}

/** The group as a session that has joined one holds it. */
function joined(role: DeviceRole, devices: readonly GroupDevice[] = defaultDevices()): void {
  act(() => {
    operationsStore.getState().patchConnection({
      mode: 'online',
      session: { deviceId: 'device-a', groupId: 'group-a', role },
      groupName: 'ШТАБ',
      authority: 'multi-authority',
      leaderDeviceId: 'device-b',
      groupRevision: 7,
      devices,
    });
  });
}

function defaultDevices(): readonly GroupDevice[] {
  return [
    { deviceId: 'device-a', name: 'ЭКРАН 1', role: 'ADMIN', status: 'ONLINE' },
    { deviceId: 'device-b', name: 'ЭКРАН 2', role: 'ADMIN', status: 'ONLINE' },
  ];
}

describe('GroupPairingDialog over the group administration commands', () => {
  beforeEach(() => {
    localStorage.clear();
    operationsStore.getState().resetWorld();
    /*
     * `resetWorld` deliberately keeps the `connection` slice: the group this
     * session is in is not part of the simulated world, and the service that
     * owns the slice is not told about a reset (`operationsStore.ts`). So the
     * slice is cleared here, explicitly. Without this, a case whose whole
     * premise is "nothing is paired" inherited a session and a roster from
     * whichever case ran before it, and the file passed only in the order it
     * was written.
     *
     * `disconnectedConnection` and not `initialConnectionState`, for the reason
     * that helper exists: `patchConnection` merges, and the initial state
     * leaves its optional fields out rather than naming them `undefined`, so
     * spreading it over a joined session clears the mode and leaves the session
     * itself standing.
     */
    operationsStore.getState().patchConnection({
      ...disconnectedConnection('local-only'),
      links: [],
      mirror: initialGroupMirrorSummary,
    });
    held.session = null;
    // Cleanup runs in `vitest.setup.ts`. If it ever stops running, this says so
    // at the first line of the next case rather than through a query further
    // down matching an element the previous case left behind.
    expect(document.body.textContent).toBe('');
  });

  it('keeps the bootstrap secret off the surface until a group is actually being made', async () => {
    const session = useSession();
    // Nothing paired: the state an operator is in when the group does not exist
    // yet and the pairing code they are being asked for cannot exist either.
    act(() => {
      operationsStore.getState().patchConnection({ mode: 'reauth-required' });
    });
    const dialog = await open();

    expect(within(dialog).queryByLabelText('Секрет развёртывания')).toBeNull();

    act(() => {
      fireEvent.click(button(dialog, /создать новую группу/i));
    });

    /*
     * A deployment secret is not something to leave standing on screen while an
     * operator is merely pairing, and it is never persisted: the field is
     * masked and holds the value for as long as this dialog is open.
     */
    const secret = within(dialog).getByLabelText('Секрет развёртывания') as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect(session.calls).toEqual([]);
  });

  it('creates the group with what was typed, and forgets the secret afterwards', async () => {
    const session = useSession();
    act(() => {
      operationsStore.getState().patchConnection({ mode: 'reauth-required' });
    });
    const dialog = await open();
    act(() => {
      fireEvent.click(button(dialog, /создать новую группу/i));
    });

    act(() => {
      fireEvent.change(within(dialog).getByLabelText('Имя новой группы'), {
        target: { value: 'ШТАБ' },
      });
      fireEvent.change(within(dialog).getByLabelText('Имя устройства'), {
        target: { value: 'MON-01' },
      });
      fireEvent.change(within(dialog).getByLabelText('Секрет развёртывания'), {
        target: { value: 'secret-value' },
      });
    });
    await act(async () => {
      fireEvent.click(button(dialog, /\[N\] создать группу/i));
    });

    expect(session.calls).toEqual(['createGroup:ШТАБ:MON-01:secret-value']);
    // The block folds away on success and the secret goes with it; a value left
    // in a mounted field is a value one screenshot away from being shared.
    expect(within(dialog).queryByLabelText('Секрет развёртывания')).toBeNull();
  });

  it('shows an issued code with the deadline it stops working at', async () => {
    const session = useSession();
    const expiresAtMs = Date.UTC(2026, 7, 27, 9, 41, 5);
    session.grant = { code: 'PAIR-0001', role: 'EDITOR', expiresAtMs };
    joined('ADMIN');
    const dialog = await open();

    await act(async () => {
      fireEvent.click(button(dialog, /выпустить код пары/i));
    });

    const shown = dialog.querySelector('.group-pairing__code')?.textContent ?? '';
    expect(shown).toContain('PAIR-0001');
    /*
     * A code without its deadline is one an operator is still reading out after
     * the server has forgotten it, which on set presents as "the code is
     * wrong". The clock is the machine's own, so the expected reading is taken
     * from the same instant rather than written as a literal.
     */
    const at = new Date(expiresAtMs);
    const clock = [at.getHours(), at.getMinutes(), at.getSeconds()]
      .map((part) => String(part).padStart(2, '0'))
      .join(':');
    expect(shown).toContain('ДЕЙСТВУЕТ ДО');
    expect(shown).toContain(clock);
    expect(session.calls).toEqual(['createPairingCode:EDITOR']);
  });

  it('lets an issued code close with the dialog rather than waiting there', async () => {
    const session = useSession();
    session.grant = { code: 'PAIR-0001', role: 'EDITOR', expiresAtMs: Date.now() + 600_000 };
    joined('ADMIN');
    const dialog = await open();
    await act(async () => {
      fireEvent.click(button(dialog, /выпустить код пары/i));
    });
    expect(dialog.querySelector('.group-pairing__code')).not.toBeNull();

    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
    });
    act(() => {
      openGroupPairing();
    });
    const reopened = await screen.findByRole('dialog');

    /*
     * A code is a credential with a deadline. Leaving the last one on screen
     * would have an operator read out a code the server forgot minutes ago,
     * from a dialog they opened for something else entirely.
     */
    expect(reopened.querySelector('.group-pairing__code')).toBeNull();
  });

  it('offers no rename to the name the group already has', async () => {
    useSession();
    joined('ADMIN');
    const dialog = await open();

    act(() => {
      fireEvent.change(within(dialog).getByLabelText('Новое имя группы'), {
        target: { value: ' ШТАБ ' },
      });
    });

    // The control plane would accept it and spend a revision and a log row on a
    // change of nothing.
    expect(button(dialog, /переименовать группу/i).disabled).toBe(true);

    act(() => {
      fireEvent.change(within(dialog).getByLabelText('Новое имя группы'), {
        target: { value: 'ШТАБ-2' },
      });
    });
    expect(button(dialog, /переименовать группу/i).disabled).toBe(false);
  });

  it('offers no group command while the address answers for another database', async () => {
    useSession();
    joined('ADMIN');
    act(() => {
      operationsStore.getState().patchConnection({ mode: 'installation-changed' });
    });
    const dialog = await open();

    /*
     * The stored session is good and the group behind this address is not the
     * one it belongs to. Renaming or promoting here would be a command aimed at
     * a database this device never joined. The roster is still drawn, which is
     * what makes this an absence rather than an empty dialog.
     */
    expect(dialog.querySelector('.group-pairing__admin')).toBeNull();
    expect(dialog.querySelector('.group-pairing__devices')).not.toBeNull();
  });

  it('offers an administrator only the two roles a pairing code can grant', async () => {
    useSession();
    joined('ADMIN');
    const dialog = await open();

    act(() => {
      fireEvent.click(within(dialog).getByLabelText('Роль для нового устройства'));
    });

    // The option list is a portal of its own, so it is read from the document
    // rather than from the dialog; the selected item carries the `[×]`
    // indicator, and the role is what is read.
    const options = screen
      .getAllByRole('option')
      .map((option) => (option.textContent ?? '').replace('[×]', ''));
    // `CreatePairingCode` answers `INVALID_ARGUMENT` for `ADMIN`
    // (`durable-runtime.ts`): an administrator is made by promoting a device
    // that already joined, so there is no third option to choose wrongly. The
    // two that are offered are named as well, so an empty list cannot pass.
    expect(options).toEqual(['РЕДАКТОР', 'НАБЛЮДАТЕЛЬ']);
  });

  it('closes every administrative command to a viewer, and sends nothing', async () => {
    const session = useSession();
    joined('VIEWER');
    const dialog = await open();

    const leaderButtons = within(dialog).getAllByRole('button', {
      name: /\[G\] главная/i,
    }) as HTMLButtonElement[];
    expect(button(dialog, /выпустить код пары/i).disabled).toBe(true);
    expect(button(dialog, /переименовать группу/i).disabled).toBe(true);
    expect(leaderButtons.every((entry) => entry.disabled)).toBe(true);

    act(() => {
      fireEvent.click(button(dialog, /выпустить код пары/i));
      leaderButtons.forEach((entry) => fireEvent.click(entry));
    });

    /*
     * Disabled rather than hidden, so an operator learns the command exists and
     * that their role is what stands between them and it -- and disabled is an
     * affordance, not a guard: the control plane refuses the same thing again
     * and the dialog prints its refusal.
     */
    expect(session.calls).toEqual([]);
    expect(within(dialog).getByText(/распоряжается администратор группы/i)).not.toBeNull();
  });

  it('opens those same commands the moment this session role is raised', async () => {
    useSession();
    joined('EDITOR');
    const dialog = await open();

    expect(button(dialog, /выпустить код пары/i).disabled).toBe(true);

    // What the group log does to this slice when an administrator on another
    // machine promotes this device; `groupDevicePatch` is what writes it.
    act(() => {
      operationsStore.getState().patchConnection({
        session: { deviceId: 'device-a', groupId: 'group-a', role: 'ADMIN' },
      });
    });

    expect(button(dialog, /выпустить код пары/i).disabled).toBe(false);
  });

  it('closes a demotion the control plane would refuse, and says why', async () => {
    useSession();
    joined('ADMIN', [
      { deviceId: 'device-a', name: 'ЭКРАН 1', role: 'ADMIN', status: 'ONLINE' },
      { deviceId: 'device-b', name: 'ЭКРАН 2', role: 'EDITOR', status: 'ONLINE' },
    ]);
    const dialog = await open();

    /*
     * One administrator left. `setDeviceRole` refuses to remove the last one
     * under the membership lock, and `ListDevices` answers exactly the active
     * memberships that statement counts, so the option is closed here rather
     * than offered and refused.
     */
    const rows = [...dialog.querySelectorAll('.group-pairing__devices article')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('ХОТЯ БЫ ОДИН АДМИНИСТРАТОР');
    expect(rows[1]?.textContent).not.toContain('ХОТЯ БЫ ОДИН АДМИНИСТРАТОР');

    act(() => {
      fireEvent.click(within(dialog).getByLabelText('Роль устройства ЭКРАН 1'));
    });

    // The reason is printed and the option is closed; a hint beside an option
    // that still works would be a label, not a rule.
    expect(
      screen.getAllByRole('option').map((option) => option.getAttribute('aria-disabled')),
    ).toEqual([null, 'true', 'true']);
  });

  it('closes a demotion of the leader while the group runs on one leader', async () => {
    useSession();
    act(() => {
      operationsStore.getState().patchConnection({
        mode: 'online',
        session: { deviceId: 'device-a', groupId: 'group-a', role: 'ADMIN' },
        groupName: 'ШТАБ',
        authority: 'leader',
        leaderDeviceId: 'device-b',
        devices: defaultDevices(),
      });
    });
    const dialog = await open();

    // Under `LEADER` authority the server refuses to demote the leader out of
    // `ADMIN` and names the order: move the leadership first.
    const rows = [...dialog.querySelectorAll('.group-pairing__devices article')];
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain('ПЕРЕДАЙТЕ ГЛАВНУЮ СЕССИЮ');
  });

  it('prints what the control plane refused rather than swallowing it', async () => {
    useSession();
    joined('ADMIN');
    act(() => {
      operationsStore.getState().patchConnection({
        failure: 'ЗАПРОС К CONTROL PLANE ОТКЛОНЁН: A group must retain at least one administrator.',
      });
    });
    const dialog = await open();

    // The one line an operator has to see when a command did nothing.
    expect(within(dialog).getByText(/ЗАПРОС К CONTROL PLANE ОТКЛОНЁН/)).not.toBeNull();
  });
});
