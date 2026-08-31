'use client';

import {
  TerminalButton,
  TerminalDialog,
  TerminalField,
  TerminalInput,
  TerminalSelect,
  TerminalSwitch,
} from '@gremuchaya/ui/primitives';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';

import { dateTimeFormat } from '@/application/localization/intl';
import { t, useAppLocale } from '@/application/localization/locale';
import { useBooleanSetting } from '@/application/personalization/useSetting';
import {
  authorityModeLabel,
  connectionModeLabel,
  controlPlaneAddressSourceLabel,
  deviceRoleLabel,
  realtimeStatusLabel,
  realtimeStatusToken,
  type ConnectionState,
  type ControlPlaneCapabilities,
  type ControlPlaneLinkState,
  type DeviceRole,
  type GroupDevice,
  type PairingRole,
  type PresenceEntry,
} from '@/application/sync/connection';
import type { PairingCodeGrant } from '@/application/sync/controlPlanePort';
import {
  clearManualControlPlaneAddress,
  readManualControlPlaneAddress,
  writeManualControlPlaneAddress,
} from '@/application/sync/manualControlPlaneAddress';
import { useContextMenuAction } from '@/components/contextMenus/ContextMenuRuntime';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

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
 * The screen an unpaired device is on inside the join-or-create wizard
 * (session 2026-08-30 continued, R27 rework). `choose` is where the wizard
 * always opens: it decides which of the two paths below applies, and neither
 * path is a fact about the fields it holds -- an operator either already has
 * a code, or is the one about to issue the first one. `join` and `create`
 * each end in the one submit their path needs, which is why the whole path is
 * two actions deep: choosing a path is the first, submitting the step it led
 * to is the second. Every field a step reads is lifted into
 * {@link GroupPairingDialog} rather than owned by the step itself, so
 * `onBack` never discards what the operator already typed.
 */
type PairingPathStep = 'choose' | 'join' | 'create';

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
  // The one subscription this whole surface needs: every string below reads
  // `t` directly rather than taking its own `useAppLocale`, because none of
  // the components between here and a leaf field are memoized -- a locale
  // change re-renders this function and its entire returned tree together.
  useAppLocale();
  const [open, setOpen] = useState(false);
  const connection = useOperationsStore((state) => state.connection);
  const screenId = useOperationsStore((state) => state.production.screenId);
  const [pairingCode, setPairingCode] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [wizardStep, setWizardStep] = useState<PairingPathStep>('choose');
  const [newGroupName, setNewGroupName] = useState('');
  /*
   * The deployment's bootstrap secret, for as long as the operator is typing it
   * and no longer. It is deliberately component state: the store is persisted
   * to `localStorage`, broadcast over the screen bus and copied into diagnostic
   * reports, and none of those may ever carry it. `changeOpen` below clears it
   * when the dialog closes, and the field itself is not rendered until the
   * operator reaches the `create` step.
   */
  const [bootstrapSecret, setBootstrapSecret] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [pairingRole, setPairingRole] = useState<PairingRole>('EDITOR');
  /* The issued code, held here for the same reason as the secret above. */
  const [grant, setGrant] = useState<PairingCodeGrant | null>(null);
  /*
   * The manual address field. Read from `manualControlPlaneAddress` when the
   * dialog opens rather than kept in sync with it continuously: it is a draft
   * an operator is editing, and a store that overwrote it on every external
   * change would erase a half-typed address the moment another window saved
   * one. Synced from the opener callback below rather than from an effect
   * keyed on `open` -- `openGroupPairing` is the one path that actually opens
   * this dialog, and setting state there is a response to that call rather
   * than a state update running during an effect's own body.
   */
  const [addressDraft, setAddressDraft] = useState('');
  const [addressFeedback, setAddressFeedback] = useState('');
  const localOnly = useBooleanSetting('general.localOnly');
  const session = useSyncExternalStore(
    subscribeControlPlaneSession,
    currentControlPlaneSession,
    // The server renders no connection; "nothing connected" is the honest
    // snapshot and matches what the client shows before the runtime mounts.
    () => null,
  );

  useEffect(() => {
    const opener = () => {
      setOpen(true);
      setAddressDraft(readManualControlPlaneAddress().join(', '));
      setAddressFeedback('');
    };
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
    useCallback(() => {
      setOpen(true);
      setAddressDraft(readManualControlPlaneAddress().join(', '));
      setAddressFeedback('');
    }, []),
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
      title={t('pairing.dialog.title')}
      description={t('pairing.dialog.description')}
      className="group-pairing"
      footer={
        <div className="group-pairing__actions flex flex-wrap gap-hq-2">
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
              {t('pairing.action.forgetAndRepair')}
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
                {t('pairing.action.leaveGroup')}
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
                {t('pairing.action.forgetPair')}
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
          {t('pairing.foreignInstallation.body')}
        </p>
      ) : null}

      {session === null ? (
        <ControlPlaneAddressForm
          connection={connection}
          localOnly={localOnly}
          addressDraft={addressDraft}
          addressFeedback={addressFeedback}
          onAddressDraftChange={setAddressDraft}
          onSave={() => {
            const outcome = writeManualControlPlaneAddress(addressDraft);
            if (!outcome.ok) {
              setAddressFeedback(outcome.message);
              return;
            }
            setAddressDraft(outcome.addresses.join(', '));
            setAddressFeedback(t('pairing.address.saved'));
          }}
          onClear={() => {
            clearManualControlPlaneAddress();
            setAddressDraft('');
            setAddressFeedback('');
          }}
          onLocalOnlyChange={(next) =>
            operationsStore
              .getState()
              .applySettingsPatch([{ id: 'general.localOnly', value: next }])
          }
        />
      ) : null}

      {session !== null && !paired && !foreignInstallation ? (
        <GroupJoinWizard
          step={wizardStep}
          busy={busy}
          screenId={screenId}
          pairingCode={pairingCode}
          deviceName={deviceName}
          newGroupName={newGroupName}
          bootstrapSecret={bootstrapSecret}
          onPairingCodeChange={setPairingCode}
          onDeviceNameChange={setDeviceName}
          onNewGroupNameChange={setNewGroupName}
          onBootstrapSecretChange={setBootstrapSecret}
          onChooseJoin={() => setWizardStep('join')}
          onChooseCreate={() => setWizardStep('create')}
          onBack={() => setWizardStep('choose')}
          onSubmitJoin={() =>
            void run(() =>
              session.pair(pairingCode, deviceName.trim().length === 0 ? screenId : deviceName),
            )
          }
          onSubmitCreate={() =>
            void run(() =>
              session.createGroup({
                name: newGroupName,
                deviceName: deviceName.trim().length === 0 ? screenId : deviceName,
                bootstrapSecret,
              }),
            ).then((created) => {
              if (!created) return;
              setBootstrapSecret('');
              setWizardStep('choose');
            })
          }
        />
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
          <h3>{t('pairing.devices.heading')}</h3>
          {connection.devices.map((device) => {
            const lock = demotionLock(device, connection);
            const presence = connection.presence.find(
              (entry) => entry.deviceId === device.deviceId,
            );
            return (
              <article key={device.deviceId}>
                <span>
                  <strong>{device.name || device.deviceId}</strong>
                  <small>
                    {deviceRoleLabel(device.role)} · {device.status}
                    {device.deviceId === connection.leaderDeviceId
                      ? ` · ${t('pairing.devices.leaderBadge')}`
                      : ''}
                  </small>
                  <small>{devicePresenceLabel(presence)}</small>
                  {admin && lock !== '' ? (
                    <small className="group-pairing__hint m-0 text-hq-text-2 text-hq-xs tracking-[0.06em]">
                      {lock}
                    </small>
                  ) : null}
                </span>
                {/* Only an administrator may move the leader, change a role or
                    revoke a device; the controls are disabled rather than
                    hidden, so an operator learns the command exists and does
                    not apply to their role. */}
                <div className="group-pairing__device-controls">
                  <TerminalSelect<DeviceRole>
                    className="group-pairing__role"
                    label={t('pairing.devices.roleLabel', {
                      device: device.name || device.deviceId,
                    })}
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
                    {t('pairing.devices.makeLeader')}
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
                    {t('pairing.devices.revoke')}
                  </TerminalButton>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {connection.presence.length === 0 ? null : (
        <section className="group-pairing__presence">
          <h3>{t('pairing.presence.heading')}</h3>
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
 * The three ways an operator leaves local-only from this dialog: type an
 * address, flip the setting that gates it, or read where the address the
 * runtime already tried came from (R27 follow-up).
 *
 * Rendered exactly while `session === null`, which in this application's own
 * runtime is exactly local-only or no address configured at all -- the state
 * this whole surface exists to get an operator out of. Kept as one component
 * because the three read one another: the switch is pointless while no
 * address is reachable, the source line explains why a save might still leave
 * the client local-only (a project file or build variable can rank below the
 * field but a broken override cannot be fixed from here), and the field is
 * the one of the three sources this dialog can actually write.
 *
 * Context, not a wizard step (session 2026-08-30 continued): the address and
 * its state answer "can this device reach a control plane at all", which is a
 * question in force whether or not the operator is about to join or create a
 * group, so it is shown alongside the wizard rather than as a screen inside it.
 */
function ControlPlaneAddressForm({
  addressDraft,
  addressFeedback,
  connection,
  localOnly,
  onAddressDraftChange,
  onClear,
  onLocalOnlyChange,
  onSave,
}: {
  readonly addressDraft: string;
  readonly addressFeedback: string;
  readonly connection: ConnectionState;
  readonly localOnly: boolean;
  readonly onAddressDraftChange: (value: string) => void;
  readonly onClear: () => void;
  readonly onLocalOnlyChange: (next: boolean) => void;
  readonly onSave: () => void;
}) {
  return (
    <div className="group-pairing__address grid gap-hq-2 mt-hq-3">
      <p className="group-pairing__note m-0 text-hq-text-2 text-hq-xs tracking-[0.08em]">
        {connection.mode === 'local-only'
          ? t('pairing.address.noteLocalOnly')
          : t('pairing.address.noteNotRunning')}
      </p>
      <TerminalField
        label={t('pairing.address.fieldLabel')}
        description={t('pairing.address.fieldDescription')}
      >
        <TerminalInput
          aria-label={t('pairing.address.fieldAriaLabel')}
          placeholder="http://192.168.10.5:4100"
          value={addressDraft}
          onValueChange={onAddressDraftChange}
        />
      </TerminalField>
      <div className="group-pairing__actions flex flex-wrap gap-hq-2">
        <TerminalButton
          className="ops-action ops-action--primary"
          tone="primary"
          disabled={addressDraft.trim().length === 0}
          onClick={onSave}
        >
          {t('pairing.address.save')}
        </TerminalButton>
        <TerminalButton className="ops-action" onClick={onClear}>
          {t('pairing.address.clear')}
        </TerminalButton>
      </div>
      {addressFeedback === '' ? null : (
        <p
          className="group-pairing__hint m-0 text-hq-text-2 text-hq-xs tracking-[0.06em]"
          role="status"
        >
          {addressFeedback}
        </p>
      )}
      <p className="group-pairing__hint m-0 text-hq-text-2 text-hq-xs tracking-[0.06em]">
        {t('pairing.address.source', {
          source: controlPlaneAddressSourceLabel(connection.addressSource),
        })}
      </p>
      <TerminalSwitch
        label={t('pairing.address.localOnlySwitchLabel')}
        checked={localOnly}
        onCheckedChange={onLocalOnlyChange}
        onLabel={t('pairing.address.localOnlyOn')}
        offLabel={t('pairing.address.localOnlyOff')}
      />
    </div>
  );
}

/**
 * The two ways an unpaired device joins a group, as screens that replace each
 * other rather than fields that all sit on one form (session 2026-08-30
 * continued). `step` is owned by {@link GroupPairingDialog}; this component
 * only decides which of the three step bodies to render and where to move
 * focus when that decision changes.
 *
 * Focus follows every step change but the first render: nothing was stepped
 * away from the moment a session first becomes available, and stealing focus
 * from `TerminalDialog`'s own opening focus at that instant would fight it
 * rather than follow a step the operator actually asked for. `mountedRef`
 * distinguishes the two -- every render after the first is a `step` reached
 * through `onChooseJoin`, `onChooseCreate` or `onBack`, and that is exactly
 * when a keyboard operator needs telling where the surface put them.
 */
function GroupJoinWizard({
  step,
  busy,
  screenId,
  pairingCode,
  deviceName,
  newGroupName,
  bootstrapSecret,
  onPairingCodeChange,
  onDeviceNameChange,
  onNewGroupNameChange,
  onBootstrapSecretChange,
  onChooseJoin,
  onChooseCreate,
  onBack,
  onSubmitJoin,
  onSubmitCreate,
}: {
  readonly step: PairingPathStep;
  readonly busy: boolean;
  readonly screenId: string;
  readonly pairingCode: string;
  readonly deviceName: string;
  readonly newGroupName: string;
  readonly bootstrapSecret: string;
  readonly onPairingCodeChange: (value: string) => void;
  readonly onDeviceNameChange: (value: string) => void;
  readonly onNewGroupNameChange: (value: string) => void;
  readonly onBootstrapSecretChange: (value: string) => void;
  readonly onChooseJoin: () => void;
  readonly onChooseCreate: () => void;
  readonly onBack: () => void;
  readonly onSubmitJoin: () => void;
  readonly onSubmitCreate: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) headingRef.current?.focus();
    mountedRef.current = true;
  }, [step]);

  return (
    <div className="group-pairing__wizard grid gap-hq-2 mt-hq-3" data-wizard-step={step}>
      {step === 'choose' ? (
        <ChoosePathStep
          headingRef={headingRef}
          onChooseJoin={onChooseJoin}
          onChooseCreate={onChooseCreate}
        />
      ) : null}
      {step === 'join' ? (
        <JoinStep
          headingRef={headingRef}
          busy={busy}
          screenId={screenId}
          pairingCode={pairingCode}
          deviceName={deviceName}
          onPairingCodeChange={onPairingCodeChange}
          onDeviceNameChange={onDeviceNameChange}
          onBack={onBack}
          onSubmit={onSubmitJoin}
        />
      ) : null}
      {step === 'create' ? (
        <CreateStep
          headingRef={headingRef}
          busy={busy}
          screenId={screenId}
          deviceName={deviceName}
          newGroupName={newGroupName}
          bootstrapSecret={bootstrapSecret}
          onDeviceNameChange={onDeviceNameChange}
          onNewGroupNameChange={onNewGroupNameChange}
          onBootstrapSecretChange={onBootstrapSecretChange}
          onBack={onBack}
          onSubmit={onSubmitCreate}
        />
      ) : null}
    </div>
  );
}

/**
 * The wizard's first screen and the only one with no back affordance -- it is
 * what a back button on any other step returns to. The one decision this step
 * asks for is the one that splits the rest of the path: a device either
 * already holds a code issued elsewhere, or is about to issue the first one.
 */
function ChoosePathStep({
  headingRef,
  onChooseJoin,
  onChooseCreate,
}: {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onChooseJoin: () => void;
  readonly onChooseCreate: () => void;
}) {
  return (
    <section
      className="group-pairing__step group-pairing__step--choose grid gap-hq-2"
      aria-live="polite"
      aria-atomic="true"
    >
      <h3 ref={headingRef} tabIndex={-1}>
        {t('pairing.step.choose.heading')}
      </h3>
      <div className="group-pairing__pathChoice grid gap-hq-1">
        <TerminalButton
          className="ops-action ops-action--primary"
          tone="primary"
          data-wizard-action="choose-join"
          onClick={onChooseJoin}
        >
          {t('pairing.step.choose.joinAction')}
        </TerminalButton>
        <p className="group-pairing__hint m-0 text-hq-text-2 text-hq-xs tracking-[0.06em]">
          {t('pairing.step.choose.joinHint')}
        </p>
      </div>
      <div className="group-pairing__pathChoice grid gap-hq-1">
        <TerminalButton
          className="ops-action"
          data-wizard-action="choose-create"
          onClick={onChooseCreate}
        >
          {t('pairing.step.choose.createAction')}
        </TerminalButton>
        <p className="group-pairing__hint m-0 text-hq-text-2 text-hq-xs tracking-[0.06em]">
          {t('pairing.step.choose.createHint')}
        </p>
      </div>
    </section>
  );
}

/** The second and last screen of the "I already have a code" path. */
function JoinStep({
  headingRef,
  busy,
  screenId,
  pairingCode,
  deviceName,
  onPairingCodeChange,
  onDeviceNameChange,
  onBack,
  onSubmit,
}: {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly busy: boolean;
  readonly screenId: string;
  readonly pairingCode: string;
  readonly deviceName: string;
  readonly onPairingCodeChange: (value: string) => void;
  readonly onDeviceNameChange: (value: string) => void;
  readonly onBack: () => void;
  readonly onSubmit: () => void;
}) {
  return (
    <section
      className="group-pairing__step group-pairing__step--join grid gap-hq-2"
      aria-live="polite"
      aria-atomic="true"
    >
      <TerminalButton
        className="ops-action group-pairing__back"
        data-wizard-action="back"
        onClick={onBack}
      >
        {t('pairing.step.back')}
      </TerminalButton>
      <h3 ref={headingRef} tabIndex={-1}>
        {t('pairing.step.join.heading')}
      </h3>
      <TerminalField
        label={t('pairing.field.code.label')}
        description={t('pairing.field.code.description')}
      >
        <TerminalInput
          aria-label={t('pairing.field.code.ariaLabel')}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          value={pairingCode}
          onValueChange={onPairingCodeChange}
        />
      </TerminalField>
      <TerminalField
        label={t('pairing.field.deviceName.label')}
        description={t('pairing.field.deviceName.description')}
      >
        <TerminalInput
          aria-label={t('pairing.field.deviceName.ariaLabel')}
          placeholder={screenId}
          value={deviceName}
          onValueChange={onDeviceNameChange}
        />
      </TerminalField>
      <TerminalButton
        className="ops-action ops-action--primary"
        tone="primary"
        data-wizard-action="submit-join"
        disabled={busy || pairingCode.trim().length === 0}
        onClick={onSubmit}
      >
        {t('pairing.step.join.submit')}
      </TerminalButton>
    </section>
  );
}

/**
 * The second and last screen of the "start the group" path. The one that has
 * to exist first -- a group nobody has created yet issues no codes -- and the
 * only step that ever shows the deployment secret: it has no business on
 * screen while an operator is simply joining with a code someone else issued.
 */
function CreateStep({
  headingRef,
  busy,
  screenId,
  deviceName,
  newGroupName,
  bootstrapSecret,
  onDeviceNameChange,
  onNewGroupNameChange,
  onBootstrapSecretChange,
  onBack,
  onSubmit,
}: {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly busy: boolean;
  readonly screenId: string;
  readonly deviceName: string;
  readonly newGroupName: string;
  readonly bootstrapSecret: string;
  readonly onDeviceNameChange: (value: string) => void;
  readonly onNewGroupNameChange: (value: string) => void;
  readonly onBootstrapSecretChange: (value: string) => void;
  readonly onBack: () => void;
  readonly onSubmit: () => void;
}) {
  return (
    <section
      className="group-pairing__step group-pairing__step--create grid gap-hq-2"
      aria-live="polite"
      aria-atomic="true"
    >
      <TerminalButton
        className="ops-action group-pairing__back"
        data-wizard-action="back"
        onClick={onBack}
      >
        {t('pairing.step.back')}
      </TerminalButton>
      <h3 ref={headingRef} tabIndex={-1}>
        {t('pairing.step.create.heading')}
      </h3>
      <TerminalField
        label={t('pairing.field.groupName.label')}
        description={t('pairing.field.groupName.description')}
      >
        <TerminalInput
          aria-label={t('pairing.field.groupName.ariaLabel')}
          placeholder={t('pairing.field.groupName.placeholder')}
          value={newGroupName}
          onValueChange={onNewGroupNameChange}
        />
      </TerminalField>
      <TerminalField
        label={t('pairing.field.deviceName.label')}
        description={t('pairing.field.deviceName.description')}
      >
        <TerminalInput
          aria-label={t('pairing.field.deviceName.ariaLabel')}
          placeholder={screenId}
          value={deviceName}
          onValueChange={onDeviceNameChange}
        />
      </TerminalField>
      <TerminalField
        label={t('pairing.field.secret.label')}
        description={t('pairing.field.secret.description')}
      >
        <TerminalInput
          type="password"
          aria-label={t('pairing.field.secret.ariaLabel')}
          autoComplete="off"
          spellCheck={false}
          value={bootstrapSecret}
          onValueChange={onBootstrapSecretChange}
        />
      </TerminalField>
      <TerminalButton
        className="ops-action ops-action--primary"
        tone="primary"
        data-wizard-action="submit-create"
        disabled={busy || newGroupName.trim().length === 0 || bootstrapSecret.trim().length === 0}
        onClick={onSubmit}
      >
        {t('pairing.step.create.submit')}
      </TerminalButton>
    </section>
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
    return t('pairing.demotionLock.transferLeader');
  }
  if (
    device.role === 'ADMIN' &&
    connection.devices.filter((candidate) => candidate.role === 'ADMIN').length === 1
  ) {
    return t('pairing.demotionLock.lastAdmin');
  }
  return '';
}

/**
 * What one device's row reads for the screen and clock offset it last
 * reported (F10 presence publish).
 *
 * `undefined` is a device this session has never received a presence row for
 * at all -- one `ListDevices` named but `JoinGroup` has not yet reported for,
 * or a control plane without presence storage. An empty `activeScreen` is a
 * device that joined and reported nothing, which reads the same to an
 * operator: neither names a screen worth showing, so both fall back to the
 * same dash rather than one reading as a device and the other as a fact.
 */
function devicePresenceLabel(presence: PresenceEntry | undefined): string {
  const screen =
    presence === undefined || presence.activeScreen === '' ? '—' : presence.activeScreen;
  const clock =
    presence === undefined
      ? '—'
      : t('pairing.presence.clockOffset', { ms: presence.clockOffsetMs });
  return `${screen} · ${clock}`;
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
      <h3>{t('pairing.admin.heading')}</h3>
      {admin ? null : (
        <p className="group-pairing__hint m-0 text-hq-text-2 text-hq-xs tracking-[0.06em]">
          {t('pairing.admin.nonAdminHint')}
        </p>
      )}
      <TerminalField
        label={t('pairing.admin.renameFieldLabel')}
        description={t('pairing.admin.renameFieldDescription')}
      >
        <TerminalInput
          aria-label={t('pairing.admin.renameFieldAriaLabel')}
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
        {t('pairing.admin.renameSubmit')}
      </TerminalButton>

      <TerminalField
        label={t('pairing.admin.pairingRoleFieldLabel')}
        description={t('pairing.admin.pairingRoleFieldDescription')}
      >
        <TerminalSelect<PairingRole>
          label={t('pairing.admin.pairingRoleSelectLabel')}
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
        {t('pairing.admin.issueCode')}
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
  if (expiresAtMs === 0) return t('pairing.admin.codeNoExpiry');
  const time = dateTimeFormat({
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(expiresAtMs));
  return t('pairing.admin.codeExpiresAt', { time });
}

function ConnectionSummary({ connection }: { readonly connection: ConnectionState }) {
  const capabilities = connection.capabilities;
  return (
    <dl className="ops-definition-list">
      <div>
        <dt>{t('pairing.summary.state')}</dt>
        <dd>{connectionModeLabel(connection.mode)}</dd>
      </div>
      <div>
        <dt>{t('pairing.summary.group')}</dt>
        <dd>{connection.groupName ?? '—'}</dd>
      </div>
      <div>
        <dt>{t('pairing.summary.device')}</dt>
        <dd>
          {connection.session === undefined
            ? '—'
            : `${connection.session.deviceId} / ${deviceRoleLabel(connection.session.role)}`}
        </dd>
      </div>
      <div>
        <dt>{t('pairing.summary.authority')}</dt>
        <dd>
          {connection.authority === undefined ? '—' : authorityModeLabel(connection.authority)}
        </dd>
      </div>
      <div>
        <dt>{t('pairing.summary.leader')}</dt>
        <dd>
          {connection.leaderDeviceId === undefined || connection.leaderDeviceId === ''
            ? '—'
            : connection.leaderDeviceId}
        </dd>
      </div>
      <div>
        <dt>{t('pairing.summary.clock')}</dt>
        <dd>
          {connection.clock.sampledAt === ''
            ? t('pairing.summary.clockNotMeasured')
            : t('pairing.summary.clockReading', {
                offset: connection.clock.offsetMs,
                latency: connection.clock.latencyMs,
              })}
        </dd>
      </div>
      <div>
        <dt>{t('pairing.summary.database')}</dt>
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
        <dt>{t('pairing.summary.capabilities')}</dt>
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
      <h3>{t('pairing.links.heading')}</h3>
      {links.map((link) => (
        <article key={link.linkId}>
          <span>
            <strong>{link.baseUrl}</strong>
            <small>
              {link.role === 'primary' ? t('pairing.links.primary') : t('pairing.links.secondary')}{' '}
              · {realtimeStatusToken(link.status)} ·{' '}
              {link.admitted ? realtimeStatusLabel(link.status) : t('pairing.links.otherDatabase')}
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
      .join(' · ') || t('pairing.capabilities.none')
  );
}
