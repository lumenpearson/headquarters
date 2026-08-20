import {
  getSettingDefinition,
  type SettingsDraft,
  type SettingValue,
} from '@gremuchaya/settings-schema';

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

  const body = [
    '## Change made in edit mode',
    '',
    ...rows,
    '',
    `Base revision: ${draft.baseRevision.toString()}`,
  ].join('\n');

  const url = new URL(`https://github.com/${repository}/issues/new`);
  url.searchParams.set('title', `Personalization: ${draft.changedIds.length.toString()} change(s)`);
  url.searchParams.set('body', body);
  return url.toString();
}

function formatValue(value: SettingValue | undefined): string {
  if (value === undefined) return 'unset';
  return Array.isArray(value) ? value.join(', ') : String(value);
}
