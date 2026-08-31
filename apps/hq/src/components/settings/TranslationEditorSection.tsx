'use client';

import {
  TerminalAlertDialog,
  TerminalButton,
  TerminalCombobox,
  TerminalInput,
  TerminalScrollArea,
  TerminalTabs,
} from '@gremuchaya/ui/primitives';
import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import { foldCase } from '@/application/localization/intl';
import { t, useTranslate } from '@/application/localization/locale';
import {
  messageIds,
  messagesFor,
  sourceMessageValue,
  tokens,
  type AppLocale,
  type MessageId,
  type MessageParams,
} from '@/application/localization/messages';
import {
  loadTranslationOverrides,
  parseTranslationOverrideFile,
  readTranslationOverrides,
  translationOverrideKey,
  withTranslationOverride,
  writeTranslationOverrides,
  type TranslationOverrideRefusalReason,
  type TranslationOverrides,
} from '@/application/localization/translationOverrides';
import { Panel } from '@/components/operations/OpsUi';

/**
 * The in-app translation editor: a searchable table over the whole message
 * catalogue, one row per id, editing `translationOverrides.ts`'s stored
 * blob. Its own settings section (`SettingsCardGrid.tsx`'s
 * `settingsSections`), not a `string-list` field -- the catalogue is well
 * over a thousand ids, and a comma-joined text input would present that as
 * one unreadable line.
 *
 * ## Staying responsive at catalogue scale
 *
 * {@link catalogueRows} is built once, at module load, from `messageIds` --
 * not per render and not per mount, the same reason `messages.ts` builds its
 * own lookup tables once. Three things then keep the DOM itself bounded
 * regardless of how large the catalogue grows:
 *
 * - The free-text search (`foldCase` substring match against the id and both
 *   built-in texts) narrows {@link catalogueRows} before anything renders.
 * - The result is paginated at {@link pageSize} rows; only the current page
 *   ever mounts a row, so the table never holds more inputs than that
 *   regardless of how many ids match.
 * - The "jump to id" combobox offers only the first 200 of the *already
 *   filtered* rows, so its own popup is bounded too rather than handed the
 *   whole catalogue unfiltered.
 *
 * ## Locale being edited
 *
 * Two locales are in play and answer different questions. `useTranslate()`
 * governs this component's own chrome -- whatever `localization.locale` the
 * operator has the application set to right now. `editLocale` is component
 * state: which locale's override column the table's input column writes to.
 * They are independent on purpose -- an operator reading the application in
 * Russian can still edit the English overrides, and switching the editor's
 * own locale tab must not also switch which language the rest of the
 * application speaks.
 */

const pageSize = 30;
/** Bounds the "jump to id" combobox's popup regardless of catalogue size. */
const maxJumpOptions = 200;

interface CatalogueRow {
  readonly id: MessageId;
  readonly ru: string;
  readonly en: string;
  readonly isToken: boolean;
  readonly isPlural: boolean;
}

function tokenText(id: MessageId): string | undefined {
  return (tokens as Readonly<Partial<Record<MessageId, string>>>)[id];
}

/**
 * Read directly from the catalogue and the token table, never through
 * `translateWith` -- that function prefers the operator's own override, and
 * the whole point of the "RU (source)" / "EN (built-in)" columns is to show
 * what the application ships underneath whatever override is set, so the
 * operator can tell the two apart.
 */
const ruBuiltIn = messagesFor('ru');
const enBuiltIn = messagesFor('en');

const catalogueRows: readonly CatalogueRow[] = messageIds.map((id) => {
  const token = tokenText(id);
  if (token !== undefined) {
    return { id, ru: token, en: token, isToken: true, isPlural: false };
  }
  const source = sourceMessageValue(id);
  return {
    id,
    ru: ruBuiltIn[id] ?? '',
    en: enBuiltIn[id] ?? '',
    isToken: false,
    isPlural: typeof source !== 'string',
  };
});

function matchesSearch(row: CatalogueRow, needle: string): boolean {
  if (needle === '') return true;
  return (
    foldCase(row.id).includes(needle) ||
    foldCase(row.ru).includes(needle) ||
    foldCase(row.en).includes(needle)
  );
}

/**
 * One label per `TranslationOverrideRefusalReason`
 * (`translationOverrides.ts`) -- a `Record` over that exact union so a reason
 * added there and not here is a compiler error, not a row that renders no
 * explanation.
 */
const reasonLabelIds: Readonly<Record<TranslationOverrideRefusalReason, MessageId>> = {
  'unknown-locale': 'translationEditor.reasonUnknownLocale',
  'unknown-id': 'translationEditor.reasonUnknownId',
  'non-catalog-id': 'translationEditor.reasonNonCatalogId',
  'plural-message': 'translationEditor.reasonPluralMessage',
  empty: 'translationEditor.reasonEmpty',
  'too-long': 'translationEditor.reasonTooLong',
  'control-character': 'translationEditor.reasonControlCharacter',
  'bidi-override': 'translationEditor.reasonBidiOverride',
  'placeholder-mismatch': 'translationEditor.reasonPlaceholderMismatch',
  'entry-count-cap': 'translationEditor.reasonEntryCountCap',
};

export function TranslationEditorSection() {
  const translate = useTranslate();
  const [editLocale, setEditLocale] = useState<AppLocale>('ru');
  const [overrides, setOverrides] = useState<TranslationOverrides>({});
  const [refusals, setRefusals] = useState<
    Readonly<Record<string, TranslationOverrideRefusalReason>>
  >({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [jumpValue, setJumpValue] = useState<MessageId | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Deferred rather than a synchronous `setState` in the effect body, the
    // idiom `MaterialAnnotationsPanel.tsx` uses for its own initial read.
    void Promise.resolve().then(() => setOverrides(readTranslationOverrides(window.localStorage)));
  }, []);

  const persist = (next: TranslationOverrides): void => {
    setOverrides(next);
    if (typeof window === 'undefined') return;
    writeTranslationOverrides(window.localStorage, next);
    loadTranslationOverrides(window.localStorage);
  };

  const updateSearch = (value: string): void => {
    setSearch(value);
    setPage(1);
  };

  const commitOverride = (id: MessageId, text: string): void => {
    const key = translationOverrideKey({ locale: editLocale, id });
    const result = withTranslationOverride(overrides, { locale: editLocale, id }, text);
    if (result.kind === 'refused') {
      setRefusals((current) => ({ ...current, [key]: result.reason }));
      return;
    }
    setRefusals((current) => {
      if (!(key in current)) return current;
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
    persist(result.overrides);
  };

  const clearAll = (): void => {
    persist({});
    setRefusals({});
  };

  const exportOverrides = (): void => {
    const prefix = `${editLocale}:`;
    const extracted: Record<string, string> = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (key.startsWith(prefix)) extracted[key.slice(prefix.length)] = value;
    }
    const href = URL.createObjectURL(
      new Blob([JSON.stringify({ locale: editLocale, overrides: extracted }, null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = href;
    link.download = `gremuchaya-hq-translations-${editLocale}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  };

  const importOverrides = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setImportStatus(translate('translationEditor.importMalformedStatus'));
      return;
    }
    const result = parseTranslationOverrideFile(parsed, overrides);
    if (!result.ok) {
      const { refusal } = result;
      setImportStatus(
        refusal.kind === 'malformed'
          ? translate('translationEditor.importMalformedStatus')
          : refusal.kind === 'unknown-locale'
            ? translate('translationEditor.importUnknownLocaleStatus', { locale: refusal.locale })
            : refusal.kind === 'entry-count-cap'
              ? translate('translationEditor.importCapStatus')
              : translate('translationEditor.importEntryRefusedStatus', {
                  id: refusal.id,
                  reason: translate(reasonLabelIds[refusal.reason]),
                }),
      );
      return;
    }
    persist(result.overrides);
    setRefusals({});
    setImportStatus(
      translate('translationEditor.importSuccessStatus', {
        count: result.count,
        locale: result.locale.toUpperCase(),
      }),
    );
  };

  const needle = foldCase(search.trim());
  const filteredRows = useMemo(
    () => catalogueRows.filter((row) => matchesSearch(row, needle)),
    [needle],
  );
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize);
  const jumpOptions = useMemo(
    () => filteredRows.slice(0, maxJumpOptions).map((row) => ({ value: row.id, label: row.id })),
    [filteredRows],
  );

  const countForLocale = (locale: AppLocale): number =>
    Object.keys(overrides).filter((key) => key.startsWith(`${locale}:`)).length;

  return (
    <Panel
      title={translate('settingsSection.translations')}
      eyebrow={translate('translationEditor.eyebrow')}
      // `settings-translations`, matching `settingsSections`'s entry for this
      // id in `SettingsCardGrid.tsx` -- that `className` doubles as the
      // unified column's scroll-anchor selector (`SettingsScreen.tsx`'s
      // `IntersectionObserver`), so the two must agree or the section would
      // never become "active" while scrolled into view.
      className="settings-translations"
    >
      <p className="text-hq-text-2 text-hq-sm m-0">{translate('translationEditor.scopeNotice')}</p>
      <TerminalTabs
        label={translate('translationEditor.localeTabsLabel')}
        value={editLocale}
        onValueChange={setEditLocale}
        tabs={[
          {
            value: 'ru',
            label: translate('translationEditor.localeRu'),
            content: translate('translationEditor.localeSummary', { count: countForLocale('ru') }),
          },
          {
            value: 'en',
            label: translate('translationEditor.localeEn'),
            content: translate('translationEditor.localeSummary', { count: countForLocale('en') }),
          },
        ]}
      />
      <div className="flex flex-wrap items-end gap-hq-3">
        <TerminalInput
          aria-label={translate('translationEditor.searchLabel')}
          placeholder={translate('translationEditor.searchPlaceholder')}
          value={search}
          onValueChange={updateSearch}
        />
        <TerminalCombobox
          label={translate('translationEditor.jumpLabel')}
          placeholder={translate('translationEditor.jumpPlaceholder')}
          emptyLabel={translate('translationEditor.jumpEmptyLabel')}
          value={jumpValue}
          options={jumpOptions}
          onValueChange={(value) => {
            setJumpValue(value);
            if (value !== null) updateSearch(value);
          }}
        />
        <span className="text-hq-text-2 text-hq-xs">
          {translate('translationEditor.resultsSummary', {
            shown: pageRows.length,
            total: filteredRows.length,
          })}
        </span>
      </div>
      {filteredRows.length === 0 ? (
        <p className="text-hq-text-2 text-hq-sm">{translate('translationEditor.noResults')}</p>
      ) : (
        <TerminalScrollArea className="max-h-[420px] border border-hq-line-1">
          <table
            className="w-full border-collapse text-hq-sm"
            aria-label={translate('translationEditor.tableAriaLabel')}
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky top-0 z-10 h-[34px] bg-hq-bg-1 px-hq-3 border-b border-b-hq-line-2 text-hq-text-2 text-hq-xs tracking-[0.08em] uppercase text-left"
                >
                  {translate('translationEditor.columnId')}
                </th>
                <th
                  scope="col"
                  className="sticky top-0 z-10 h-[34px] bg-hq-bg-1 px-hq-3 border-b border-b-hq-line-2 text-hq-text-2 text-hq-xs tracking-[0.08em] uppercase text-left"
                >
                  {translate('translationEditor.columnSourceRu')}
                </th>
                <th
                  scope="col"
                  className="sticky top-0 z-10 h-[34px] bg-hq-bg-1 px-hq-3 border-b border-b-hq-line-2 text-hq-text-2 text-hq-xs tracking-[0.08em] uppercase text-left"
                >
                  {translate('translationEditor.columnBuiltInEn')}
                </th>
                <th
                  scope="col"
                  className="sticky top-0 z-10 h-[34px] bg-hq-bg-1 px-hq-3 border-b border-b-hq-line-2 text-hq-text-2 text-hq-xs tracking-[0.08em] uppercase text-left"
                >
                  {translate('translationEditor.columnOverride', {
                    locale: editLocale.toUpperCase(),
                  })}
                </th>
                <th
                  scope="col"
                  className="sticky top-0 z-10 h-[34px] bg-hq-bg-1 px-hq-3 border-b border-b-hq-line-2 text-hq-text-2 text-hq-xs tracking-[0.08em] uppercase text-left"
                >
                  {translate('translationEditor.columnActions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const key = translationOverrideKey({ locale: editLocale, id: row.id });
                return (
                  <tr
                    key={row.id}
                    data-message-id={row.id}
                    className="border-b border-b-hq-line-0 align-top"
                  >
                    <td className="px-hq-3 py-hq-2 font-mono text-hq-xs text-hq-text-1">
                      {row.id}
                      {row.isToken ? (
                        <span className="ml-hq-2 text-hq-text-2">
                          [{translate('translationEditor.tokenTag')}]
                        </span>
                      ) : null}
                      {row.isPlural ? (
                        <span className="ml-hq-2 text-hq-text-2">
                          [{translate('translationEditor.pluralTag')}]
                        </span>
                      ) : null}
                    </td>
                    <td className="px-hq-3 py-hq-2 text-hq-text-1">{row.ru}</td>
                    <td className="px-hq-3 py-hq-2 text-hq-text-1">{row.en}</td>
                    <td className="px-hq-3 py-hq-2">
                      <OverrideCell
                        id={row.id}
                        translate={translate}
                        value={overrides[key] ?? ''}
                        refusal={refusals[key]}
                        onCommit={(text) => commitOverride(row.id, text)}
                      />
                    </td>
                    <td className="px-hq-3 py-hq-2">
                      <TerminalButton
                        size="small"
                        tone="quiet"
                        data-reset-button=""
                        aria-label={translate('translationEditor.resetAriaLabel', { id: row.id })}
                        disabled={overrides[key] === undefined}
                        onClick={() => commitOverride(row.id, '')}
                      >
                        {translate('translationEditor.resetButton')}
                      </TerminalButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TerminalScrollArea>
      )}
      <div className="flex items-center gap-hq-3">
        <TerminalButton
          size="small"
          disabled={safePage <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          {t('settings.paginationBackButton')}
        </TerminalButton>
        <span className="text-hq-text-2 text-hq-xs">
          {t('settings.paginationSummary', {
            page: safePage,
            pageCount,
            total: filteredRows.length,
          })}
        </span>
        <TerminalButton
          size="small"
          disabled={safePage >= pageCount}
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
        >
          {t('settings.paginationForwardButton')}
        </TerminalButton>
      </div>
      <div className="flex flex-wrap items-center gap-hq-3">
        <TerminalAlertDialog
          trigger={
            <TerminalButton tone="critical" disabled={Object.keys(overrides).length === 0}>
              {translate('translationEditor.clearAllButton')}
            </TerminalButton>
          }
          title={translate('translationEditor.clearAllDialogTitle')}
          description={translate('translationEditor.clearAllDialogDescription')}
          confirmLabel={translate('translationEditor.clearAllConfirmLabel')}
          onConfirm={clearAll}
        />
        <TerminalButton onClick={exportOverrides}>
          {translate('translationEditor.exportButton')}
        </TerminalButton>
        <TerminalButton
          onClick={() => document.getElementById('translation-overrides-import-file')?.click()}
        >
          {translate('translationEditor.importButton')}
        </TerminalButton>
        <TerminalInput
          id="translation-overrides-import-file"
          type="file"
          accept="application/json,.json"
          aria-label={translate('translationEditor.importFileAriaLabel')}
          className="hidden"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            void importOverrides(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
        />
      </div>
      {importStatus === null ? null : (
        <p aria-live="polite" className="text-hq-sm">
          {importStatus}
        </p>
      )}
    </Panel>
  );
}

/**
 * The one field this section holds a draft of, per row -- the same
 * commit-on-Enter-or-blur gesture `ElementTranslation.tsx`'s `CaptionField`
 * uses, so a settings-history-style entry is never written per keystroke.
 * `value` stays whatever the operator typed across a refusal (the parent
 * does not change `overrides` on refusal, so this field's own `value` prop
 * does not move either), so the text that got refused is still there to fix
 * rather than lost.
 */
function OverrideCell({
  id,
  translate,
  value,
  refusal,
  onCommit,
}: {
  readonly id: MessageId;
  readonly translate: (id: MessageId, params?: MessageParams) => string;
  readonly value: string;
  readonly refusal: TranslationOverrideRefusalReason | undefined;
  readonly onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [committed, setCommitted] = useState(value);
  if (value !== committed) {
    setCommitted(value);
    setDraft(value);
  }

  const commit = (): void => {
    const next = draft.trim();
    if (next === value) return;
    onCommit(next);
  };

  return (
    <div className="flex flex-col gap-hq-1 min-w-[220px]">
      <TerminalInput
        aria-label={translate('translationEditor.overrideAriaLabel', { id })}
        data-message-id={id}
        data-override-input=""
        value={draft}
        onValueChange={setDraft}
        onBlur={commit}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
      {refusal === undefined ? null : (
        <p role="alert" data-refusal-reason={refusal} className="m-0 text-hq-critical text-hq-xs">
          {translate('translationEditor.refusedInline', {
            reason: translate(reasonLabelIds[refusal]),
          })}
        </p>
      )}
    </div>
  );
}
