'use client';

import {
  TerminalAlertDialog,
  TerminalButton,
  TerminalCheckbox,
  TerminalCombobox,
  TerminalContextMenu,
  TerminalDialog,
  TerminalField,
  TerminalInput,
  TerminalMenu,
  TerminalNumberField,
  TerminalPopover,
  TerminalProgress,
  TerminalRadioGroup,
  TerminalScrollArea,
  TerminalSeparator,
  TerminalSlider,
  TerminalTabs,
  TerminalToggle,
  TerminalToolbar,
  useTerminalToast,
} from '@gremuchaya/ui/primitives';
import { useState } from 'react';

import { t } from '@/application/localization/locale';
import {
  Drawer,
  EmptyState,
  Gauge,
  Metric,
  Panel,
  ProgressBar,
  SeverityBadge,
  Sparkline,
  StatusBadge,
  Tooltip,
} from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

export function UiGalleryScreen() {
  const state = useOperationsStore((value) => value);
  const toast = useTerminalToast();
  const [fieldValue, setFieldValue] = useState('ЦЕНТР-7');
  const [checkboxValue, setCheckboxValue] = useState(true);
  const [radioValue, setRadioValue] = useState<'alpha' | 'bravo'>('alpha');
  const [numberValue, setNumberValue] = useState<number | null>(42);
  const [sliderValue, setSliderValue] = useState(67);
  const [comboboxValue, setComboboxValue] = useState<'k17' | 'dmc12' | 'fp2' | null>('k17');
  const [tabValue, setTabValue] = useState<'status' | 'history'>('status');
  const [toggleValue, setToggleValue] = useState(false);
  const primitiveMenuItems = [
    {
      id: 'inspect',
      label: t('gallery.menuInspect'),
      shortcut: 'ENTER',
      onSelect: () =>
        toast.notify({
          title: t('gallery.menuInspectedTitle'),
          description: t('gallery.menuInspectedDescription'),
          tone: 'success',
        }),
    },
    {
      id: 'isolate',
      label: t('gallery.menuIsolate'),
      shortcut: 'CTRL+I',
      tone: 'critical' as const,
      onSelect: () =>
        toast.notify({
          title: t('gallery.menuIsolatedTitle'),
          description: t('gallery.menuIsolatedDescription'),
          tone: 'critical',
          priority: 'high',
        }),
    },
  ] as const;

  return (
    <div className="ops-screen ui-gallery-screen">
      <header className="ops-screen__title">
        <div>
          <span>INTERNAL / COMPONENT CATALOG</span>
          <h1>{t('gallery.screenTitle')}</h1>
        </div>
        <StatusBadge status="READY" />
      </header>
      <div className="ui-gallery-layout">
        <Panel title={t('gallery.statusesPanel')} eyebrow="TOKENS / DOMAIN">
          <div className="gallery-row">
            {(
              [
                'ACTIVE',
                'READY',
                'NORMAL',
                'WATCHED',
                'SIGNAL_LOST',
                'ALERT',
                'CRITICAL',
                'ARCHIVED',
              ] as const
            ).map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
          </div>
          <div className="gallery-row">
            {(['info', 'normal', 'warning', 'critical'] as const).map((severity) => (
              <SeverityBadge key={severity} severity={severity} />
            ))}
          </div>
        </Panel>
        <Panel title={t('gallery.metricsPanel')} eyebrow="DATA / READOUT">
          <div className="metric-grid metric-grid--four">
            <Metric label="OBJECTS" value="32" />
            <Metric label="READY" value="87%" tone="ok" />
            <Metric label="WARNING" value="04" tone="warning" />
            <Metric label="CRITICAL" value="01" tone="critical" />
          </div>
        </Panel>
        <Panel title={t('gallery.progressPanel')} eyebrow="VISUAL / ASCII">
          <ProgressBar value={72} label="OPERATION" tone="warning" />
          <ProgressBar value={91} label="SIGNAL" tone="ok" />
          <Sparkline values={[20, 42, 31, 56, 49, 78, 63, 91]} label={t('gallery.demoChart')} />
        </Panel>
        <Panel title={t('gallery.gaugePanel')} eyebrow="GAUGE / SVG">
          <Gauge value={87} label="READINESS" detail="THRESHOLD 80%" />
        </Panel>
        <Panel title={t('gallery.actionsPanel')} eyebrow="CONTROLS / STATES">
          <div className="gallery-actions">
            <TerminalButton className="ops-action">[N] NORMAL</TerminalButton>
            <TerminalButton className="ops-action ops-action--primary" tone="primary">
              [ENTER] PRIMARY
            </TerminalButton>
            <TerminalButton className="ops-action ops-action--danger" tone="critical">
              [!] DANGER
            </TerminalButton>
            <TerminalButton className="ops-action" disabled>
              [X] DISABLED
            </TerminalButton>
            <Tooltip label={t('gallery.tooltipDemo')}>
              <TerminalButton className="ops-action">[?] TOOLTIP</TerminalButton>
            </Tooltip>
          </div>
        </Panel>
        <Panel title="BASE UI PRIMITIVES" eyebrow="HEADLESS / TERMINAL CONTRACT">
          <div className="gallery-actions">
            <TerminalDialog
              title={t('gallery.dialogTitle')}
              eyebrow="DIALOG / BASE UI"
              description={t('gallery.dialogDescription')}
              trigger={<TerminalButton className="ops-action">[DIALOG] OPEN</TerminalButton>}
              footer={<TerminalButton tone="primary">{t('gallery.confirm')}</TerminalButton>}
            >
              <p>FOCUS TRAP / ESCAPE / RESTORE / PORTAL: READY</p>
            </TerminalDialog>
            <TerminalMenu
              label={t('gallery.menuLabel')}
              trigger={<TerminalButton className="ops-action">[MENU] ACTIONS</TerminalButton>}
              items={primitiveMenuItems}
            />
            <TerminalContextMenu
              label={t('gallery.contextMenuLabel')}
              trigger={<TerminalButton className="ops-action">[CONTEXT] TARGET</TerminalButton>}
              items={primitiveMenuItems}
            />
            <TerminalButton
              className="ops-action ops-action--primary"
              tone="primary"
              onClick={() =>
                toast.notify({
                  title: t('gallery.toastReadyTitle'),
                  description: 'TOAST VIEWPORT / F6 / DISMISS',
                  tone: 'success',
                })
              }
            >
              [TOAST] READY
            </TerminalButton>
          </div>
        </Panel>
        <Panel
          title={t('gallery.formPanel')}
          eyebrow="FORM / COMPOSITE"
          className="gallery-form-panel"
        >
          <TerminalScrollArea
            className="gallery-panel-scroll"
            contentClassName="gallery-primitives"
          >
            <TerminalField
              label={t('field.sector')}
              description={t('gallery.sectorFieldDescription')}
            >
              <TerminalInput value={fieldValue} onValueChange={setFieldValue} />
            </TerminalField>
            <div className="gallery-inline-control">
              <TerminalCheckbox
                label={t('gallery.secureChannelLabel')}
                checked={checkboxValue}
                onCheckedChange={setCheckboxValue}
              />
              <span>{t('gallery.secureChannelSpan')}</span>
            </div>
            <TerminalRadioGroup
              label={t('gallery.accessGroupLabel')}
              value={radioValue}
              onValueChange={setRadioValue}
              options={[
                { value: 'alpha', label: t('gallery.optionAlpha') },
                { value: 'bravo', label: t('gallery.optionBravo') },
              ]}
            />
            <TerminalNumberField
              label={t('gallery.loadLabel')}
              value={numberValue}
              min={0}
              max={100}
              onValueChange={setNumberValue}
            />
            <TerminalSlider
              label={t('gallery.intensityLabel')}
              value={sliderValue}
              onValueChange={setSliderValue}
            />
            <TerminalCombobox
              label={t('gallery.observedObjectLabel')}
              value={comboboxValue}
              onValueChange={setComboboxValue}
              options={[
                { value: 'k17', label: t('gallery.objectK17') },
                { value: 'dmc12', label: t('gallery.objectDmc12') },
                { value: 'fp2', label: t('gallery.objectFp2') },
              ]}
            />
          </TerminalScrollArea>
        </Panel>
        <Panel
          title={t('gallery.compositePanel')}
          eyebrow="TABS / TOOLBAR / OVERLAY"
          className="gallery-composite-panel"
        >
          <TerminalScrollArea
            className="gallery-panel-scroll"
            contentClassName="gallery-composites"
          >
            <TerminalTabs
              label={t('gallery.diagnosticsLabel')}
              value={tabValue}
              onValueChange={setTabValue}
              tabs={[
                {
                  value: 'status',
                  label: t('gallery.statusTab'),
                  content: 'STATUS / READY / 100%',
                },
                {
                  value: 'history',
                  label: t('gallery.historyTab'),
                  content: 'EVENTS / 24 / SYNCED',
                },
              ]}
            />
            <TerminalProgress
              label={t('gallery.syncProgressLabel')}
              value={sliderValue}
              tone="success"
            />
            <TerminalToolbar
              label={t('gallery.standCommandsLabel')}
              actions={[
                {
                  id: 'scan',
                  label: 'SCAN',
                  shortcut: 'S',
                  onPress: () =>
                    toast.notify({ title: t('gallery.scanCompleteToast'), tone: 'success' }),
                },
                {
                  id: 'lock',
                  label: 'LOCK',
                  shortcut: 'L',
                  onPress: () =>
                    toast.notify({ title: t('gallery.contourLockedToast'), tone: 'warning' }),
                },
              ]}
            />
            <div className="gallery-actions">
              <TerminalToggle
                label="[TOGGLE] GRID"
                pressed={toggleValue}
                onPressedChange={setToggleValue}
              />
              <TerminalPopover
                title={t('gallery.popoverTitle')}
                description={t('gallery.popoverDescription')}
                trigger={<TerminalButton className="ops-action">[POPOVER] NODE</TerminalButton>}
              >
                SIGNAL 92% / LATENCY 18 MS
              </TerminalPopover>
              <TerminalAlertDialog
                title={t('gallery.confirmOperationTitle')}
                description={t('gallery.confirmOperationDescription')}
                confirmLabel={t('gallery.confirm')}
                onConfirm={() =>
                  toast.notify({ title: t('gallery.operationConfirmedToast'), tone: 'critical' })
                }
                trigger={
                  <TerminalButton className="ops-action ops-action--danger">
                    [ALERT] OPEN
                  </TerminalButton>
                }
              />
            </div>
            <TerminalSeparator />
            <TerminalScrollArea className="gallery-scroll-demo">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index}>EVENT / {String(index + 1).padStart(2, '0')} / NOMINAL</div>
              ))}
            </TerminalScrollArea>
          </TerminalScrollArea>
        </Panel>
        <Panel title={t('gallery.emptyStatePanel')} eyebrow="EMPTY / FALLBACK">
          <EmptyState>{t('gallery.emptyStateText')}</EmptyState>
        </Panel>
        <Panel title="DRAWER" eyebrow="OVERLAY / LOCAL">
          <TerminalButton
            tone="primary"
            className="ops-action ops-action--primary"
            onClick={() => state.openDrawer('alert', 'AL-101')}
          >
            {t('gallery.openExample')}
          </TerminalButton>
          {state.ui.drawer === null ? null : (
            <small>
              DRAWER ACTIVE: {state.ui.drawer.kind} / {state.ui.drawer.id}
            </small>
          )}
        </Panel>
        <Panel title={t('gallery.typographyPanel')} eyebrow="MONO / CYRILLIC">
          <div className="gallery-type">
            <h1>ОПЕРАТИВНЫЙ ШТАБ</h1>
            <h2>ЗАЩИЩЁННЫЙ КОНТУР</h2>
            <h3>ABCDEFGHIJKLMNOPQRSTUVWXYZ</h3>
            <p>АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ</p>
            <code>0123456789 / [] {} &lt;&gt; :: // -- ++</code>
          </div>
        </Panel>
      </div>
      {false ? (
        <Drawer title="" eyebrow="" onClose={() => undefined}>
          unused
        </Drawer>
      ) : null}
    </div>
  );
}
