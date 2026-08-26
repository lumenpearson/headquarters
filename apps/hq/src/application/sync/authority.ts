import type { AuthorityMode, ConnectionMode, DeviceRole } from './connection';

/**
 * What to do when `groups.authority` and the group disagree.
 *
 * The setting is group-scoped: it records what the group decided, not what
 * this machine prefers, and the server is where that decision is kept. So the
 * server wins by default -- a mode it reports is written into the setting
 * (`reflect`) rather than fought -- with one exception: an administrator who
 * has just moved the setting is the group deciding, and the change is sent
 * (`send`). A viewer or editor cannot change the mode, so their setting is
 * brought back to the server's answer instead of retrying forever.
 *
 * The loop terminates because both branches end with the two values equal:
 * `send` updates the store's `authority` from the server's answer, `reflect`
 * updates the setting, and equality is `none`.
 */
export type AuthorityResolution =
  | { readonly action: 'none' }
  | { readonly action: 'send'; readonly mode: AuthorityMode }
  | { readonly action: 'reflect'; readonly mode: AuthorityMode };

export function resolveAuthority(input: {
  readonly setting: AuthorityMode | undefined;
  readonly server: AuthorityMode | undefined;
  readonly role: DeviceRole | undefined;
  readonly mode: ConnectionMode;
}): AuthorityResolution {
  if (input.mode !== 'online' || input.server === undefined || input.setting === undefined) {
    return { action: 'none' };
  }
  if (input.setting === input.server) return { action: 'none' };
  if (input.role === 'ADMIN') return { action: 'send', mode: input.setting };
  return { action: 'reflect', mode: input.server };
}

/** The setting's value as the type the client sends, or nothing for a stale blob. */
export function toAuthorityMode(value: string): AuthorityMode | undefined {
  return value === 'leader' || value === 'multi-authority' ? value : undefined;
}
