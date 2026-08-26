import { describe, expect, it } from 'vitest';

import type { GroupSettingsDocument } from './groupSettingsPort';
import {
  acceptableGroupValues,
  buildGroupMirror,
  decideMirrorAdoption,
  type GroupMirror,
  mirrorSummary,
  parseGroupMirror,
} from './localMirror';

function document(values: GroupSettingsDocument['values'], revision = 7): GroupSettingsDocument {
  return { revision, values, updatedAt: '2026-08-26T09:00:00.000Z' };
}

function candidate(overrides: Partial<Parameters<typeof buildGroupMirror>[0]> = {}) {
  return buildGroupMirror({
    groupId: 'GRP-1',
    installationId: 'INST-1',
    document: document({ 'telemetry.source': 'native' }),
    sequence: 12,
    refreshedAt: '2026-08-26T09:00:00.000Z',
    ...overrides,
  });
}

describe('decideMirrorAdoption', () => {
  it('takes a strictly newer revision and refuses an equal or older one', () => {
    expect(decideMirrorAdoption(4, 5)).toBe('adopt');
    // Equal is the case that matters most: a client that adopted it would
    // re-adopt the same document on every join and, through the settings
    // history, write a ledger entry for a change nobody made.
    expect(decideMirrorAdoption(4, 4)).toBe('keep-local');
    // Older is the case the rule exists for: the local copy may hold a change
    // this client made and the server has not recorded yet.
    expect(decideMirrorAdoption(4, 3)).toBe('keep-local');
  });

  it('takes any well-formed revision when nothing has been mirrored yet', () => {
    expect(decideMirrorAdoption(null, 0)).toBe('adopt');
    expect(decideMirrorAdoption(null, 9_007_199_254_740_991)).toBe('adopt');
  });

  it('refuses a remote number that is not a revision rather than coercing it', () => {
    // The server's revision is a bigint on the wire and a number at the
    // adapter. A value that lost precision, or that arrived as anything but a
    // counter, cannot be compared and must not win by accident: `NaN > 4` is
    // false but `Infinity > 4` is true, and the second would adopt for ever.
    for (const remote of [Number.NaN, Number.POSITIVE_INFINITY, -1, 4.5, 2 ** 53]) {
      expect(decideMirrorAdoption(4, remote)).toBe('keep-local');
      expect(decideMirrorAdoption(null, remote)).toBe('keep-local');
    }
  });

  it('treats a local number that is not a revision as no copy at all', () => {
    // `parseGroupMirror` refuses such a blob before it can reach here. If one
    // does, the answer is "there is nothing to compare against" rather than a
    // ceiling no answer could ever clear.
    expect(decideMirrorAdoption(Number.NaN, 1)).toBe('adopt');
    expect(decideMirrorAdoption(Number.POSITIVE_INFINITY, 1)).toBe('adopt');
  });
});

describe('acceptableGroupValues', () => {
  it('keeps the group scope and drops everything else', () => {
    expect(
      acceptableGroupValues({
        'telemetry.source': 'native',
        // Device-scoped: this machine's business, and 138 of the 154
        // definitions are like it. A copy of the group must not carry them.
        'layout.density': 'dense',
      }),
    ).toEqual({ 'telemetry.source': 'native' });
  });

  it('drops a value past its own validator and keeps the rest', () => {
    expect(
      acceptableGroupValues({
        // `integerWithin(1, 86_400)`.
        'simulation.periodSeconds': 999_999,
        'telemetry.source': 'native',
      }),
    ).toEqual({ 'telemetry.source': 'native' });
  });

  it('drops an identifier no definition names, including a prototype member', () => {
    const accepted = acceptableGroupValues({
      'nosuch.setting': 'значение',
      __proto__: 'ФАНТОМ',
      'telemetry.source': 'native',
    } as unknown as Record<string, string>);

    expect(accepted).toEqual({ 'telemetry.source': 'native' });
    expect(Object.hasOwn(accepted, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>)['ФАНТОМ']).toBeUndefined();
  });
});

describe('buildGroupMirror', () => {
  it('makes no copy at all out of an answer holding no group values', () => {
    // Zero values is a no-op and never a wipe. The first line of this defence
    // is the installation identifier, which stops such a session reaching
    // `online`; this is the second.
    expect(candidate({ document: document({}) })).toBeNull();
    expect(candidate({ document: document({ 'layout.density': 'dense' }) })).toBeNull();
  });

  it('makes no copy out of an answer whose revision or sequence is not one', () => {
    expect(candidate({ document: document({ 'telemetry.source': 'native' }, -1) })).toBeNull();
    expect(
      candidate({ document: document({ 'telemetry.source': 'native' }, Number.NaN) }),
    ).toBeNull();
    // A required field the server did not send. `GroupSettingsDocument` types
    // it as a number, which is exactly why a blob that lost it has to be
    // caught here rather than trusted by its type.
    expect(
      candidate({
        document: { values: { 'telemetry.source': 'native' } } as unknown as GroupSettingsDocument,
      }),
    ).toBeNull();
    expect(candidate({ sequence: 1.5 })).toBeNull();
  });

  it('makes no copy that cannot say whose it is', () => {
    expect(candidate({ groupId: '' })).toBeNull();
  });

  it('carries only the checked group values', () => {
    const mirror = candidate({
      document: document({
        'telemetry.source': 'native',
        'simulation.periodSeconds': 999_999,
        'layout.density': 'dense',
      }),
    });

    expect(mirror?.values).toEqual({ 'telemetry.source': 'native' });
    expect(mirror?.revision).toBe(7);
    expect(mirror?.sequence).toBe(12);
  });
});

describe('parseGroupMirror', () => {
  const stored: GroupMirror = {
    version: 1,
    groupId: 'GRP-1',
    installationId: 'INST-1',
    revision: 7,
    sequence: 12,
    values: { 'telemetry.source': 'native' },
    refreshedAt: '2026-08-26T09:00:00.000Z',
  };

  it('reads back a copy it wrote', () => {
    expect(parseGroupMirror(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  /*
   * `localStorage` is a trust boundary exactly as the operations key is: the
   * blob is editable in a browser's devtools and may have been written by an
   * older build. Every one of these was a copy on disk a moment before it was
   * a hostile input.
   */
  it.each([
    ['not an object', 'строка'],
    ['null', null],
    ['an array', []],
    ['a version this build does not write', { ...stored, version: 2 }],
    ['no group', { ...stored, groupId: '' }],
    ['a group that is not a string', { ...stored, groupId: 4 }],
    ['an installation that is not a string', { ...stored, installationId: null }],
    ['a revision that is not an integer', { ...stored, revision: 7.5 }],
    ['a negative revision', { ...stored, revision: -1 }],
    ['a sequence that is not a number', { ...stored, sequence: '12' }],
    ['no instant', { ...stored, refreshedAt: '' }],
    ['an instant that is not one', { ...stored, refreshedAt: 'вчера' }],
    ['values that are not a record', { ...stored, values: ['telemetry.source'] }],
    ['values this build cannot use', { ...stored, values: { 'nosuch.setting': 1 } }],
    ['no values left after checking', { ...stored, values: { 'simulation.noise': 42 } }],
    ['a missing field', { ...stored, revision: undefined }],
  ])('refuses a blob with %s', (_case, blob) => {
    expect(parseGroupMirror(blob)).toBeNull();
  });

  it('strips a field this build does not know and keeps the copy', () => {
    // Forward compatibility in the direction that is safe: a newer build may
    // have written more, and refusing the whole copy over it would send a
    // downgraded machine back to the compiled-in constants.
    expect(parseGroupMirror({ ...stored, somethingNewer: { deep: true } })).toEqual(stored);
  });

  it('drops a prototype member masquerading as a setting', () => {
    const parsed = parseGroupMirror(
      JSON.parse(`{"version":1,"groupId":"GRP-1","installationId":"","revision":7,"sequence":0,
        "refreshedAt":"2026-08-26T09:00:00.000Z",
        "values":{"__proto__":"ФАНТОМ","telemetry.source":"native"}}`),
    );

    expect(parsed?.values).toEqual({ 'telemetry.source': 'native' });
    expect(({} as Record<string, unknown>)['ФАНТОМ']).toBeUndefined();
  });
});

describe('mirrorSummary', () => {
  it('says there is no copy when there is none', () => {
    expect(mirrorSummary(null)).toEqual({ refreshedAt: '', revision: 0, sequence: 0 });
  });

  it('carries the instant and the two positions, and no values', () => {
    const mirror = candidate();
    expect(mirrorSummary(mirror)).toEqual({
      refreshedAt: '2026-08-26T09:00:00.000Z',
      revision: 7,
      sequence: 12,
    });
  });
});
