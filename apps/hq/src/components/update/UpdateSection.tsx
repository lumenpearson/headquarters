'use client';

import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { TerminalButton, TerminalSwitch } from '@gremuchaya/ui/primitives';

import { t, useAppLocale } from '@/application/localization/locale';
import { localizedSettingDescription } from '@/application/localization/settingLocalization';
import { useBooleanSetting } from '@/application/personalization/useSetting';
import type { AppUpdateState } from '@/application/update/AppUpdateService';
import type { AppUpdatePort } from '@/application/update/appUpdatePort';
import { useAppUpdate } from '@/application/update/useAppUpdate';
import { useAppVersion } from '@/application/update/useAppVersion';
import { Panel } from '@/components/operations/OpsUi';
import { Setting } from '@/components/settings/SchemaSetting';
import { useOperationsStore } from '@/state/operationsStore';

type UpdateAction = 'check' | 'download' | 'pause' | 'resume' | 'cancel' | 'install';

/**
 * Which actions apply from a given status. `checking` and `installing` offer
 * none -- both are busy states the operator waits out, the state line above
 * already says which -- and `downloading` has no state line of its own
 * (there is no `update.state.downloading` id in the catalogue): the progress
 * line reporting a percent already says it is under way.
 */
function actionsFor(status: AppUpdateState['status']): readonly UpdateAction[] {
  switch (status) {
    case 'idle':
    case 'upToDate':
    case 'error':
    case 'unavailable':
      return ['check'];
    case 'available':
      return ['download'];
    case 'downloading':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'ready':
      return ['install'];
    case 'checking':
    case 'installing':
      return [];
  }
}

function stateLine(state: AppUpdateState): string | null {
  switch (state.status) {
    case 'idle':
      return t('update.state.idle');
    case 'checking':
      return t('update.state.checking');
    case 'upToDate':
      return t('update.state.upToDate');
    case 'available':
      return t('update.state.available');
    case 'paused':
      return t('update.state.paused');
    case 'ready':
      return t('update.state.ready');
    case 'installing':
      return t('update.state.installing');
    case 'error':
      return t('update.state.error', { message: state.message });
    case 'downloading':
    case 'unavailable':
      return null;
  }
}

function progressLine(state: AppUpdateState): string | null {
  if (state.status !== 'downloading' && state.status !== 'paused') return null;
  return state.percent === null
    ? t('update.progressUnknown')
    : t('update.progress', { percent: state.percent });
}

/**
 * The maintenance surface: check/download/pause/resume/cancel/install driven
 * by `useAppUpdate`, plus the two startup switches it reconciles
 * (`startup.launchOnLogin`) or simply reads once at mount
 * (`startup.autoUpdate`, see that hook's own doc). Placed as the last panel
 * of the settings screen (`SettingsScreen.tsx`'s `settingsSections`).
 *
 * `port` is a test-only escape hatch: real call sites never pass it, and
 * `useAppUpdate` resolves the desktop adapter itself in that case -- `null`
 * on the web build, where this renders `update.unavailable` and disables
 * every control rather than hiding the section or pretending it works.
 */
export function UpdateSection({ port }: { readonly port?: AppUpdatePort | null } = {}) {
  const locale = useAppLocale();
  const update = useAppUpdate(port);
  const version = useAppVersion();
  const applySettingsPatch = useOperationsStore((state) => state.applySettingsPatch);
  const launchOnLoginDraft = useBooleanSetting('startup.launchOnLogin');
  const autoUpdateDraft = useBooleanSetting('startup.autoUpdate');

  const available = update.state.status !== 'unavailable';
  const actions = actionsFor(update.state.status);
  const availableVersion = 'version' in update.state ? update.state.version : null;
  const notes = 'notes' in update.state ? update.state.notes : undefined;

  const launchOnLoginDefinition = getSettingDefinition('startup.launchOnLogin');
  const autoUpdateDefinition = getSettingDefinition('startup.autoUpdate');

  return (
    <Panel
      title={t('update.heading')}
      eyebrow="MAINTENANCE / DESKTOP ONLY"
      className="settings-update"
    >
      {available ? null : <p className="settings-update__unavailable">{t('update.unavailable')}</p>}
      <dl className="ops-definition-list">
        <div>
          <dt>{t('update.currentVersion')}</dt>
          <dd>{version ?? '—'}</dd>
        </div>
        {availableVersion === null ? null : (
          <div>
            <dt>{t('update.availableVersion')}</dt>
            <dd>{availableVersion}</dd>
          </div>
        )}
      </dl>
      {stateLine(update.state) === null ? null : (
        <p className="settings-update__state" aria-live="polite">
          {stateLine(update.state)}
        </p>
      )}
      {progressLine(update.state) === null ? null : (
        // Not `aria-live`: a percent updates far more often than the state
        // line above changes, and announcing every chunk would drown out
        // the transitions (checking / available / ready / error) that
        // actually matter. The percent is still on screen for anyone
        // reading visually.
        <p className="settings-update__progress">{progressLine(update.state)}</p>
      )}
      {notes === undefined ? null : (
        <p className="settings-update__notes">
          {t('update.notes')}: {notes}
        </p>
      )}
      <div className="settings-draft-actions">
        {actions.includes('check') ? (
          <TerminalButton
            className="ops-action"
            disabled={!available}
            onClick={update.checkForUpdate}
          >
            {t('update.check')}
          </TerminalButton>
        ) : null}
        {actions.includes('download') ? (
          <TerminalButton className="ops-action ops-action--primary" onClick={update.download}>
            {t('update.download')}
          </TerminalButton>
        ) : null}
        {actions.includes('pause') ? (
          <TerminalButton className="ops-action" onClick={update.pause}>
            {t('update.pause')}
          </TerminalButton>
        ) : null}
        {actions.includes('resume') ? (
          <TerminalButton className="ops-action" onClick={update.resume}>
            {t('update.resume')}
          </TerminalButton>
        ) : null}
        {actions.includes('cancel') ? (
          <TerminalButton className="ops-action ops-action--danger" onClick={update.cancel}>
            {t('update.cancel')}
          </TerminalButton>
        ) : null}
        {actions.includes('install') ? (
          <TerminalButton className="ops-action ops-action--primary" onClick={update.install}>
            {t('update.install')}
          </TerminalButton>
        ) : null}
      </div>
      {launchOnLoginDefinition === undefined ? null : (
        <Setting
          label="АВТОЗАПУСК ПРИ ВХОДЕ"
          detail={`${launchOnLoginDefinition.scope.toUpperCase()} · ${localizedSettingDescription(launchOnLoginDefinition, locale)}`}
          notice={
            update.autostart.error === null
              ? undefined
              : `${t('update.state.error', { message: update.autostart.error })}`
          }
        >
          <TerminalSwitch
            label="Автозапуск при входе"
            className="settings-toggle"
            checked={launchOnLoginDraft}
            disabled={!available}
            onCheckedChange={(value) =>
              applySettingsPatch([{ id: 'startup.launchOnLogin', value }])
            }
          />
        </Setting>
      )}
      {autoUpdateDefinition === undefined ? null : (
        <Setting
          label="АВТООБНОВЛЕНИЕ"
          detail={`${autoUpdateDefinition.scope.toUpperCase()} · ${localizedSettingDescription(autoUpdateDefinition, locale)}`}
        >
          <TerminalSwitch
            label="Автообновление"
            className="settings-toggle"
            checked={autoUpdateDraft}
            disabled={!available}
            onCheckedChange={(value) => applySettingsPatch([{ id: 'startup.autoUpdate', value }])}
          />
        </Setting>
      )}
    </Panel>
  );
}
