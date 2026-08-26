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
  url.searchParams.set('body', clampBody(body));
  return url.toString();
}

function formatValue(value: SettingValue | undefined): string {
  if (value === undefined) return 'unset';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * Renders `text` as a markdown code span that survives whatever it contains.
 *
 * A content value is free operator text of up to 1200 characters, so it can
 * hold backticks and newlines, and a naive pair of backticks would let one
 * value close its own span and rewrite the rest of the list as headings or
 * bullets. Markdown's own rule handles the backticks: a span may be fenced by
 * any number of them, as long as the fence is longer than the longest run
 * inside. Newlines cannot appear in a span at all, so they are shown as `⏎`.
 */
function codeSpan(text: string): string {
  const flat = text.replaceAll(/\r\n|\r|\n/gu, ' ⏎ ');
  const longestRun = [...flat.matchAll(/`+/gu)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const fence = '`'.repeat(longestRun + 1);
  // A span that begins or ends with a backtick needs a space the renderer eats.
  const padding = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${flat}${padding}${fence}`;
}

/**
 * The body a browser will still open. Eleven content fields hold up to 1200
 * characters each, and percent-encoding roughly triples what a value costs, so
 * a long afternoon of edits can outgrow the URL and the link then fails as a
 * whole rather than arriving short. Cut on a code-point boundary: a cut
 * between the halves of a surrogate pair leaves a lone surrogate, and the URL
 * serializer answers that by substituting U+FFFD, so the last character of the
 * list arrives as a replacement mark. The control plane's own prefilled issue
 * hit the same edge and cuts the same way.
 */
function clampBody(body: string): string {
  const points = [...body];
  if (points.length <= issueBodyLimit) return body;
  const notice = '\n\n_Список обрезан, чтобы ссылка открылась._';
  return points.slice(0, issueBodyLimit - [...notice].length).join('') + notice;
}

/**
 * Conservative because the ceiling is not ours to know: browsers differ, and
 * GitHub answers a long query string with its own error page rather than the
 * form. Percent-encoding is what makes this smaller than it looks.
 */
const issueBodyLimit = 6000;
