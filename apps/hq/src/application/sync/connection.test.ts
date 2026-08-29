import { describe, expect, it } from 'vitest';

import { systemReadinessToken } from './connection';

/**
 * The status line's `SYSTEM:` badge used to be the literal `SYSTEM:READY`
 * whatever this session's own connection was doing. This asserts the reading
 * it now takes instead.
 */
describe('systemReadinessToken', () => {
  it('reads READY for a session working alone, with nothing gone wrong', () => {
    expect(systemReadinessToken({ mode: 'local-only', failure: '' })).toBe('READY');
  });

  it('reads READY for a session admitted to its group', () => {
    expect(systemReadinessToken({ mode: 'online', failure: '' })).toBe('READY');
  });

  it('names the mode when the connection is not settled', () => {
    expect(systemReadinessToken({ mode: 'connecting', failure: '' })).toBe('SYNCING');
    expect(systemReadinessToken({ mode: 'offline', failure: '' })).toBe('OFFLINE');
    expect(systemReadinessToken({ mode: 'reauth-required', failure: '' })).toBe('REAUTH');
    expect(systemReadinessToken({ mode: 'installation-changed', failure: '' })).toBe('CONFLICT');
  });

  it('reads DEGRADED over any mode once a failure is recorded', () => {
    // A failure recorded during an otherwise `online` session still means
    // something this session tried did not work -- the mode alone would say
    // nothing went wrong.
    expect(systemReadinessToken({ mode: 'online', failure: 'JoinGroup: unavailable' })).toBe(
      'DEGRADED',
    );
  });
});
