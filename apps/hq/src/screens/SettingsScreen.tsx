'use client';

import { settingCategories, type SettingCategory } from '@gremuchaya/settings-schema';
import {
  TerminalAlertDialog,
  TerminalButton,
  TerminalInput,
  TerminalSelect,
  TerminalSwitch,
  useTerminalToast,
} from '@gremuchaya/ui/primitives';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  groupOfCategory,
  queryCatalog,
  searchEverySetting,
  settingGroups,
  type SettingGroup,
} from '@/application/personalization/catalog';
import { t } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import { dateTimeFormat } from '@/application/localization/intl';
import { TileVisibility } from '@/components/edit/TileVisibility';
import { KeybindList } from '@/components/keybinds/KeybindList';
import { Panel } from '@/components/operations/OpsUi';
import { openGroupPairing } from '@/components/sync/GroupPairingDialog';
import { connectionModeLabel } from '@/application/sync/connection';
import {
  categoryLabel,
  groupLabel,
  SchemaSetting,
  Setting,
} from '@/components/settings/SchemaSetting';
import {
  settingsSections,
  SettingsCardGrid,
  type SettingsCardTarget,
  type SettingsSectionId,
} from '@/components/settings/SettingsCardGrid';
import {
  groupHistoryOperationLabel,
  useGroupSettingsHistory,
} from '@/components/settings/useGroupSettingsHistory';
import {
  querySettingsHistory,
  settingsHistoryOperations,
  settingsHistoryScopes,
  type SettingsHistoryOperation,
  type SettingsHistoryOrder,
  type SettingsHistoryScope,
} from '@/infrastructure/settings/SettingsHistoryLedger';
import { TranslationEditorSection } from '@/components/settings/TranslationEditorSection';
import { UpdateSection } from '@/components/update/UpdateSection';
import { useStringSetting } from '@/application/personalization/useSetting';
import { useOperationsStore } from '@/state/operationsStore';

/** `state.production.cursorMode`'s three values -- not exported as a type of its own. */
const cursorModeLabelIds: Readonly<Record<'visible' | 'auto' | 'hidden', MessageId>> = {
  visible: 'settings.cursorModeVisible',
  auto: 'settings.cursorModeAutoHide',
  hidden: 'settings.cursorModeHidden',
};

/** `state.production.clockMode`'s two values (the settings screen never offers `'scene'`). */
const clockModeLabelIds: Readonly<Record<'real' | 'fixed', MessageId>> = {
  real: 'settings.clockModeSystem',
  fixed: 'settings.clockModeFixed',
};

const historyOperationLabelIds: Readonly<Record<SettingsHistoryOperation, MessageId>> = {
  patch: 'settings.historyOperationPatch',
  'reset-category': 'settings.historyOperationResetCategory',
  'reset-all': 'settings.historyOperationResetAll',
  import: 'settings.historyOperationImport',
  discard: 'settings.historyOperationDiscard',
  publish: 'settings.historyOperationPublish',
  restore: 'settings.historyOperationRestore',
  undo: 'settings.historyOperationUndo',
  redo: 'settings.historyOperationRedo',
};

const historyScopeLabelIds: Readonly<Record<SettingsHistoryScope, MessageId>> = {
  device: 'settings.historyScopeDevice',
  group: 'settings.historyScopeGroup',
};

const historyOrderLabelIds: Readonly<Record<SettingsHistoryOrder, MessageId>> = {
  newest: 'settings.historyOrderNewest',
  oldest: 'settings.historyOrderOldest',
};

export function SettingsScreen() {
  const state = useOperationsStore((value) => value);
  const toast = useTerminalToast();
  const draft = state.personalization.draft;
  const [catalogGroup, setCatalogGroup] = useState<SettingGroup>('appearance');
  const [catalogCategory, setCatalogCategory] = useState<SettingCategory | 'all'>('all');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [historyOperation, setHistoryOperation] = useState<SettingsHistoryOperation | 'all'>('all');
  const [historyCategory, setHistoryCategory] = useState<SettingCategory | 'all'>('all');
  const [historySettingId, setHistorySettingId] = useState('');
  const [historyScope, setHistoryScope] = useState<SettingsHistoryScope | 'all'>('all');
  const [historyDate, setHistoryDate] = useState('');
  const [historyOrder, setHistoryOrder] = useState<'newest' | 'oldest'>('newest');
  const [historyPageNumber, setHistoryPageNumber] = useState(1);
  /*
   * R29's remaining tail: the group journal mixed an ordinary settings patch
   * and a content field edited from the floating edit panel into the same
   * rows, with nothing that named which was which. `elementId` is the
   * server's own signal for the second kind -- `RESET_ELEMENT` and a content
   * patch both carry one, an ordinary settings patch never does -- so this
   * filters on it rather than inventing a new field.
   */
  const [historyGroupEditModeOnly, setHistoryGroupEditModeOnly] = useState(false);
  /*
   * The scope switch is the source switch too (F8, R29). `device` and `all`
   * describe this machine's ledger and nothing else exists for them to
   * describe. `group` is the one that reaches further: the local rows under it
   * are the changes this machine made that will propagate, and the group's own
   * ledger -- what the server recorded, from every device -- is read beneath
   * them. Two lists rather than one merged one, because the two page
   * differently and cannot honestly be interleaved: see
   * `useGroupSettingsHistory`.
   */
  const groupHistory = useGroupSettingsHistory(historyScope === 'group');
  // R29: the group journal's own filter for "changes made from edit mode
  // specifically" -- an element-scoped entry (a content field, or a
  // `RESET_ELEMENT`) always names `elementId`; an ordinary settings patch
  // never does. Filtered client-side over the page already loaded, since the
  // server pages by keyset and has no server-side filter to ask for instead.
  const groupHistoryEntries = useMemo(
    () =>
      historyGroupEditModeOnly
        ? groupHistory.entries.filter((entry) => entry.elementId !== '')
        : groupHistory.entries,
    [groupHistory.entries, historyGroupEditModeOnly],
  );
  /*
   * The documentation layout (R26 still holds: the column scrolls, the page
   * does not). `layout.settingsNavSide` picks the side the section list sits
   * on; on a narrow window the list hides behind the [≡] toggle and covers the
   * screen instead, so the state below is which section is current and whether
   * that overlay is open.
   */
  const navSide = useStringSetting('layout.settingsNavSide');
  const [navOpen, setNavOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('interface');
  const contentRef = useRef<HTMLDivElement | null>(null);
  /*
   * `layout.settingsLanding`: the screen opens as a grid of cards by default,
   * one per section, with the continuous list this screen used to be the
   * only presentation of still reachable behind the toggle in the header
   * (rendered in both places -- see the header select below -- so either
   * presentation can leave itself). `openTarget` is which card is open, or
   * `null` for the grid; it is component-local rather than a store field,
   * the way `catalogGroup`/`navOpen` already are, because it names nothing
   * that survives a navigation away from this screen (ADR 0006: no route per
   * card).
   */
  const settingsLanding = useStringSetting('layout.settingsLanding');
  const [openTarget, setOpenTarget] = useState<SettingsCardTarget | null>(null);
  const backButtonRef = useRef<HTMLElement | null>(null);
  // Item 6 (H3 review), the way in: focus enters the back button exactly
  // when `openTarget` itself transitions from closed to open, tracked
  // through a ref rather than through `settingsLanding` in the dependency
  // list. Depending on `settingsLanding` fired this same effect merely for
  // switching `layout.settingsLanding` back and forth while a card was
  // already open, stealing focus from whatever the operator was actually
  // using (the landing select itself, most often) even though no card had
  // opened or closed.
  const wasCardOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = openTarget !== null;
    if (!wasCardOpenRef.current && isOpen) backButtonRef.current?.focus();
    wasCardOpenRef.current = isOpen;
  }, [openTarget]);
  // Item 6, the way back: which card to return focus to once the grid
  // remounts, set by the back button below at the moment it closes one and
  // cleared by `SettingsCardGrid` once it has consumed it -- see that
  // component's own doc for why a stale value here would misfire on an
  // unrelated remount.
  const [returnFocusTarget, setReturnFocusTarget] = useState<SettingsCardTarget | null>(null);
  const openCard = (target: SettingsCardTarget) => {
    if (target.kind === 'group') {
      setCatalogGroup(target.group);
      setCatalogCategory('all');
    }
    setOpenTarget(target);
  };
  const closeCard = () => {
    setReturnFocusTarget(openTarget);
    setOpenTarget(null);
  };
  // Item 5 (H3 review): the card landing's own cross-group search, so an
  // operator who does not know which card holds a setting can find it
  // without guessing one of sixteen cards first -- the same failure R6 (see
  // `settings-catalog.spec.ts`) already named for the unified list before
  // cards existed. `searchEverySetting` is the exact function the open
  // personalization panel's own cross-group search already calls
  // (`acrossGroups` below), so a landing search and a panel search reach
  // the same results for the same query.
  const [landingSearch, setLandingSearch] = useState('');
  const landingResults = useMemo(
    () => searchEverySetting(landingSearch, draft.changedIds),
    [landingSearch, draft.changedIds],
  );
  // Whether a section mounts at all. In `unified` mode every section always
  // does, as it always has; in `cards` mode only the open one does -- the
  // grid renders instead of the personalization panel while nothing is open,
  // and a `group` card opens that one panel regardless of which of the seven
  // groups it was, since the panel's own group/category selects still cover
  // all of them.
  const isSectionVisible = (id: SettingsSectionId): boolean => {
    if (settingsLanding !== 'cards') return true;
    if (openTarget === null) return false;
    if (openTarget.kind === 'group') return id === 'personalization';
    return openTarget.id === id;
  };

  useEffect(() => {
    // Cards mode mounts at most one section at a time (or none, while the
    // grid is showing): there is nothing for the scrollspy to watch, and an
    // observer built against elements that do not exist would sit inert
    // rather than simply not run. Re-attaches when the operator switches
    // presentation, since the elements it needs only exist in `unified`.
    if (settingsLanding !== 'unified') return;
    const root = contentRef.current;
    if (root === null || typeof IntersectionObserver === 'undefined') return;
    const sectionOf = new Map<Element, SettingsSectionId>();
    // The top band of the viewport decides the current section, the way a
    // documentation site's sidebar follows the heading under the reader.
    const observer = new IntersectionObserver(
      (entries) => {
        const topmost = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (topmost === undefined) return;
        const section = sectionOf.get(topmost.target);
        if (section !== undefined) setActiveSection(section);
      },
      { root, rootMargin: '0px 0px -55% 0px' },
    );
    for (const section of settingsSections) {
      const element = root.querySelector(`.${section.className}`);
      if (element !== null) {
        sectionOf.set(element, section.id);
        observer.observe(element);
      }
    }
    return () => observer.disconnect();
  }, [settingsLanding]);

  // The overlay covers the screen on a narrow window, so the keyboard needs
  // its own way out; picking a section or the [≡] toggle are the pointer's.
  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [navOpen]);

  const goToSection = (section: (typeof settingsSections)[number]) => {
    setActiveSection(section.id);
    setNavOpen(false);
    contentRef.current
      ?.querySelector(`.${section.className}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const catalog = useMemo(
    () =>
      queryCatalog({
        group: catalogGroup,
        category: catalogCategory,
        search: catalogSearch,
        changedOnly,
        changedIds: draft.changedIds,
      }),
    [catalogCategory, catalogGroup, catalogSearch, changedOnly, draft.changedIds],
  );
  // A grouping creates the case where the operator does not know which group
  // holds what they want, so the same search also answers across all of them.
  const acrossGroups = useMemo(
    () => searchEverySetting(catalogSearch, draft.changedIds, changedOnly),
    [catalogSearch, changedOnly, draft.changedIds],
  );
  const historyPage = useMemo(
    () =>
      querySettingsHistory(state.personalization.history, {
        page: historyPageNumber,
        pageSize: 6,
        order: historyOrder,
        operation: historyOperation === 'all' ? undefined : historyOperation,
        category: historyCategory === 'all' ? undefined : historyCategory,
        settingId: historySettingId.trim() || undefined,
        scope: historyScope === 'all' ? undefined : historyScope,
        date: historyDate || undefined,
      }),
    [
      historyCategory,
      historyScope,
      historyDate,
      historyOperation,
      historyOrder,
      historyPageNumber,
      historySettingId,
      state.personalization.history,
    ],
  );
  const exportDraft = () => {
    const href = URL.createObjectURL(
      new Blob([state.exportSettingsDraft()], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = href;
    link.download = 'gremuchaya-hq-settings-draft.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  };
  const importDraft = async (file: File | undefined) => {
    if (file === undefined) return;
    try {
      state.importSettingsDraft(await file.text());
      setImportStatus(t('settings.importSuccessStatus', { fileName: file.name.toUpperCase() }));
    } catch {
      setImportStatus(t('settings.importRejectedStatus'));
    }
  };
  return (
    <div
      className="ops-screen settings-screen"
      data-nav-side={navSide}
      data-nav-open={navOpen ? 'true' : 'false'}
      data-landing={settingsLanding === 'unified' ? 'unified' : 'cards'}
    >
      <header className="ops-screen__title">
        <div>
          <span>{t('settings.localConfigEyebrow')}</span>
          <h1>{t('settings.screenTitle')}</h1>
        </div>
        {settingsLanding === 'unified' ? (
          <TerminalButton
            className="settings-nav-toggle"
            aria-label={t('settings.sectionsAriaLabel')}
            aria-expanded={navOpen}
            onClick={() => setNavOpen((current) => !current)}
          >
            {t('settings.sectionsToggleButton')}
          </TerminalButton>
        ) : null}
        {/* Reachable in both presentations, so leaving either one never
            depends on first finding it inside the catalogue (R6). */}
        <TerminalSelect
          className="settings-landing-toggle"
          label={t('settings.landingToggleLabel')}
          value={settingsLanding === 'unified' ? 'unified' : 'cards'}
          onValueChange={(value) =>
            state.applySettingsPatch([{ id: 'layout.settingsLanding', value }])
          }
          options={[
            { value: 'cards', label: t('settingOption.layout.settingsLanding.cards') },
            { value: 'unified', label: t('settingOption.layout.settingsLanding.unified') },
          ]}
        />
        <span className="settings-saved">{t('settings.savedLocallyNotice')}</span>
      </header>
      <div className="settings-docs">
        {settingsLanding === 'unified' ? (
          <nav className="settings-docs__nav" aria-label={t('settings.sectionsAriaLabel')}>
            <span className="settings-docs__nav-title">{t('settings.sectionsNavTitle')}</span>
            {settingsSections.map((section) => (
              <TerminalButton
                key={section.id}
                className="settings-docs__link"
                data-active={activeSection === section.id ? 'true' : 'false'}
                onClick={() => goToSection(section)}
              >
                {t(section.labelId)}
              </TerminalButton>
            ))}
          </nav>
        ) : null}
        <div className="settings-docs__content" ref={contentRef}>
          <div className="settings-docs__column">
            {settingsLanding === 'cards' && openTarget === null ? (
              <div className="settings-landing">
                <TerminalInput
                  aria-label={t('settingsLanding.searchLabel')}
                  placeholder={t('settingsLanding.searchPlaceholder')}
                  className="settings-landing-search"
                  value={landingSearch}
                  onValueChange={setLandingSearch}
                />
                {landingSearch.trim().length === 0 ? (
                  <SettingsCardGrid
                    onOpen={openCard}
                    focusTarget={returnFocusTarget}
                    onFocused={() => setReturnFocusTarget(null)}
                  />
                ) : (
                  <Panel
                    title={t('settingsLanding.resultsHeading')}
                    eyebrow={t('settingsLanding.resultsCount', { count: landingResults.length })}
                    className="settings-landing-results"
                  >
                    {landingResults.length === 0 ? (
                      <p className="settings-history-empty">{t('settingsLanding.noResults')}</p>
                    ) : (
                      landingResults.map((definition) => (
                        <SchemaSetting
                          key={definition.id}
                          definition={definition}
                          value={draft.values[definition.id] ?? definition.defaultValue}
                          changed={draft.changedIds.includes(definition.id)}
                          onValueChange={(value) =>
                            state.applySettingsPatch([{ id: definition.id, value }])
                          }
                        />
                      ))
                    )}
                  </Panel>
                )}
              </div>
            ) : (
              <>
                {settingsLanding === 'cards' ? (
                  <TerminalButton
                    ref={backButtonRef}
                    className="ops-action settings-card-back"
                    onClick={closeCard}
                  >
                    {t('settings.backToSectionsButton')}
                  </TerminalButton>
                ) : null}
                {isSectionVisible('interface') ? (
                  <Panel
                    title={t('settingsSection.interface')}
                    eyebrow={t('settings.interfaceEyebrow')}
                    className="settings-interface"
                  >
                    <Setting
                      label={t('settings.compactNavLabel')}
                      detail={t('settings.compactNavDetail')}
                    >
                      <TerminalSwitch
                        label={t('settings.compactNavSwitchLabel')}
                        className="settings-toggle"
                        checked={state.ui.navCompact}
                        onCheckedChange={() => state.toggleNavCompact()}
                      />
                    </Setting>
                    <Setting
                      label={t('settings.animationsLabel')}
                      detail={t('settings.animationsDetail')}
                    >
                      <TerminalSwitch
                        label={t('settings.animationsSwitchLabel')}
                        className="settings-toggle"
                        checked={state.production.animations}
                        onCheckedChange={(value) => state.setProductionOption('animations', value)}
                      />
                    </Setting>
                    <Setting
                      label={t('settings.cameraSafeLabel')}
                      detail={t('settings.cameraSafeDetail')}
                    >
                      <TerminalSwitch
                        label={t('settings.cameraSafeSwitchLabel')}
                        className="settings-toggle"
                        checked={state.production.cameraSafe}
                        onCheckedChange={(value) => state.setProductionOption('cameraSafe', value)}
                      />
                    </Setting>
                    <Setting
                      label={t('settings.cursorModeLabel')}
                      detail={t('settings.cursorModeDetail')}
                    >
                      <TerminalSelect
                        label={t('settings.cursorModeSelectLabel')}
                        value={state.production.cursorMode}
                        onValueChange={(value) => state.setProductionOption('cursorMode', value)}
                        options={(['visible', 'auto', 'hidden'] as const).map((mode) => ({
                          value: mode,
                          label: t(cursorModeLabelIds[mode]),
                        }))}
                      />
                    </Setting>
                  </Panel>
                ) : null}
                {isSectionVisible('simulation') ? (
                  <Panel
                    title={t('settingsSection.simulation')}
                    eyebrow={t('settings.simulationEyebrow')}
                    className="settings-simulation"
                  >
                    <Setting
                      label={t('settings.stateLabel')}
                      detail={t('settings.simulationTickDetail', {
                        tick: state.metrics.simulationStep,
                      })}
                    >
                      <TerminalSwitch
                        label={t('settings.simulationStateSwitchLabel')}
                        className="settings-toggle"
                        checked={!state.production.paused}
                        onCheckedChange={(value) => state.setProductionOption('paused', !value)}
                      />
                    </Setting>
                    <Setting
                      label={t('settings.clockSpeedLabel')}
                      detail={t('settings.clockSpeedDetail')}
                    >
                      <TerminalSelect
                        label={t('settings.clockSpeedSelectLabel')}
                        value={String(state.production.clockSpeed) as '0.5' | '1' | '2' | '5'}
                        onValueChange={(value) =>
                          state.setProductionOption('clockSpeed', Number(value) as 0.5 | 1 | 2 | 5)
                        }
                        options={[
                          { value: '0.5', label: '0.5×' },
                          { value: '1', label: '1×' },
                          { value: '2', label: '2×' },
                          { value: '5', label: '5×' },
                        ]}
                      />
                    </Setting>
                    <Setting
                      label={t('settings.clockModeLabel')}
                      detail={t('settings.clockModeDetail')}
                    >
                      <TerminalSelect
                        label={t('settings.clockModeSelectLabel')}
                        value={state.production.clockMode}
                        onValueChange={(value) => state.setProductionOption('clockMode', value)}
                        options={(['fixed', 'real'] as const).map((mode) => ({
                          value: mode,
                          label: t(clockModeLabelIds[mode]),
                        }))}
                      />
                    </Setting>
                    <Setting
                      label={t('settings.fixedTimeLabel')}
                      detail={t('settings.fixedTimeFormatDetail')}
                    >
                      <TerminalInput
                        aria-label={t('settings.fixedTimeAriaLabel')}
                        value={state.production.fixedTime}
                        onValueChange={(value) => state.setProductionOption('fixedTime', value)}
                      />
                    </Setting>
                  </Panel>
                ) : null}
                {isSectionVisible('workspace') ? (
                  <Panel
                    title={t('settingsSection.workspace')}
                    eyebrow={t('settings.workspaceEyebrow')}
                    className="settings-monitor"
                  >
                    <Setting
                      label={t('settings.screenIdLabel')}
                      detail={t('settings.screenIdDetail')}
                    >
                      <TerminalSelect
                        label={t('settings.screenIdSelectLabel')}
                        value={state.production.screenId}
                        onValueChange={(value) => state.setProductionOption('screenId', value)}
                        options={['MON-01', 'MON-02', 'MON-03', 'MON-04', 'MON-05', 'MON-06'].map(
                          (id) => ({
                            value: id,
                            label: id,
                          }),
                        )}
                      />
                    </Setting>
                    <Setting
                      label={t('settings.autoDemoLabel')}
                      detail={t('settings.autoDemoDetail')}
                    >
                      <TerminalSwitch
                        label={t('settings.autoDemoSwitchLabel')}
                        className="settings-toggle"
                        checked={state.production.autoDemo}
                        onCheckedChange={(value) => state.setProductionOption('autoDemo', value)}
                      />
                    </Setting>
                    <TerminalButton
                      className="ops-action"
                      onClick={() => state.toggleProductionPanel(true)}
                    >
                      {t('settings.productionPanelButton')}
                    </TerminalButton>
                    <TerminalButton
                      className="ops-action"
                      onClick={() =>
                        document.fullscreenElement === null
                          ? void document.documentElement.requestFullscreen()
                          : void document.exitFullscreen()
                      }
                    >
                      {t('settings.fullscreenKioskButton')}
                    </TerminalButton>
                  </Panel>
                ) : null}
                {isSectionVisible('group') ? (
                  <>
                    {/*
          The group's own surface, reached the way the production panel is:
          a button in settings beside the switch that governs it. The category
          `groups` renders in the personalization catalogue below, but a
          setting cannot show which group this session is in, who leads it or
          how far the clocks are apart -- and those are what an operator opens
          settings to find out when a screen stops following.
        */}
                    <Panel
                      title={t('settingsSection.group')}
                      eyebrow={t('settings.groupSyncEyebrow')}
                      className="settings-group"
                    >
                      <Setting
                        label={t('settings.stateLabel')}
                        detail={t('settings.groupConnectionDetail')}
                      >
                        <span className="settings-group__mode">
                          {connectionModeLabel(state.connection.mode)}
                        </span>
                      </Setting>
                      <Setting
                        label={t('settings.groupNameLabel')}
                        detail={t('settings.groupNameDetail')}
                      >
                        <span className="settings-group__mode">
                          {state.connection.groupName ?? '—'}
                          {state.connection.session === undefined
                            ? ''
                            : ` / ${state.connection.session.role}`}
                        </span>
                      </Setting>
                      <TerminalButton className="ops-action" onClick={() => openGroupPairing()}>
                        {t('settings.openGroupPairingButton')}
                      </TerminalButton>
                    </Panel>
                  </>
                ) : null}
                {isSectionVisible('data') ? (
                  <Panel
                    title={t('settingsSection.data')}
                    eyebrow={t('settings.dataEyebrow')}
                    className="settings-data"
                  >
                    <p>{t('settings.dataDescription')}</p>
                    <dl className="ops-definition-list">
                      <div>
                        <dt>{t('settings.dataWorldStoreLabel')}</dt>
                        <dd>{t('settings.dataWorldStoreValue')}</dd>
                      </div>
                      <div>
                        <dt>{t('settings.dataPersistenceLabel')}</dt>
                        <dd>{t('settings.dataPersistenceValue')}</dd>
                      </div>
                      <div>
                        <dt>{t('settings.dataSyncLabel')}</dt>
                        <dd>{t('settings.dataSyncValue')}</dd>
                      </div>
                      <div>
                        <dt>{t('settings.dataExportLabel')}</dt>
                        <dd>{t('settings.dataExportValue')}</dd>
                      </div>
                    </dl>
                    {/*
            Confirmed rather than immediate: this button used to wipe the whole
            simulated world on a single click, and on a shoot day a misclick
            there costs a take. The report afterwards exists because the change
            is spread across every screen -- there is no local place for the
            operator to see that it happened.
          */}
                    <TerminalAlertDialog
                      trigger={
                        <TerminalButton className="ops-action ops-action--danger" tone="critical">
                          {t('settings.resetWorldButton')}
                        </TerminalButton>
                      }
                      title={t('settings.resetWorldDialogTitle')}
                      description={t('settings.resetWorldDialogDescription')}
                      confirmLabel={t('settings.resetWorldConfirmLabel')}
                      onConfirm={() => {
                        state.resetWorld();
                        toast.notify({
                          title: t('settings.resetWorldToastTitle'),
                          description: t('settings.resetWorldToastDescription'),
                          tone: 'warning',
                        });
                      }}
                    />
                  </Panel>
                ) : null}
                {isSectionVisible('personalization') ? (
                  <Panel
                    title={t('settings.personalizationTitle')}
                    eyebrow={`${t('settings.personalizationEyebrowPrefix')} / ${t('settings.draftChangeCount', { count: draft.changedIds.length })} / ${t('settings.personalizationEyebrowRevision', { revision: state.personalization.published.revision })}`}
                    className="settings-personalization"
                  >
                    <div className="settings-catalog-toolbar">
                      <TerminalSelect
                        label={t('settings.catalogGroupSelectLabel')}
                        value={catalogGroup}
                        onValueChange={(value) => {
                          setCatalogGroup(value as SettingGroup);
                          // The category filter belongs to the group it was chosen in;
                          // carrying it across would leave the operator on a section that
                          // selects nothing and looks empty.
                          setCatalogCategory('all');
                        }}
                        options={settingGroups.map((group) => ({
                          value: group,
                          label: groupLabel(group),
                        }))}
                      />
                      <TerminalSelect
                        label={t('settings.catalogCategorySelectLabel')}
                        value={catalogCategory}
                        onValueChange={(value) => {
                          const next = value as SettingCategory | 'all';
                          setCatalogCategory(next);
                          // Choosing a category moves the section to the one that holds
                          // it. The category list stays complete on purpose: a section is
                          // a way of narrowing, and one that could hide a category the
                          // operator was looking for would be worse than no section at
                          // all.
                          if (next !== 'all') setCatalogGroup(groupOfCategory(next));
                        }}
                        options={[
                          { value: 'all', label: t('settings.allCategoriesOption') },
                          ...settingCategories.map((category) => ({
                            value: category,
                            label: categoryLabel(category),
                          })),
                        ]}
                      />
                      <TerminalInput
                        aria-label={t('settingsLanding.searchLabel')}
                        placeholder={t('settingsLanding.searchPlaceholder')}
                        value={catalogSearch}
                        onValueChange={setCatalogSearch}
                      />
                      <TerminalSwitch
                        label={t('settings.changedOnlyLabel')}
                        checked={changedOnly}
                        onCheckedChange={setChangedOnly}
                      />
                      <span>
                        {t('settings.catalogCountSummary', {
                          shown: catalog.definitions.length,
                          total: catalog.groupTotal,
                          changed: catalog.changedInGroup,
                        })}
                      </span>
                    </div>
                    {/*
                The same checkbox surface the edit panel offers for `tiles`,
                above the raw `tiles.hiddenIds`/`tiles.hiddenCategories`
                editors below rather than instead of them: an operator who
                knows a tile is called `cases:registry` can still type it, and
                one who does not now has a control that names it. Shown
                whenever the section holding `tiles` is in view and the
                operator is not mid-search -- the same gate the panel uses,
                since a search result is the operator naming one setting.
              */}
                    {catalogSearch.trim().length === 0 &&
                    (catalogCategory === 'tiles' ||
                      (catalogCategory === 'all' && catalogGroup === 'layout')) ? (
                      <TileVisibility />
                    ) : null}
                    {catalog.definitions.map((definition) => (
                      <SchemaSetting
                        key={definition.id}
                        definition={definition}
                        value={draft.values[definition.id] ?? definition.defaultValue}
                        changed={draft.changedIds.includes(definition.id)}
                        onValueChange={(value) =>
                          state.applySettingsPatch([{ id: definition.id, value }])
                        }
                      />
                    ))}
                    {catalogSearch.trim().length > 0 &&
                    acrossGroups.length > catalog.definitions.length ? (
                      <div className="settings-catalog-elsewhere">
                        <h3>
                          {t('settings.foundElsewhereHeading', {
                            count: acrossGroups.length - catalog.definitions.length,
                          })}
                        </h3>
                        {acrossGroups
                          .filter((definition) => !catalog.definitions.includes(definition))
                          .map((definition) => (
                            <SchemaSetting
                              key={definition.id}
                              definition={definition}
                              value={draft.values[definition.id] ?? definition.defaultValue}
                              changed={draft.changedIds.includes(definition.id)}
                              onValueChange={(value) =>
                                state.applySettingsPatch([{ id: definition.id, value }])
                              }
                            />
                          ))}
                      </div>
                    ) : null}
                    <div className="settings-draft-actions">
                      <TerminalButton
                        className="ops-action"
                        disabled={catalogCategory === 'all'}
                        onClick={() => {
                          if (catalogCategory !== 'all')
                            state.resetSettingsCategory(catalogCategory);
                        }}
                      >
                        {t('settings.resetCategoryButton')}
                      </TerminalButton>
                      <TerminalAlertDialog
                        trigger={
                          <TerminalButton className="ops-action">
                            {t('settings.resetAllButton')}
                          </TerminalButton>
                        }
                        title={t('settings.resetAllDialogTitle')}
                        description={t('settings.resetAllDialogDescription')}
                        confirmLabel={t('settings.resetAllButton')}
                        onConfirm={() => {
                          state.resetAllSettings();
                          toast.notify({
                            title: t('settings.resetAllToastTitle'),
                            description: t('settings.resetAllToastDescription'),
                            tone: 'warning',
                          });
                        }}
                      />
                      <TerminalButton
                        className="ops-action"
                        onClick={() => state.discardSettingsDraft()}
                      >
                        {t('settings.discardDraftButton')}
                      </TerminalButton>
                      <TerminalButton
                        className="ops-action"
                        disabled={state.personalization.undoStack.length === 0}
                        onClick={() => state.undoSettingsDraft()}
                      >
                        {t('settings.undoButton')}
                      </TerminalButton>
                      <TerminalButton
                        className="ops-action"
                        disabled={state.personalization.redoStack.length === 0}
                        onClick={() => state.redoSettingsDraft()}
                      >
                        {t('settings.redoButton')}
                      </TerminalButton>
                      <TerminalButton className="ops-action" onClick={exportDraft}>
                        {t('settings.exportJsonButton')}
                      </TerminalButton>
                      <TerminalButton
                        className="ops-action"
                        onClick={() => document.getElementById('settings-import-file')?.click()}
                      >
                        {t('settings.importJsonButton')}
                      </TerminalButton>
                      <TerminalButton
                        className="ops-action ops-action--primary"
                        onClick={() => state.publishSettingsDraft()}
                      >
                        {t('settings.publishButton')}
                      </TerminalButton>
                    </div>
                    <p className="settings-draft-history">
                      {t('settings.draftHistorySummary', {
                        events: t('settings.eventCount', { count: draft.history.length }),
                      })}
                    </p>
                    {importStatus === null ? null : (
                      <p className="settings-import-status">{importStatus}</p>
                    )}
                    <TerminalInput
                      id="settings-import-file"
                      type="file"
                      accept="application/json,.json"
                      aria-label={t('settings.importDraftAriaLabel')}
                      className="settings-import-input"
                      onChange={(event) => {
                        void importDraft(event.currentTarget.files?.[0]);
                        event.currentTarget.value = '';
                      }}
                    />
                  </Panel>
                ) : null}
                {isSectionVisible('keybinds') ? (
                  <Panel
                    title={t('settingsSection.keybinds')}
                    eyebrow={t('settings.keybindsEyebrow')}
                    className="settings-keybinds"
                  >
                    <KeybindList />
                  </Panel>
                ) : null}
                {isSectionVisible('history') ? (
                  <Panel
                    title={t('settingsSection.history')}
                    eyebrow={t('settings.historyEyebrow', {
                      events: t('settings.eventCount', {
                        count: state.personalization.history.length,
                      }),
                      undo: t('settings.undoCount', {
                        count: state.personalization.undoStack.length,
                      }),
                    })}
                    className="settings-history"
                  >
                    <div className="settings-history-filters">
                      <TerminalSelect
                        label={t('settings.historyOperationSelectLabel')}
                        value={historyOperation}
                        onValueChange={(value) => {
                          setHistoryOperation(value as SettingsHistoryOperation | 'all');
                          setHistoryPageNumber(1);
                        }}
                        options={[
                          { value: 'all', label: t('settings.allOperationsOption') },
                          ...settingsHistoryOperations.map((operation) => ({
                            value: operation,
                            label: t(historyOperationLabelIds[operation]),
                          })),
                        ]}
                      />
                      <TerminalSelect
                        label={t('settings.historyScopeSelectLabel')}
                        value={historyScope}
                        onValueChange={(value) => {
                          setHistoryScope(value as SettingsHistoryScope | 'all');
                          setHistoryPageNumber(1);
                        }}
                        options={[
                          { value: 'all', label: t('settings.allScopesOption') },
                          ...settingsHistoryScopes.map((scope) => ({
                            value: scope,
                            label: t(historyScopeLabelIds[scope]),
                          })),
                        ]}
                      />
                      <TerminalSelect
                        label={t('settings.historyCategorySelectLabel')}
                        value={historyCategory}
                        onValueChange={(value) => {
                          setHistoryCategory(value as SettingCategory | 'all');
                          setHistoryPageNumber(1);
                        }}
                        options={[
                          { value: 'all', label: t('settings.allHistoryCategoriesOption') },
                          ...settingCategories.map((category) => ({
                            value: category,
                            label: categoryLabel(category),
                          })),
                        ]}
                      />
                      <TerminalInput
                        aria-label={t('settings.historySettingFilterAriaLabel')}
                        placeholder={t('settings.historySettingFilterPlaceholder')}
                        value={historySettingId}
                        onValueChange={(value) => {
                          setHistorySettingId(value);
                          setHistoryPageNumber(1);
                        }}
                      />
                      <TerminalInput
                        type="date"
                        aria-label={t('settings.historyDateFilterAriaLabel')}
                        value={historyDate}
                        onValueChange={(value) => {
                          setHistoryDate(value);
                          setHistoryPageNumber(1);
                        }}
                      />
                      <TerminalSelect
                        label={t('settings.historyOrderSelectLabel')}
                        value={historyOrder}
                        onValueChange={(value) => {
                          setHistoryOrder(value as SettingsHistoryOrder);
                          setHistoryPageNumber(1);
                        }}
                        options={(['newest', 'oldest'] as const).map((order) => ({
                          value: order,
                          label: t(historyOrderLabelIds[order]),
                        }))}
                      />
                    </div>
                    <div className="settings-history-list" aria-live="polite">
                      {historyPage.items.length === 0 ? (
                        <p className="settings-history-empty">{t('settings.historyEmptyState')}</p>
                      ) : (
                        historyPage.items.map((entry) => (
                          <article className="settings-history-row" key={entry.id}>
                            <div>
                              <strong>{t(historyOperationLabelIds[entry.operation])}</strong>
                              <small>{formatHistoryDate(entry.at)}</small>
                            </div>
                            <p>
                              {entry.changedIds.join(', ') || t('settings.publicationNoChanges')}
                            </p>
                            <span>
                              {entry.category === undefined
                                ? t('settings.localScopeLabel')
                                : categoryLabel(entry.category)}
                            </span>
                            <TerminalButton
                              className="ops-action"
                              size="small"
                              onClick={() => state.restoreSettingsHistoryEntry(entry.id)}
                            >
                              {t('settings.restoreToDraftButton')}
                            </TerminalButton>
                          </article>
                        ))
                      )}
                    </div>
                    <div className="settings-history-pagination">
                      <TerminalButton
                        className="ops-action"
                        size="small"
                        disabled={historyPage.page <= 1}
                        onClick={() => setHistoryPageNumber(historyPage.page - 1)}
                      >
                        {t('settings.paginationBackButton')}
                      </TerminalButton>
                      <span>
                        {t('settings.paginationSummary', {
                          page: historyPage.page,
                          pageCount: historyPage.pageCount,
                          total: historyPage.total,
                        })}
                      </span>
                      <TerminalButton
                        className="ops-action"
                        size="small"
                        disabled={historyPage.page >= historyPage.pageCount}
                        onClick={() => setHistoryPageNumber(historyPage.page + 1)}
                      >
                        {t('settings.paginationForwardButton')}
                      </TerminalButton>
                    </div>
                    <p className="settings-draft-history">{t('settings.historyRestoreNote')}</p>
                    {historyScope !== 'group' ? null : (
                      <section
                        className="settings-history-group"
                        aria-label={t('settings.groupJournalAriaLabel')}
                      >
                        <header className="settings-history-group__head">
                          <h3>{t('settings.groupJournalHeading')}</h3>
                          <span>
                            {groupHistory.status === 'unavailable'
                              ? t('settings.groupJournalUnavailable')
                              : groupHistory.status === 'loading'
                                ? t('settings.groupJournalLoading')
                                : groupHistory.status === 'failed'
                                  ? groupHistory.failure
                                  : t('settings.groupJournalLoaded', {
                                      count: groupHistory.entries.length,
                                      more: groupHistory.hasMore
                                        ? t('settings.groupJournalHasMore')
                                        : t('settings.groupJournalNoMore'),
                                    })}
                          </span>
                        </header>
                        {/*
                    R29: "отдельно — история изменений именно режима
                    редактирования". The rows are one list on the server, so
                    this narrows the same list rather than opening a second
                    one -- an entry an operator edited from the floating panel
                    always names the element it touched, and an ordinary
                    settings patch never does.
                  */}
                        <TerminalSwitch
                          label={t('settings.groupJournalEditModeOnlyLabel')}
                          className="settings-toggle"
                          checked={historyGroupEditModeOnly}
                          onCheckedChange={setHistoryGroupEditModeOnly}
                        />
                        {groupHistoryEntries.length === 0 ? (
                          groupHistory.entries.length === 0 ? null : (
                            <p className="settings-history-empty">
                              {t('settings.groupJournalEditModeEmpty')}
                            </p>
                          )
                        ) : (
                          <div className="settings-history-list" aria-live="polite">
                            {groupHistoryEntries.map((entry) => (
                              <article className="settings-history-row" key={entry.id}>
                                <div>
                                  <strong>{groupHistoryOperationLabel(entry.operation)}</strong>
                                  <small>{formatHistoryDate(entry.at)}</small>
                                </div>
                                <p>
                                  {entry.changedIds.join(', ') ||
                                    entry.elementId ||
                                    t('settings.groupJournalNoParameters')}
                                </p>
                                <span>
                                  {entry.category.toUpperCase() || t('settings.groupScopeLabel')}
                                </span>
                                <span className="settings-history-actor">
                                  {t('settings.groupJournalRevisionActor', {
                                    revision: entry.revision,
                                    actor:
                                      entry.actorDeviceId ||
                                      t('settings.groupJournalUnknownDevice'),
                                  })}
                                </span>
                              </article>
                            ))}
                          </div>
                        )}
                        {/*
                Forward only, and no page number. The server pages by keyset and
                reports neither a previous cursor nor a total, so a "СТР. 2 / 7"
                here would be a count nobody made.
              */}
                        <div className="settings-history-pagination">
                          <TerminalButton
                            className="ops-action"
                            size="small"
                            disabled={groupHistory.status === 'unavailable'}
                            onClick={groupHistory.reload}
                          >
                            {t('settings.groupJournalReloadButton')}
                          </TerminalButton>
                          <span>{t('settings.groupJournalPaginationNote')}</span>
                          <TerminalButton
                            className="ops-action"
                            size="small"
                            disabled={!groupHistory.hasMore}
                            onClick={groupHistory.loadMore}
                          >
                            {t('settings.groupJournalMoreButton')}
                          </TerminalButton>
                        </div>
                      </section>
                    )}
                  </Panel>
                ) : null}
                {isSectionVisible('keymap') ? (
                  <Panel
                    title={t('settingsSection.keymap')}
                    eyebrow={t('settings.keymapEyebrow')}
                    className="settings-keymap"
                  >
                    {(
                      [
                        ['1–9', 'settings.keymapSections'],
                        ['CTRL+K', 'settings.keymapGlobalSearch'],
                        ['CTRL+SHIFT+P', 'settings.keymapProductionPanel'],
                        ['F', 'settings.keymapFullscreen'],
                        ['W', 'settings.keymapWebcamToggle'],
                        ['SPACE', 'settings.keymapPlayPause'],
                        ['ESC', 'settings.keymapCloseDrawer'],
                      ] as const satisfies ReadonlyArray<readonly [string, MessageId]>
                    ).map(([key, labelId]) => (
                      <div key={key}>
                        <kbd>{key}</kbd>
                        <span>{t(labelId)}</span>
                      </div>
                    ))}
                  </Panel>
                ) : null}
                {isSectionVisible('update') ? <UpdateSection /> : null}
                {isSectionVisible('translations') ? <TranslationEditorSection /> : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return dateTimeFormat({ dateStyle: 'short', timeStyle: 'medium' }).format(date);
}
