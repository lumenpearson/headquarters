import {
  applyDraftPatch,
  createFactorySnapshot,
  createSettingsDraft,
} from '@gremuchaya/settings-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '../../state/operationsStore';
import { buildIssueDraftUrl } from './issueDraft';

const metadata = { id: 'test-mutation', at: '2026-08-20T00:00:00.000Z' };

describe('edit-mode issue draft', () => {
  // The builder reads `github.draftOnly` from the live store, so a value left
  // behind by an earlier case would decide the next one's title.
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('builds a prefilled GitHub issue URL listing only what changed', () => {
    const draft = applyDraftPatch(
      createSettingsDraft(createFactorySnapshot()),
      [{ id: 'layout.density', value: 'comfortable' }],
      metadata,
    );

    const url = new URL(buildIssueDraftUrl({ repository: 'leather147/headquarters', draft }));

    expect(url.origin + url.pathname).toBe('https://github.com/leather147/headquarters/issues/new');
    const body = url.searchParams.get('body') ?? '';
    expect(body).toContain('layout.density');
    expect(body).toContain('comfortable');
    // Only changed ids appear: an issue listing every setting is unreadable.
    expect(body).not.toContain('general.localOnly');
  });

  it('includes the definition description when one is known', () => {
    const draft = applyDraftPatch(
      createSettingsDraft(createFactorySnapshot()),
      [{ id: 'layout.density', value: 'mainframe' }],
      metadata,
    );

    const url = new URL(buildIssueDraftUrl({ repository: 'leather147/headquarters', draft }));
    const body = url.searchParams.get('body') ?? '';

    expect(body).toContain('Screen density preset.');
  });

  it('never puts a raw credential-shaped value in the URL, only the setting values', () => {
    // Regression guard for the shape of the payload, not a claim that this
    // function ever sees a credential -- it only ever reads SettingsDraft.
    const draft = applyDraftPatch(
      createSettingsDraft(createFactorySnapshot()),
      [{ id: 'layout.density', value: 'comfortable' }],
      metadata,
    );

    const url = buildIssueDraftUrl({ repository: 'leather147/headquarters', draft });

    expect(url).not.toContain('token');
    expect(url).not.toContain('secret');
  });

  it('refuses to build a URL for a draft with no changes', () => {
    const draft = createSettingsDraft(createFactorySnapshot());

    expect(() => buildIssueDraftUrl({ repository: 'leather147/headquarters', draft })).toThrow(
      'no changes',
    );
  });

  it('URL-encodes a value containing spaces and slashes without corrupting the link', () => {
    // Built directly rather than through applyDraftPatch: every string setting
    // in the registry is a closed oneOf, so no validated patch can carry a
    // space. buildIssueDraftUrl only consumes the SettingsDraft shape, so
    // constructing one by hand still tests the function under test honestly.
    const draft = {
      baseRevision: 1,
      values: { 'themes.id': 'terminal red / high contrast' },
      changedIds: ['themes.id'],
      history: [],
    };

    const url = new URL(buildIssueDraftUrl({ repository: 'leather147/headquarters', draft }));
    const body = url.searchParams.get('body') ?? '';

    expect(body).toContain('terminal red / high contrast');
  });

  it('marks the issue as an unconfirmed draft while github.draftOnly is on', () => {
    // On by default: the declared default is the safe one, and the test says so
    // by not patching the setting at all.
    const draft = applyDraftPatch(
      createSettingsDraft(createFactorySnapshot()),
      [{ id: 'layout.density', value: 'comfortable' }],
      metadata,
    );

    const url = new URL(buildIssueDraftUrl({ repository: 'leather147/headquarters', draft }));

    expect(url.searchParams.get('title')).toBe('[DRAFT] Personalization: 1 change(s)');
    expect(url.searchParams.get('body')).toContain('confirm this list with the group');
  });

  it('composes a plain issue once github.draftOnly is turned off', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'github.draftOnly', value: false }]);
    const draft = applyDraftPatch(
      createSettingsDraft(createFactorySnapshot()),
      [{ id: 'layout.density', value: 'comfortable' }],
      metadata,
    );

    const url = new URL(buildIssueDraftUrl({ repository: 'leather147/headquarters', draft }));

    expect(url.searchParams.get('title')).toBe('Personalization: 1 change(s)');
    expect(url.searchParams.get('body')).not.toContain('confirm this list with the group');
    // The change list itself is not what the setting decides, so it stays.
    expect(url.searchParams.get('body')).toContain('layout.density');
  });
});

describe('issue draft composition settings', () => {
  const draft = {
    baseRevision: 3,
    values: { 'layout.density': 'comfortable' },
    changedIds: ['layout.density'],
    history: [],
  } as const;

  function bodyOf(): string {
    const url = new URL(buildIssueDraftUrl({ repository: 'owner/repo', draft }));
    return url.searchParams.get('body') ?? '';
  }

  function set(id: string, value: boolean | string): void {
    operationsStore.getState().applySettingsPatch([{ id, value }]);
  }

  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('writes a checklist when the operator asks for one', () => {
    expect(bodyOf()).toContain('- `layout.density`');

    set('github.changeFormat', 'checklist');
    // A reviewer reading someone else's afternoon of edits ticks them off.
    expect(bodyOf()).toContain('- [ ] `layout.density`');
  });

  it('drops the description and the base revision when they are switched off', () => {
    expect(bodyOf()).toContain('Base revision: 3');
    expect(bodyOf()).toContain('Screen density preset.');

    set('github.includeBaseRevision', false);
    set('github.includeDescriptions', false);

    expect(bodyOf()).not.toContain('Base revision: 3');
    expect(bodyOf()).not.toContain('Screen density preset.');
    // The change itself always survives: this is a draft about a change.
    expect(bodyOf()).toContain('`layout.density`');
  });

  it('refuses to attach diagnostics past the decision that governs them', () => {
    set('github.attachDiagnostics', true);
    // `privacy.copyDiagnostics` is off by default, and it is the standing
    // answer about that report leaving the application at all. A second setting
    // able to post it anyway would make the first one a suggestion.
    expect(bodyOf()).not.toContain('## Diagnostics');

    set('privacy.copyDiagnostics', true);
    expect(bodyOf()).toContain('## Diagnostics');
  });
});
