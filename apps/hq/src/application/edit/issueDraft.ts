import {
  getSettingDefinition,
  type SettingsDraft,
  type SettingValue,
} from '@gremuchaya/settings-schema';

import { readBooleanSetting } from '@/application/personalization/useSetting';

export interface IssueDraftInput {
  readonly repository: string;
  readonly draft: SettingsDraft;
}

/**
 * Builds a prefilled "new issue" link from an edit-mode draft.
 *
 * This produces a URL rather than calling the GitHub API. An API call would
 * need a token inside the desktop client; a prefilled link needs nothing, the
 * operator stays the author of the eventual issue, and no credential is ever
 * held by this application.
 */
export function buildIssueDraftUrl({ repository, draft }: IssueDraftInput): string {
  if (draft.changedIds.length === 0) {
    throw new Error('An issue draft needs at least one change; this draft has no changes.');
  }

  const rows = draft.changedIds.map((id) => {
    const value = draft.values[id];
    const description = getSettingDefinition(id)?.description;
    const suffix = description === undefined ? '' : ` — ${description}`;
    return `- \`${id}\` → \`${formatValue(value)}\`${suffix}`;
  });

  /*
   * `github.draftOnly` is group scope: with it on, nothing composed here is
   * offered as a finished issue. The link is still built and still opens
   * GitHub's own form -- the operator remains the author either way -- but the
   * title and a closing line say the list is unconfirmed. Without them a group
   * member reading the issue cannot tell an agreed change from one operator's
   * afternoon of experiments.
   */
  const draftOnly = readBooleanSetting('github.draftOnly');

  const body = [
    '## Change made in edit mode',
    '',
    ...rows,
    '',
    `Base revision: ${draft.baseRevision.toString()}`,
    ...(draftOnly
      ? ['', 'Draft: confirm this list with the group before submitting the issue.']
      : []),
  ].join('\n');

  const url = new URL(`https://github.com/${repository}/issues/new`);
  url.searchParams.set(
    'title',
    `${draftOnly ? '[DRAFT] ' : ''}Personalization: ${draft.changedIds.length.toString()} change(s)`,
  );
  url.searchParams.set('body', body);
  return url.toString();
}

function formatValue(value: SettingValue | undefined): string {
  if (value === undefined) return 'unset';
  return Array.isArray(value) ? value.join(', ') : String(value);
}
