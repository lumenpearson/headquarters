import {
  getSettingDefinition,
  type SettingsDraft,
  type SettingValue,
} from '@gremuchaya/settings-schema';

import { buildDiagnosticsReport } from '@/application/contextMenus/diagnostics';
import {
  getContentFieldDefinition,
  parseContentKey,
  type ContentOverrides,
} from '@/application/edit/contentFields';
import { readBooleanSetting, readStringSetting } from '@/application/personalization/useSetting';
import { clampPrefilledBody, codeSpan } from '@/application/prefilledUrl';

export interface IssueDraftInput {
  readonly repository: string;
  readonly draft: SettingsDraft;
  /** Domain-content edits (R4), listed after the settings. Absent means none. */
  readonly content?: ContentOverrides;
}

/**
 * Builds a prefilled "new issue" link from an edit-mode draft.
 *
 * This produces a URL rather than calling the GitHub API. An API call would
 * need a token inside the desktop client; a prefilled link needs nothing, the
 * operator stays the author of the eventual issue, and no credential is ever
 * held by this application.
 */
export function buildIssueDraftUrl({ repository, draft, content = {} }: IssueDraftInput): string {
  const contentEntries = Object.entries(content);
  const total = draft.changedIds.length + contentEntries.length;
  if (total === 0) {
    throw new Error('An issue draft needs at least one change; this draft has no changes.');
  }

  const includeDescriptions = readBooleanSetting('github.includeDescriptions');
  // `checklist` gives a reviewer something to tick off change by change, which
  // is what a group reading someone else's afternoon of edits actually does.
  const bullet = readStringSetting('github.changeFormat') === 'checklist' ? '- [ ] ' : '- ';
  const rows = draft.changedIds.map((id) => {
    const value = draft.values[id];
    const description = includeDescriptions ? getSettingDefinition(id)?.description : undefined;
    const suffix = description === undefined ? '' : ` — ${description}`;
    return `${bullet}${codeSpan(id)} → ${codeSpan(formatValue(value))}${suffix}`;
  });
  // Content rows read the same way as setting rows, under their own heading:
  // a reviewer confirming a date is doing a different check than one
  // confirming a theme, and the list should say which is which.
  const contentRows = contentEntries.map(([key, value]) => {
    const target = parseContentKey(key);
    const definition = target === undefined ? undefined : getContentFieldDefinition(target.id);
    const description = includeDescriptions ? definition?.description : undefined;
    const suffix = description === undefined ? '' : ` — ${description}`;
    return `${bullet}${codeSpan(key)} → ${codeSpan(value)}${suffix}`;
  });
  const sections = [
    ...(rows.length === 0 ? [] : [['## Change made in edit mode', '', ...rows]]),
    ...(contentRows.length === 0 ? [] : [['## Content changed in edit mode', '', ...contentRows]]),
  ];

  /*
   * `github.draftOnly` is group scope: with it on, nothing composed here is
   * offered as a finished issue. The link is still built and still opens
   * GitHub's own form -- the operator remains the author either way -- but the
   * title and a closing line say the list is unconfirmed. Without them a group
   * member reading the issue cannot tell an agreed change from one operator's
   * afternoon of experiments.
   */
  const draftOnly = readBooleanSetting('github.draftOnly');

  /*
   * The diagnostic report is attached only when both switches allow it: this
   * one asks for it, and `privacy.copyDiagnostics` is the standing decision
   * about that report leaving the application at all. A setting able to post it
   * past that decision would make the other one a suggestion.
   */
  const diagnostics =
    readBooleanSetting('github.attachDiagnostics') && readBooleanSetting('privacy.copyDiagnostics')
      ? buildDiagnosticsReport()
      : null;

  const body = [
    ...sections.flatMap((section, index) => (index === 0 ? section : ['', ...section])),
    '',
    ...(readBooleanSetting('github.includeBaseRevision')
      ? [`Base revision: ${draft.baseRevision.toString()}`]
      : []),
    ...(diagnostics === null ? [] : ['', '## Diagnostics', '', '```', diagnostics, '```']),
    ...(draftOnly
      ? ['', 'Draft: confirm this list with the group before submitting the issue.']
      : []),
  ].join('\n');

  const url = new URL(`https://github.com/${repository}/issues/new`);
  url.searchParams.set(
    'title',
    `${draftOnly ? '[DRAFT] ' : ''}Personalization: ${total.toString()} change(s)`,
  );
  url.searchParams.set('body', clampPrefilledBody(body, truncationNotice));
  return url.toString();
}

function formatValue(value: SettingValue | undefined): string {
  if (value === undefined) return 'unset';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * `codeSpan` and the clamp moved to `application/prefilledUrl.ts` when R28's
 * translation proposal needed the same two: an operator value has to survive
 * whatever it contains in both links, and a body has to be cut on a code-point
 * boundary in both. The notice stays here because it is what *this* link says.
 */
const truncationNotice = '\n\n_Список обрезан, чтобы ссылка открылась._';
