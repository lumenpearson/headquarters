import type { Sector } from '@gremuchaya/domain';

import { intlTag } from '@/application/localization/locale';
import type { ConnectionMode, ConnectionSession, DeviceRole } from '@/application/sync/connection';

/**
 * The topbar's `СЕКТОР`, `ДОПУСК` and `СВЯЗЬ` readouts, extracted from
 * `OperationsShell` the way `ShellMotion.ts` extracts the motion rule beside
 * it -- so each can be tested without mounting the shell. `ДАТА` is not here:
 * it is a date/time reading, and lives beside the shell clock in
 * `application/dateTime.ts` for the same reason `useShellClock` does.
 *
 * All three used to be literals: `S-03 / ТУ`, `АЛЬФА / А1` and `ЗАЩИЩЕНА`,
 * printed whatever the session actually knew. This module is what reads
 * instead, from state the shell already holds for other reasons.
 */

/**
 * `СЕКТОР`: the sector this operation is watching most closely right now,
 * taken to be the one with the highest `threat` reading -- the same field
 * `TacticalMapScreen` colors sectors by. Undefined only for a world with no
 * sectors at all, which the seed never produces but a test fixture might.
 */
export function sectorFocus(
  sectors: Readonly<Record<string, Sector>>,
): { readonly code: string; readonly abbreviation: string } | undefined {
  let hottest: Sector | undefined;
  for (const sector of Object.values(sectors)) {
    if (hottest === undefined || sector.threat > hottest.threat) hottest = sector;
  }
  if (hottest === undefined) return undefined;
  return { code: hottest.code, abbreviation: sectorAbbreviation(hottest.name) };
}

/** The first letter of each word, uppercase -- `ТРАНСПОРТНЫЙ УЗЕЛ` becomes `ТУ`. */
function sectorAbbreviation(name: string): string {
  return name
    .split(/\s+/u)
    .map((word) => word.charAt(0))
    .join('')
    .toLocaleUpperCase(intlTag());
}

/**
 * `ДОПУСК`: this device's own clearance, read off `connection.session.role`.
 *
 * A session that never joined a group has no role to report and is not
 * therefore uncleared -- it is the sole operator of its own machine, which is
 * the highest tier there is on a machine with no group. `deviceRoleLabel` in
 * `application/sync/connection.ts` already spells a role out in full
 * (`РЕДАКТОР`, `АДМИНИСТРАТОР`) for the pairing dialog; this is the topbar's
 * own short codename register, matching `АЛЬФА / А1` beside it before this
 * change and `SYSTEM:READY`, `BUS:BROADCAST` elsewhere on the same bar.
 */
export function clearanceReadout(session: Pick<ConnectionSession, 'role'> | undefined): {
  readonly tier: string;
  readonly code: string;
} {
  const role: DeviceRole = session?.role ?? 'ADMIN';
  switch (role) {
    case 'ADMIN':
      return { tier: 'АЛЬФА', code: 'А1' };
    case 'EDITOR':
      return { tier: 'БЕТА', code: 'В2' };
    case 'VIEWER':
      return { tier: 'ГАММА', code: 'С3' };
  }
}

/**
 * `СВЯЗЬ`: what this session's own connection to the group is doing, in the
 * topbar's short register. `online` is the only mode this device reaches by
 * presenting the credentials `DeviceSessionStore` holds, which is what
 * `ЗАЩИЩЕНА` claimed unconditionally before this change.
 */
export function secureLinkReadout(mode: ConnectionMode): string {
  switch (mode) {
    case 'online':
      return 'ЗАЩИЩЕНА';
    case 'local-only':
      return 'ЛОКАЛЬНО';
    case 'connecting':
      return 'ПОДКЛЮЧЕНИЕ';
    case 'offline':
      return 'ОБРЫВ СВЯЗИ';
    case 'reauth-required':
      return 'НУЖЕН КОД';
    case 'installation-changed':
      return 'ЧУЖАЯ БАЗА';
  }
}
