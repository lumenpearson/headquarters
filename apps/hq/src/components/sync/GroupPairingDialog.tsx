'use client';

import {
  TerminalButton,
  TerminalDialog,
  TerminalField,
  TerminalInput,
} from '@gremuchaya/ui/primitives';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  authorityModeLabel,
  connectionModeLabel,
  deviceRoleLabel,
  type ConnectionState,
} from '@/application/sync/connection';
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
 * The group this session belongs to, and how to join or leave one (R27).
 *
 * Everything shown here is read from the `connection` slice, which
 * `ControlPlaneSession` is the only writer of; the buttons call that session
 * rather than the transport. With no session -- local-only, or no control
 * plane configured -- the dialog still opens and says so, because an operator
 * who cannot see why a screen is alone cannot fix it.
 */
export function GroupPairingDialog() {
  const [open, setOpen] = useState(false);
  const connection = useOperationsStore((state) => state.connection);
  const screenId = useOperationsStore((state) => state.production.screenId);
  const [pairingCode, setPairingCode] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);
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

  useContextMenuAction(
    'shell.groupPairing',
    useCallback(() => setOpen(true), []),
  );

  const run = (operation: () => Promise<unknown>) => {
    setBusy(true);
    void operation().finally(() => setBusy(false));
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
      onOpenChange={setOpen}
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
                  if (session !== null) run(() => session.leave());
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
              run(() =>
                session.pair(pairingCode, deviceName.trim().length === 0 ? screenId : deviceName),
              )
            }
          >
            [P] ПОДКЛЮЧИТЬСЯ К ГРУППЕ
          </TerminalButton>
        </div>
      ) : null}

      {connection.devices.length === 0 ? null : (
        <section className="group-pairing__devices">
          <h3>УСТРОЙСТВА ГРУППЫ</h3>
          {connection.devices.map((device) => (
            <article key={device.deviceId}>
              <span>
                <strong>{device.name || device.deviceId}</strong>
                <small>
                  {deviceRoleLabel(device.role)} · {device.status}
                  {device.deviceId === connection.leaderDeviceId ? ' · ГЛАВНАЯ' : ''}
                </small>
              </span>
              {/* Only an administrator may move the leader or revoke a device;
                  the buttons are disabled rather than hidden, so an operator
                  learns the command exists and does not apply to their role. */}
              <TerminalButton
                size="small"
                className="ops-action"
                disabled={busy || !admin || session === null}
                onClick={() => {
                  if (session !== null) run(() => session.setLeader(device.deviceId));
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
                  if (session !== null) run(() => session.revoke(device.deviceId));
                }}
              >
                [X] ОТОЗВАТЬ
              </TerminalButton>
            </article>
          ))}
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
        <dd>
          {capabilities === undefined
            ? '—'
            : [
                capabilities.deviceLifecycle ? 'DEVICE-LIFECYCLE' : '',
                capabilities.sync ? 'SYNC' : '',
                capabilities.realtimeAdmission ? 'REALTIME' : '',
                capabilities.settings ? 'SETTINGS' : '',
                capabilities.materials ? 'MATERIALS' : '',
              ]
                .filter((entry) => entry !== '')
                .join(' · ') || 'НЕТ'}
        </dd>
      </div>
    </dl>
  );
}
