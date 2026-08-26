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
import { useMemo, useState } from 'react';

import {
  groupOfCategory,
  queryCatalog,
  searchEverySetting,
  settingGroups,
  type SettingGroup,
} from '@/application/personalization/catalog';
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
  querySettingsHistory,
  settingsHistoryOperations,
  settingsHistoryScopes,
  type SettingsHistoryOperation,
  type SettingsHistoryScope,
} from '@/infrastructure/settings/SettingsHistoryLedger';
import { useOperationsStore } from '@/state/operationsStore';

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
      setImportStatus(`[✓] IMPORTED ${file.name.toUpperCase()}`);
    } catch {
      setImportStatus('[!] IMPORT REJECTED: SCHEMA VALIDATION FAILED');
    }
  };
  return (
    <div className="ops-screen settings-screen">
      <header className="ops-screen__title">
        <div>
          <span>LOCAL CONFIGURATION / PERSISTED</span>
          <h1>НАСТРОЙКИ КОНТУРА</h1>
        </div>
        <span className="settings-saved">[✓] ИЗМЕНЕНИЯ СОХРАНЯЮТСЯ ЛОКАЛЬНО</span>
      </header>
      <div className="settings-layout">
        <Panel title="ИНТЕРФЕЙС" eyebrow="DISPLAY / TERMINAL" className="settings-interface">
          <Setting label="КОМПАКТНАЯ НАВИГАЦИЯ" detail="Освобождает пространство рабочей области">
            <TerminalSwitch
              label="Компактная навигация"
              className="settings-toggle"
              checked={state.ui.navCompact}
              onCheckedChange={() => state.toggleNavCompact()}
            />
          </Setting>
          <Setting label="АНИМАЦИИ" detail="Плавные переходы и импульсы событий">
            <TerminalSwitch
              label="Анимации"
              className="settings-toggle"
              checked={state.production.animations}
              onCheckedChange={(value) => state.setProductionOption('animations', value)}
            />
          </Setting>
          <Setting label="CAMERA SAFE" detail="Снижает контраст и яркость для съёмки">
            <TerminalSwitch
              label="Camera safe"
              className="settings-toggle"
              checked={state.production.cameraSafe}
              onCheckedChange={(value) => state.setProductionOption('cameraSafe', value)}
            />
          </Setting>
          <Setting label="CURSOR MODE" detail="Поведение курсора в полноэкранном режиме">
            <TerminalSelect
              label="Cursor mode"
              value={state.production.cursorMode}
              onValueChange={(value) => state.setProductionOption('cursorMode', value)}
              options={[
                { value: 'visible', label: 'VISIBLE' },
                { value: 'auto', label: 'AUTO HIDE' },
                { value: 'hidden', label: 'HIDDEN' },
              ]}
            />
          </Setting>
        </Panel>
        <Panel title="СИМУЛЯЦИЯ" eyebrow="DETERMINISTIC WORLD" className="settings-simulation">
          <Setting label="СОСТОЯНИЕ" detail={`TICK ${state.metrics.simulationStep}`}>
            <TerminalSwitch
              label="Состояние симуляции"
              className="settings-toggle"
              checked={!state.production.paused}
              onCheckedChange={(value) => state.setProductionOption('paused', !value)}
            />
          </Setting>
          <Setting label="СКОРОСТЬ ЧАСОВ" detail="Масштаб локального времени">
            <TerminalSelect
              label="Скорость часов"
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
          <Setting label="РЕЖИМ ЧАСОВ" detail="Фиксированное или системное время">
            <TerminalSelect
              label="Режим часов"
              value={state.production.clockMode}
              onValueChange={(value) => state.setProductionOption('clockMode', value)}
              options={[
                { value: 'fixed', label: 'FIXED' },
                { value: 'real', label: 'SYSTEM REAL' },
              ]}
            />
          </Setting>
          <Setting label="ФИКСИРОВАННОЕ ВРЕМЯ" detail="HH:MM:SS">
            <TerminalInput
              aria-label="Фиксированное время"
              value={state.production.fixedTime}
              onValueChange={(value) => state.setProductionOption('fixedTime', value)}
            />
          </Setting>
        </Panel>
        <Panel title="РАБОЧЕЕ МЕСТО" eyebrow="MULTI MONITOR" className="settings-monitor">
          <Setting label="SCREEN ID" detail="Идентификатор текущего монитора">
            <TerminalSelect
              label="Screen ID"
              value={state.production.screenId}
              onValueChange={(value) => state.setProductionOption('screenId', value)}
              options={['MON-01', 'MON-02', 'MON-03', 'MON-04', 'MON-05', 'MON-06'].map((id) => ({
                value: id,
                label: id,
              }))}
            />
          </Setting>
          <Setting label="AUTO DEMO" detail="Циклическое локальное демо, отключается при вводе">
            <TerminalSwitch
              label="Auto demo"
              className="settings-toggle"
              checked={state.production.autoDemo}
              onCheckedChange={(value) => state.setProductionOption('autoDemo', value)}
            />
          </Setting>
          <TerminalButton className="ops-action" onClick={() => state.toggleProductionPanel(true)}>
            [CTRL+SHIFT+P] PRODUCTION PANEL
          </TerminalButton>
          <TerminalButton
            className="ops-action"
            onClick={() =>
              document.fullscreenElement === null
                ? void document.documentElement.requestFullscreen()
                : void document.exitFullscreen()
            }
          >
            [F] FULLSCREEN / KIOSK
          </TerminalButton>
        </Panel>
        {/*
          The group's own surface, reached the way the production panel is:
          a button in settings beside the switch that governs it. The category
          `groups` renders in the personalization catalogue below, but a
          setting cannot show which group this session is in, who leads it or
          how far the clocks are apart -- and those are what an operator opens
          settings to find out when a screen stops following.
        */}
        <Panel title="СИНХРОНИЗАЦИЯ ГРУППЫ" eyebrow="SYNC / R27" className="settings-group">
          <Setting label="СОСТОЯНИЕ" detail="Связь с control plane">
            <span className="settings-group__mode">
              {connectionModeLabel(state.connection.mode)}
            </span>
          </Setting>
          <Setting label="ГРУППА" detail="Имя группы и роль этого устройства">
            <span className="settings-group__mode">
              {state.connection.groupName ?? '—'}
              {state.connection.session === undefined ? '' : ` / ${state.connection.session.role}`}
            </span>
          </Setting>
          <TerminalButton className="ops-action" onClick={() => openGroupPairing()}>
            [G] ОТКРЫТЬ ПОДКЛЮЧЕНИЕ К ГРУППЕ
          </TerminalButton>
        </Panel>
        <Panel title="ЛОКАЛЬНЫЕ ДАННЫЕ" eyebrow="PERSISTENCE / OFFLINE" className="settings-data">
          <p>
            Конфигурация, подтверждения тревог, выполненные задачи и съёмочные snapshots хранятся в
            профиле браузера. Сеть не требуется.
          </p>
          <dl className="ops-definition-list">
            <div>
              <dt>WORLD STORE</dt>
              <dd>ZUSTAND / NORMALIZED</dd>
            </div>
            <div>
              <dt>PERSISTENCE</dt>
              <dd>LOCALSTORAGE V2</dd>
            </div>
            <div>
              <dt>SYNC</dt>
              <dd>BROADCASTCHANNEL</dd>
            </div>
            <div>
              <dt>EXPORT</dt>
              <dd>STATIC / OFFLINE</dd>
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
                [R] СБРОСИТЬ ОПЕРАТИВНЫЙ МИР
              </TerminalButton>
            }
            title="СБРОСИТЬ ОПЕРАТИВНЫЙ МИР?"
            description="Объекты, дела, тревоги, события и связь вернутся к исходному состоянию сцены. Настройки персонализации это не затронет."
            confirmLabel="[R] СБРОСИТЬ МИР"
            onConfirm={() => {
              state.resetWorld();
              toast.notify({
                title: 'ОПЕРАТИВНЫЙ МИР СБРОШЕН',
                description:
                  'Объекты, дела, тревоги и связь вернулись к исходному состоянию сцены.',
                tone: 'warning',
              });
            }}
          />
        </Panel>
        <Panel
          title="ПЕРСОНАЛИЗАЦИЯ / КАТАЛОГ"
          eyebrow={`SAFE DRAFT / ${draft.changedIds.length} ИЗМЕНЕНИЙ / REV ${state.personalization.published.revision}`}
          className="settings-personalization"
        >
          <div className="settings-catalog-toolbar">
            <TerminalSelect
              label="Раздел персонализации"
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
              label="Категория персонализации"
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
                { value: 'all', label: 'ВСЕ КАТЕГОРИИ РАЗДЕЛА' },
                ...settingCategories.map((category) => ({
                  value: category,
                  label: categoryLabel(category),
                })),
              ]}
            />
            <TerminalInput
              aria-label="Поиск по настройкам"
              placeholder="ИМЯ ИЛИ ОПИСАНИЕ"
              value={catalogSearch}
              onValueChange={setCatalogSearch}
            />
            <TerminalSwitch
              label="Только изменённые"
              checked={changedOnly}
              onCheckedChange={setChangedOnly}
            />
            <span>
              {catalog.definitions.length} ИЗ {catalog.groupTotal} · {catalog.changedInGroup}{' '}
              ИЗМЕНЕНО В РАЗДЕЛЕ
            </span>
          </div>
          {catalog.definitions.map((definition) => (
            <SchemaSetting
              key={definition.id}
              definition={definition}
              value={draft.values[definition.id] ?? definition.defaultValue}
              changed={draft.changedIds.includes(definition.id)}
              onValueChange={(value) => state.applySettingsPatch([{ id: definition.id, value }])}
            />
          ))}
          {catalogSearch.trim().length > 0 && acrossGroups.length > catalog.definitions.length ? (
            <div className="settings-catalog-elsewhere">
              <h3>НАЙДЕНО В ДРУГИХ РАЗДЕЛАХ: {acrossGroups.length - catalog.definitions.length}</h3>
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
                if (catalogCategory !== 'all') state.resetSettingsCategory(catalogCategory);
              }}
            >
              [R] СБРОСИТЬ КАТЕГОРИЮ
            </TerminalButton>
            <TerminalAlertDialog
              trigger={<TerminalButton className="ops-action">[RR] СБРОСИТЬ ВСЁ</TerminalButton>}
              title="СБРОСИТЬ ВСЕ НАСТРОЙКИ?"
              description="Все категории персонализации вернутся к значениям по умолчанию. Отменяется через [CTRL+Z] UNDO."
              confirmLabel="[RR] СБРОСИТЬ ВСЁ"
              onConfirm={() => {
                state.resetAllSettings();
                toast.notify({
                  title: 'НАСТРОЙКИ СБРОШЕНЫ',
                  description:
                    'Все категории вернулись к значениям по умолчанию; [CTRL+Z] отменяет.',
                  tone: 'warning',
                });
              }}
            />
            <TerminalButton className="ops-action" onClick={() => state.discardSettingsDraft()}>
              [ESC] ОТМЕНИТЬ DRAFT
            </TerminalButton>
            <TerminalButton
              className="ops-action"
              disabled={state.personalization.undoStack.length === 0}
              onClick={() => state.undoSettingsDraft()}
            >
              [CTRL+Z] UNDO
            </TerminalButton>
            <TerminalButton
              className="ops-action"
              disabled={state.personalization.redoStack.length === 0}
              onClick={() => state.redoSettingsDraft()}
            >
              [CTRL+Y] REDO
            </TerminalButton>
            <TerminalButton className="ops-action" onClick={exportDraft}>
              [↓] EXPORT JSON
            </TerminalButton>
            <TerminalButton
              className="ops-action"
              onClick={() => document.getElementById('settings-import-file')?.click()}
            >
              [↑] IMPORT JSON
            </TerminalButton>
            <TerminalButton
              className="ops-action ops-action--primary"
              onClick={() => state.publishSettingsDraft()}
            >
              [CTRL+ENTER] ОПУБЛИКОВАТЬ
            </TerminalButton>
          </div>
          <p className="settings-draft-history">
            ИСТОРИЯ DRAFT: {draft.history.length} СОБЫТИЙ · ЛОКАЛЬНЫЙ SCOPE · БЕЗ НЕБЕЗОПАСНЫХ
            CSS/JS
          </p>
          {importStatus === null ? null : <p className="settings-import-status">{importStatus}</p>}
          <TerminalInput
            id="settings-import-file"
            type="file"
            accept="application/json,.json"
            aria-label="Импорт черновика настроек"
            className="settings-import-input"
            onChange={(event) => {
              void importDraft(event.currentTarget.files?.[0]);
              event.currentTarget.value = '';
            }}
          />
        </Panel>
        <Panel
          title="СОЧЕТАНИЯ КЛАВИШ"
          eyebrow="KEYBINDS / НАЖМИТЕ ЛЮБОЕ"
          className="settings-keybinds"
        >
          <KeybindList />
        </Panel>
        <Panel
          title="ИСТОРИЯ НАСТРОЕК"
          eyebrow={
            'LOCAL LEDGER / ' +
            state.personalization.history.length +
            ' СОБЫТИЙ / ' +
            state.personalization.undoStack.length +
            ' UNDO'
          }
          className="settings-history"
        >
          <div className="settings-history-filters">
            <TerminalSelect
              label="Операция истории"
              value={historyOperation}
              onValueChange={(value) => {
                setHistoryOperation(value as SettingsHistoryOperation | 'all');
                setHistoryPageNumber(1);
              }}
              options={[
                { value: 'all', label: 'ВСЕ ОПЕРАЦИИ' },
                ...settingsHistoryOperations.map((operation) => ({
                  value: operation,
                  label: operation.toUpperCase(),
                })),
              ]}
            />
            <TerminalSelect
              label="Охват истории"
              value={historyScope}
              onValueChange={(value) => {
                setHistoryScope(value as SettingsHistoryScope | 'all');
                setHistoryPageNumber(1);
              }}
              options={[
                { value: 'all', label: 'ЛЮБОЙ ОХВАТ' },
                ...settingsHistoryScopes.map((scope) => ({
                  value: scope,
                  label: scope === 'group' ? 'ГРУППОВЫЕ' : 'ТОЛЬКО ЭТА МАШИНА',
                })),
              ]}
            />
            <TerminalSelect
              label="Категория истории"
              value={historyCategory}
              onValueChange={(value) => {
                setHistoryCategory(value as SettingCategory | 'all');
                setHistoryPageNumber(1);
              }}
              options={[
                { value: 'all', label: 'ВСЕ КАТЕГОРИИ' },
                ...settingCategories.map((category) => ({
                  value: category,
                  label: category.toUpperCase(),
                })),
              ]}
            />
            <TerminalInput
              aria-label="Фильтр истории по параметру"
              placeholder="SETTING ID"
              value={historySettingId}
              onValueChange={(value) => {
                setHistorySettingId(value);
                setHistoryPageNumber(1);
              }}
            />
            <TerminalInput
              type="date"
              aria-label="Фильтр истории по дате"
              value={historyDate}
              onValueChange={(value) => {
                setHistoryDate(value);
                setHistoryPageNumber(1);
              }}
            />
            <TerminalSelect
              label="Порядок истории"
              value={historyOrder}
              onValueChange={(value) => {
                setHistoryOrder(value as 'newest' | 'oldest');
                setHistoryPageNumber(1);
              }}
              options={[
                { value: 'newest', label: 'СНАЧАЛА НОВЫЕ' },
                { value: 'oldest', label: 'СНАЧАЛА СТАРЫЕ' },
              ]}
            />
          </div>
          <div className="settings-history-list" aria-live="polite">
            {historyPage.items.length === 0 ? (
              <p className="settings-history-empty">НЕТ СОБЫТИЙ ПО ТЕКУЩЕМУ ФИЛЬТРУ</p>
            ) : (
              historyPage.items.map((entry) => (
                <article className="settings-history-row" key={entry.id}>
                  <div>
                    <strong>{entry.operation.toUpperCase()}</strong>
                    <small>{formatHistoryDate(entry.at)}</small>
                  </div>
                  <p>{entry.changedIds.join(', ') || 'ПУБЛИКАЦИЯ БЕЗ ИЗМЕНЕНИЙ'}</p>
                  <span>{entry.category?.toUpperCase() ?? 'LOCAL'}</span>
                  <TerminalButton
                    className="ops-action"
                    size="small"
                    onClick={() => state.restoreSettingsHistoryEntry(entry.id)}
                  >
                    [↩] В DRAFT
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
              [←] НАЗАД
            </TerminalButton>
            <span>
              СТР. {historyPage.page} / {historyPage.pageCount} · ВСЕГО {historyPage.total}
            </span>
            <TerminalButton
              className="ops-action"
              size="small"
              disabled={historyPage.page >= historyPage.pageCount}
              onClick={() => setHistoryPageNumber(historyPage.page + 1)}
            >
              ВПЕРЁД [→]
            </TerminalButton>
          </div>
          <p className="settings-draft-history">
            ВОССТАНОВЛЕНИЕ ЗАГРУЖАЕТ СОСТОЯНИЕ В ЛОКАЛЬНЫЙ DRAFT; ПУБЛИКАЦИЯ СОЗДАЁТ НОВУЮ РЕВИЗИЮ И
            НЕ ПЕРЕЗАПИСЫВАЕТ ИСТОРИЮ.
          </p>
        </Panel>
        <Panel title="ГОРЯЧИЕ КЛАВИШИ" eyebrow="KEYMAP / TERMINAL" className="settings-keymap">
          {[
            ['1–9', 'ПЕРЕХОД ПО РАЗДЕЛАМ'],
            ['CTRL+K', 'ГЛОБАЛЬНЫЙ ПОИСК'],
            ['CTRL+SHIFT+P', 'PRODUCTION PANEL'],
            ['F', 'FULLSCREEN'],
            ['W', 'WEBCAM ON / OFF'],
            ['SPACE', 'PLAY / PAUSE VIDEO'],
            ['ESC', 'ЗАКРЫТЬ DRAWER / PANEL'],
          ].map(([key, label]) => (
            <div key={key}>
              <kbd>{key}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}
