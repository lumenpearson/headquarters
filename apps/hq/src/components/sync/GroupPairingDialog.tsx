'use client';

import {
  TerminalButton,
  TerminalDialog,
  TerminalField,
  TerminalInput,
  TerminalSelect,
} from '@gremuchaya/ui/primitives';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { dateTimeFormat } from '@/application/localization/intl';
import {
  authorityModeLabel,
  connectionModeLabel,
  deviceRoleLabel,
  realtimeStatusLabel,
  realtimeStatusToken,
  type ConnectionState,
  type ControlPlaneCapabilities,
  type ControlPlaneLinkState,
  type DeviceRole,
  type GroupDevice,
  type PairingRole,
} from '@/application/sync/connection';
import type { PairingCodeGrant } from '@/application/sync/controlPlanePort';
import { useContextMenuAction } from '@/components/contextMenus/ContextMenuRuntime';
import { useOperationsStore } from '@/state/operationsStore';

import { currentControlPlaneSession, subscribeControlPlaneSession } from './ControlPlaneRuntime';

/*
 * One opener for two entry points -- the shell's commands menu and the
 * settings screen -- in the idiom `fireKeybind` uses next door. The dialog is
 * mounted once in the root layout, so both entry points reach the same
 * instance and neither has to own its own copy of the surface.
 */
const openers = new Set<() => void>();

export function openGroupPairing(): void {
  for (const open of [...openers]) open();
}

/**
 * The group this session belongs to, and how to make, join, staff or leave one
 * (R27).
 *
 * Everything shown here is read from the `connection` slice, which
 * `ControlPlaneSession` is the only writer of; the buttons call that session
 * rather than the transport. With no session -- local-only, or no control
 * plane configured -- the dialog still opens and says so, because an operator
 * who cannot see why a screen is alone cannot fix it.
 *
 * **Why the whole group lifecycle is on this one surface.** Creating the group,
 * issuing a pairing code, renaming the group and promoting a device all read
 * the same four facts this dialog already renders -- the session's own role,
 * the roster, the leader and the authority mode -- from one slice with one
 * writer. A second surface would need the same subscriptions and would then
 * disagree with this one about a role the moment a `DEVICE_UPDATED` event
 * arrived. The two halves of the pairing code belong together besides: the
 * administrator issues here the code a neighbour types into the field above.
 * The settings catalogue is the wrong home for the same reason it is the right
 * home for `groups.authority` -- a setting is a validated value with a scope,
 * and a pairing code is a one-shot credential with a deadline.
 */
export function GroupPairingDialog() {
  const [open, setOpen] = useState(false);
  const connection = useOperationsStore((state) => state.connection);
  const screenId = useOperationsStore((state) => state.production.screenId);
  const [pairingCode, setPairingCode] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  /*
   * The deployment's bootstrap secret, for as long as the operator is typing it
   * and no longer. It is deliberately component state: the store is persisted
   * to `localStorage`, broadcast over the screen bus and copied into diagnostic
   * reports, and none of those may ever carry it. `changeOpen` below clears it
   * when the dialog closes, and the field itself is not rendered until the
   * operator asks to create a group.
   */
  const [bootstrapSecret, setBootstrapSecret] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [pairingRole, setPairingRole] = useState<PairingRole>('EDITOR');
  /* The issued code, held here for the same reason as the secret above. */
  const [grant, setGrant] = useState<PairingCodeGrant | null>(null);
  const session = useSyncExternalStore(
    subscribeControlPlaneSession,
    currentControlPlaneSession,
    // The server renders no connection; "nothing connected" is the honest
    // snapshot and matches what the client shows before the runtime mounts.
    () => null,
  );

  useEffect(() => {
    const opener = () => setOpen(true);
    openers.add(opener);
    return () => {
      openers.delete(opener);
    };
  }, []);

  /*
   * A closed dialog holds neither credential.
   *
   * On the open-state handler and not in an effect: `Dialog.Root` reports every
   * close through it -- the close button, Escape and the backdrop alike -- so
   * one handler covers all three, and clearing state from an effect body is a
   * cascading render besides.
   */
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) return;
    setBootstrapSecret('');
    setGrant(null);
  };

  useContextMenuAction(
    'shell.groupPairing',
    useCallback(() => setOpen(true), []),
  );

  const run = <Value,>(operation: () => Promise<Value>): Promise<Value> => {
    setBusy(true);
    return operation().finally(() => setBusy(false));
  };

  const paired = connection.session !== undefined;
  const admin = connection.session?.role === 'ADMIN';
  /*
   * The address answers, but its database is not the one this device paired
   * against. The stored session is deliberately still on disk: the client
   * refuses to act on it, and giving it up is the operator's decision, taken
   * here, rather than something a probe did to them.
   */
  const foreignInstallation = connection.mode === 'installation-changed';

  return (
    <TerminalDialog
      open={open}
      onOpenChange={changeOpen}
      eyebrow={`SYNC / ${connection.mode.toUpperCase()}`}
      title="СИНХРОНИЗАЦИЯ ГРУППЫ"
      description="Общая группа сессий: одна главная или все главные, с общими часами"
      className="group-pairing"
      footer={
        <div className="group-pairing__actions">
          {foreignInstallation ? (
            <TerminalButton
              className="ops-action ops-action--danger"
              tone="critical"
              disabled={busy || session === null}
              onClick={() => {
                session?.unpair();
                setPairingCode('');
              }}
            >
              [U] ЗАБЫТЬ СЕССИЮ И СПАРИТЬСЯ ЗАНОВО
            </TerminalButton>
          ) : null}
          {paired ? (
            <>
              <TerminalButton
                className="ops-action"
                disabled={busy || session === null || connection.mode !== 'online'}
                onClick={() => {
                  if (session !== null) void run(() => session.leave());
                }}
              >
                [L] ВЫЙТИ ИЗ ГРУППЫ
              </TerminalButton>
              <TerminalButton
                className="ops-action ops-action--danger"
                tone="critical"
                disabled={busy || session === null}
                onClick={() => {
                  session?.unpair();
                  setPairingCode('');
                }}
              >
                [U] ЗАБЫТЬ ПАРУ
              </TerminalButton>
            </>
          ) : null}
        </div>
      }
    >
      <ConnectionSummary connection={connection} />

      <ControlPlaneLinks links={connection.links} />

      {foreignInstallation ? (
        <p className="group-pairing__failure" role="status">
          АДРЕС ОТВЕЧАЕТ, НО ЗА НИМ ДРУГАЯ БАЗА CONTROL PLANE — НЕ ТА, С КОТОРОЙ СПАРЕНО ЭТО
          УСТРОЙСТВО. СОХРАНЁННАЯ СЕССИЯ ОСТАВЛЕНА НЕТРОНУТОЙ, ГРУППА НЕ ЧИТАЕТСЯ, ЛОКАЛЬНЫЕ
          НАСТРОЙКИ НЕ ПЕРЕЗАПИСАНЫ. ЕСЛИ БАЗУ ДЕЙСТВИТЕЛЬНО ПЕРЕСОЗДАЛИ — ЗАБУДЬТЕ СЕССИЮ И
          ЗАПРОСИТЕ НОВЫЙ КОД ПАРЫ.
        </p>
      ) : null}

      {session === null ? (
        <p className="group-pairing__note">
          {connection.mode === 'local-only'
            ? 'РЕЖИМ ТОЛЬКО ЭТОЙ МАШИНЫ. ВЫКЛЮЧИТЕ GENERAL.LOCALONLY И УКАЖИТЕ АДРЕС CONTROL PLANE, ЧТОБЫ ВОЙТИ В ГРУППУ.'
            : 'КЛИЕНТ СИНХРОНИЗАЦИИ НЕ ЗАПУЩЕН.'}
        </p>
      ) : null}

      {session !== null && !paired && !foreignInstallation ? (
        <div className="group-pairing__form">
          <TerminalField label="КОД ПАРЫ" description="Код выдаёт администратор группы">
            <TerminalInput
              aria-label="Код пары"
              placeholder="XXXX-XXXX"
              value={pairingCode}
              onValueChange={setPairingCode}
            />
          </TerminalField>
          <TerminalField label="ИМЯ УСТРОЙСТВА" description="Как эта сессия видна остальным">
            <TerminalInput
              aria-label="Имя устройства"
              placeholder={screenId}
              value={deviceName}
              onValueChange={setDeviceName}
            />
          </TerminalField>
          <TerminalButton
            className="ops-action ops-action--primary"
            tone="primary"
            disabled={busy || pairingCode.trim().length === 0}
            onClick={() =>
              void run(() =>
                session.pair(pairingCode, deviceName.trim().length === 0 ? screenId : deviceName),
              )
            }
          >
            [P] ПОДКЛЮЧИТЬСЯ К ГРУППЕ
          </TerminalButton>

          {/* The other way in, and the one that has to exist first: a group
              nobody has created yet issues no codes. It is folded away because
              it is done once per production, and because the field below asks
              for a deployment secret that has no business being on screen
              while an operator is simply pairing. */}
          <TerminalButton
            className="ops-action"
            onClick={() => {
              setCreatingGroup((value) => !value);
              setBootstrapSecret('');
            }}
          >
            {creatingGroup ? '[N] СКРЫТЬ СОЗДАНИЕ ГРУППЫ' : '[N] СОЗДАТЬ НОВУЮ ГРУППУ'}
          </TerminalButton>

          {creatingGroup ? (
            <>
              <TerminalField
                label="ИМЯ НОВОЙ ГРУППЫ"
                description="Как группа названа для всех её устройств"
              >
                <TerminalInput
                  aria-label="Имя новой группы"
                  placeholder="ШТАБ"
                  value={newGroupName}
                  onValueChange={setNewGroupName}
                />
              </TerminalField>
              <TerminalField
                label="СЕКРЕТ РАЗВЁРТЫВАНИЯ"
                description="Задан на control plane. Не сохраняется на этом устройстве и стирается при закрытии окна"
              >
                <TerminalInput
                  type="password"
                  aria-label="Секрет развёртывания"
                  autoComplete="off"
                  spellCheck={false}
                  value={bootstrapSecret}
                  onValueChange={setBootstrapSecret}
                />
              </TerminalField>
              <TerminalButton
                className="ops-action ops-action--primary"
                tone="primary"
                disabled={
                  busy || newGroupName.trim().length === 0 || bootstrapSecret.trim().length === 0
                }
                onClick={() =>
                  void run(() =>
                    session.createGroup({
                      name: newGroupName,
                      deviceName: deviceName.trim().length === 0 ? screenId : deviceName,
                      bootstrapSecret,
                    }),
                  ).then((created) => {
                    if (!created) return;
                    setBootstrapSecret('');
                    setCreatingGroup(false);
                  })
                }
              >
                [N] СОЗДАТЬ ГРУППУ
              </TerminalButton>
            </>
          ) : null}
        </div>
      ) : null}

      {paired && !foreignInstallation && session !== null ? (
        <GroupAdministration
          admin={admin}
          busy={busy}
          groupName={connection.groupName ?? ''}
          grant={grant}
          pairingRole={pairingRole}
          renameDraft={renameDraft}
          onPairingRoleChange={setPairingRole}
          onRenameDraftChange={setRenameDraft}
          onIssueCode={() => void run(() => session.createPairingCode(pairingRole)).then(setGrant)}
          onRename={() =>
            void run(() => session.renameGroup(renameDraft)).then((renamed) => {
              if (renamed) setRenameDraft('');
            })
          }
        />
      ) : null}

      {connection.devices.length === 0 ? null : (
        <section className="group-pairing__devices">
          <h3>УСТРОЙСТВА ГРУППЫ</h3>
          {connection.devices.map((device) => {
            const lock = demotionLock(device, connection);
            return (
              <article key={device.deviceId}>
                <span>
                  <strong>{device.name || device.deviceId}</strong>
                  <small>
                    {deviceRoleLabel(device.role)} · {device.status}
                    {device.deviceId === connection.leaderDeviceId ? ' · ГЛАВНАЯ' : ''}
                  </small>
                  {admin && lock !== '' ? (
                    <small className="group-pairing__hint">{lock}</small>
                  ) : null}
                </span>
                {/* Only an administrator may move the leader, change a role or
                    revoke a device; the controls are disabled rather than
                    hidden, so an operator learns the command exists and does
                    not apply to their role. */}
                <div className="group-pairing__device-controls">
                  <TerminalSelect<DeviceRole>
                    className="group-pairing__role"
                    label={`Роль устройства ${device.name || device.deviceId}`}
                    value={device.role}
                    disabled={busy || !admin || session === null}
                    options={[
                      { value: 'ADMIN', label: deviceRoleLabel('ADMIN') },
                      { value: 'EDITOR', label: deviceRoleLabel('EDITOR'), disabled: lock !== '' },
                      { value: 'VIEWER', label: deviceRoleLabel('VIEWER'), disabled: lock !== '' },
                    ]}
                    onValueChange={(role) => {
                      if (session !== null && role !== device.role) {
                        void run(() => session.setDeviceRole(device.deviceId, role));
                      }
                    }}
                  />
                  <TerminalButton
                    size="small"
                    className="ops-action"
                    disabled={busy || !admin || session === null}
                    onClick={() => {
                      if (session !== null) void run(() => session.setLeader(device.deviceId));
                    }}
                  >
                    [G] ГЛАВНАЯ
                  </TerminalButton>
                  <TerminalButton
                    size="small"
                    tone="critical"
                    className="ops-action"
                    disabled={
                      busy ||
                      !admin ||
                      session === null ||
                      device.deviceId === connection.session?.deviceId
                    }
                    onClick={() => {
                      if (session !== null) void run(() => session.revoke(device.deviceId));
                    }}
                  >
                    [X] ОТОЗВАТЬ
                  </TerminalButton>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {connection.presence.length === 0 ? null : (
        <section className="group-pairing__presence">
          <h3>ПРИСУТСТВИЕ</h3>
          {connection.presence.map((entry) => (
            <article key={entry.deviceId}>
              <strong>{entry.deviceId}</strong>
              <small>{entry.status}</small>
              <small>{entry.activeScreen || '—'}</small>
              <small>
                {entry.clockOffsetMs} MS / {entry.latencyMs} MS
              </small>
            </article>
          ))}
        </section>
      )}

      {connection.failure === '' ? null : (
        <p className="group-pairing__failure" role="status">
          {connection.failure}
        </p>
      )}
    </TerminalDialog>
  );
}

/**
 * Why this device cannot be demoted right now, or `''` when it can.
 *
 * The control plane refuses two demotions outright, under the membership lock
 * and not by a read-then-write: a group never loses its last administrator, and
 * the leader of a group under `LEADER` authority is never demoted out of
 * `ADMIN` (`durable-runtime.ts`, `setDeviceRole`). Both are decidable from what
 * this dialog already shows, and `ListDevices` answers exactly the active
 * memberships the server counts, so the option is closed here rather than
 * offered and refused.
 *
 * **This is an affordance and never a guard.** The roster is as current as the
 * last event or call made it, and nothing about a disabled option reaches the
 * server. What refuses a demotion is the statement that performs it; a refusal
 * that gets through lands on `connection.failure` and is printed at the foot of
 * this dialog.
 */
function demotionLock(device: GroupDevice, connection: ConnectionState): string {
  if (connection.authority === 'leader' && device.deviceId === connection.leaderDeviceId) {
    return 'ПЕРЕДАЙТЕ ГЛАВНУЮ СЕССИЮ ДРУГОМУ УСТРОЙСТВУ, ЧТОБЫ ПОНИЗИТЬ ЭТО';
  }
  if (
    device.role === 'ADMIN' &&
    connection.devices.filter((candidate) => candidate.role === 'ADMIN').length === 1
  ) {
    return 'В ГРУППЕ ДОЛЖЕН ОСТАТЬСЯ ХОТЯ БЫ ОДИН АДМИНИСТРАТОР';
  }
  return '';
}

/**
 * What an administrator does to the group itself: rename it, and issue the code
 * the next device pairs with (R27).
 *
 * Both calls the control plane refuses to anyone but an active administrator,
 * so both controls are disabled for anyone else -- disabled rather than absent,
 * because an operator who cannot see the command cannot find out that it exists
 * and that their role is what stands between them and it. The disabling is an
 * affordance: the server checks the same thing again and its refusal is printed
 * at the foot of the dialog.
 */
function GroupAdministration({
  admin,
  busy,
  grant,
  groupName,
  pairingRole,
  renameDraft,
  onIssueCode,
  onPairingRoleChange,
  onRename,
  onRenameDraftChange,
}: {
  readonly admin: boolean;
  readonly busy: boolean;
  readonly grant: PairingCodeGrant | null;
  readonly groupName: string;
  readonly pairingRole: PairingRole;
  readonly renameDraft: string;
  readonly onIssueCode: () => void;
  readonly onPairingRoleChange: (role: PairingRole) => void;
  readonly onRename: () => void;
  readonly onRenameDraftChange: (name: string) => void;
}) {
  const nextName = renameDraft.trim();
  return (
    <section className="group-pairing__admin">
      <h3>УПРАВЛЕНИЕ ГРУППОЙ</h3>
      {admin ? null : (
        <p className="group-pairing__hint">
          ЭТИМИ КОМАНДАМИ РАСПОРЯЖАЕТСЯ АДМИНИСТРАТОР ГРУППЫ. ПОПРОСИТЕ ЕГО ПОВЫСИТЬ ЭТО УСТРОЙСТВО.
        </p>
      )}
      <TerminalField label="НОВОЕ ИМЯ ГРУППЫ" description="Имя видят все устройства группы">
        <TerminalInput
          aria-label="Новое имя группы"
          placeholder={groupName}
          disabled={!admin}
          value={renameDraft}
          onValueChange={onRenameDraftChange}
        />
      </TerminalField>
      <TerminalButton
        className="ops-action"
        disabled={busy || !admin || nextName.length === 0 || nextName === groupName}
        onClick={onRename}
      >
        [R] ПЕРЕИМЕНОВАТЬ ГРУППУ
      </TerminalButton>

      <TerminalField
        label="РОЛЬ ДЛЯ НОВОГО УСТРОЙСТВА"
        description="Код подключает одно устройство с этой ролью; администратора назначают повышением"
      >
        <TerminalSelect<PairingRole>
          label="Роль для нового устройства"
          value={pairingRole}
          disabled={!admin}
          options={[
            { value: 'EDITOR', label: deviceRoleLabel('EDITOR') },
            { value: 'VIEWER', label: deviceRoleLabel('VIEWER') },
          ]}
          onValueChange={onPairingRoleChange}
        />
      </TerminalField>
      <TerminalButton className="ops-action" disabled={busy || !admin} onClick={onIssueCode}>
        [C] ВЫПУСТИТЬ КОД ПАРЫ
      </TerminalButton>

      {grant === null ? null : (
        <p className="group-pairing__code" role="status">
          <strong>{grant.code}</strong>
          {/* The deadline is not decoration. A pairing code lives ten minutes by
              default, and one shown without it is one an operator is still
              reading out after the server has forgotten it -- which presents as
              "the code is wrong" rather than as "the code is old". */}
          <small>
            {deviceRoleLabel(grant.role)} · {expiryLabel(grant.expiresAtMs)}
          </small>
        </p>
      )}
    </section>
  );
}

/** When an issued code stops working, in the operator's own locale. */
function expiryLabel(expiresAtMs: number): string {
  if (expiresAtMs === 0) return 'СРОК НЕ УКАЗАН';
  const time = dateTimeFormat({
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(expiresAtMs));
  return `ДЕЙСТВУЕТ ДО ${time}`;
}

function ConnectionSummary({ connection }: { readonly connection: ConnectionState }) {
  const capabilities = connection.capabilities;
  return (
    <dl className="ops-definition-list">
      <div>
        <dt>СОСТОЯНИЕ</dt>
        <dd>{connectionModeLabel(connection.mode)}</dd>
      </div>
      <div>
        <dt>ГРУППА</dt>
        <dd>{connection.groupName ?? '—'}</dd>
      </div>
      <div>
        <dt>УСТРОЙСТВО</dt>
        <dd>
          {connection.session === undefined
            ? '—'
            : `${connection.session.deviceId} / ${deviceRoleLabel(connection.session.role)}`}
        </dd>
      </div>
      <div>
        <dt>АВТОРИТЕТ</dt>
        <dd>
          {connection.authority === undefined ? '—' : authorityModeLabel(connection.authority)}
        </dd>
      </div>
      <div>
        <dt>ГЛАВНАЯ СЕССИЯ</dt>
        <dd>
          {connection.leaderDeviceId === undefined || connection.leaderDeviceId === ''
            ? '—'
            : connection.leaderDeviceId}
        </dd>
      </div>
      <div>
        <dt>ЧАСЫ</dt>
        <dd>
          {connection.clock.sampledAt === ''
            ? 'НЕ ИЗМЕРЕНЫ'
            : `СДВИГ ${connection.clock.offsetMs} MS / ЗАДЕРЖКА ${connection.clock.latencyMs} MS`}
        </dd>
      </div>
      <div>
        <dt>БАЗА</dt>
        {/* The installation identity, so an operator who is told the database
            is not the expected one can read which one answered and compare it
            with the deployment. It names a database and opens nothing. */}
        <dd>
          {capabilities === undefined || capabilities.installationId === ''
            ? '—'
            : capabilities.installationId}
        </dd>
      </div>
      <div>
        <dt>ВОЗМОЖНОСТИ</dt>
        <dd>{capabilityList(capabilities)}</dd>
      </div>
    </dl>
  );
}

/**
 * Every address this device holds for the group, and what each of them is.
 *
 * A group may be reachable over the set's LAN and over the internet at once,
 * and the two planes answer differently about the same group: the near one
 * admits a realtime socket and the far one does not. Showing one line for the
 * connection made the second probe look like a correction of the first. The
 * address is on every line because it is the fact an operator needs and the one
 * this surface never showed -- a screen that is behind is a question about which
 * plane it is following.
 *
 * Nothing is rendered when there is no link, which is a local-only session or
 * one with no address configured; the note above already says so.
 */
function ControlPlaneLinks({ links }: { readonly links: readonly ControlPlaneLinkState[] }) {
  if (links.length === 0) return null;
  return (
    <section className="group-pairing__links">
      <h3>СВЯЗИ С ГРУППОЙ</h3>
      {links.map((link) => (
        <article key={link.linkId}>
          <span>
            <strong>{link.baseUrl}</strong>
            <small>
              {link.role === 'primary' ? 'ОСНОВНАЯ' : 'ЗАПАСНАЯ'} ·{' '}
              {realtimeStatusToken(link.status)} ·{' '}
              {link.admitted
                ? realtimeStatusLabel(link.status)
                : 'ДРУГАЯ БАЗА CONTROL PLANE — СВЯЗЬ НЕ ИСПОЛЬЗУЕТСЯ'}
            </small>
            <small>{capabilityList(link.capabilities)}</small>
          </span>
        </article>
      ))}
    </section>
  );
}

/** What one control plane answered, in the register the rest of the dialog uses. */
function capabilityList(capabilities: ControlPlaneCapabilities | undefined): string {
  if (capabilities === undefined) return '—';
  return (
    [
      capabilities.deviceLifecycle ? 'DEVICE-LIFECYCLE' : '',
      capabilities.sync ? 'SYNC' : '',
      capabilities.realtimeAdmission ? 'REALTIME' : '',
      capabilities.settings ? 'SETTINGS' : '',
      capabilities.materials ? 'MATERIALS' : '',
    ]
      .filter((entry) => entry !== '')
      .join(' · ') || 'НЕТ'
  );
}
