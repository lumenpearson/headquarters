import { controlPlaneAddressLimit, productionOverrideSchema } from '@gremuchaya/config';

import { t } from '@/application/localization/locale';
import { loadProjectConfiguration } from '@/infrastructure/config/RuntimeConfigLoader';

import {
  parseControlPlaneAddressList,
  safeParseControlPlaneUrl,
  validateControlPlaneAddresses,
  type ControlPlaneAddressListRefusal,
  type ControlPlaneAddressRefusalReport,
} from './controlPlaneLinks';
import { readManualControlPlaneAddress } from './manualControlPlaneAddress';

import type { ControlPlaneAddressSource } from './connection';

import type { MessageId } from '@/application/localization/messages';

/**
 * Where the control plane answers, if anywhere, in the operator's order.
 *
 * Split out of `ControlPlaneRuntime` so the IO -- reading the manual address,
 * fetching the project configuration, checking the override -- lives in the
 * application layer rather than in the component that mounts the connection
 * (CLAUDE.md: application services perform IO, components dispatch use
 * cases).
 *
 * **The order, and why it changed.** The manual address now wins over both
 * files: it is the operator's explicit choice, made from inside the running
 * application, and it is checked first for exactly the reason a `localStorage`
 * value an operator just typed has to outrank a file nobody touched today.
 * The project configuration still wins over the environment variable for the
 * reason it always did -- `project.override.json` is what an operator edits on
 * the shoot machine, and the machine's own answer outranks what was baked into
 * the build.
 */

/*
 * Re-exported rather than declared: this file and `connection.ts` each held an
 * identical copy of the union, which is two places for a source to be added to
 * one of them. The store's field types it, so `connection.ts` owns it.
 */
export type { ControlPlaneAddressSource } from './connection';

export interface ResolvedControlPlaneAddresses {
  readonly addresses: readonly string[];
  readonly source: ControlPlaneAddressSource;
  /**
   * Why the configuration produced no usable address, in the operator's
   * language; empty when it produced one or when nothing was configured at all.
   *
   * Two things reach this field. `/runtime/project.override.json` exists but
   * did not apply -- invalid JSON, a value `controlPlaneUrl`'s own schema
   * refuses, or anything else the override's own schema refuses. And
   * `NEXT_PUBLIC_HQ_CONTROL_PLANE_URL` named something that is not an address,
   * which until now was passed to `fetch` unexamined and came back as the
   * browser's `NetworkError`.
   *
   * Both are reported when both happened, joined into one line: neither is a
   * consequence of the other, they are fixed in different places, and choosing
   * between them would hide one defect behind the other. The name says
   * `override` because that was the field's first and only source; the
   * surface draws one failure line and the operator's next act -- go and
   * correct the configuration -- is the same for either.
   */
  readonly overrideFailure: string;
}

/**
 * The sentence for each reason {@link validateControlPlaneAddresses} can give.
 *
 * A `Record` over the union rather than a built id: a reason added to the union
 * with no message here is a compile error, where a template string would have
 * produced a bracketed id on a shoot-day screen.
 */
const refusalMessageIds: Readonly<Record<ControlPlaneAddressListRefusal, MessageId>> = {
  'msys-rewritten-path': 'connection.address.refusal.msysPath',
  'not-a-url': 'connection.address.refusal.notAUrl',
  'not-http': 'connection.address.refusal.notHttp',
  'has-credentials': 'connection.address.refusal.credentials',
  'protocol-relative': 'connection.address.refusal.protocolRelative',
  repeated: 'connection.address.refusal.repeated',
  'too-many': 'connection.address.refusal.tooMany',
  unclassified: 'connection.address.refusal.unclassified',
};

/**
 * The refused build variable as one line an operator can act on.
 *
 * The reason is composed into a frame that names the variable, because a
 * sentence about an address is not actionable until the operator knows which of
 * the three places it came from -- and this is the one place they cannot see
 * from inside the running application.
 *
 * No browser message is composed in. `NetworkError when attempting to fetch
 * resource` is the account of a request that never left, which `describe` in
 * `ControlPlaneSession.ts` still appends to a failed call and which remains
 * worth having as a diagnostic. It is not an explanation of a configuration:
 * the operator who reads it learns that something did not answer, not that the
 * address was never an address. A refusal decided here is decided before any
 * request exists to fail.
 */
function buildVariableRefusalMessage(refusal: ControlPlaneAddressRefusalReport): string {
  const reason = t(refusalMessageIds[refusal.reason], {
    address: refusal.address,
    limit: controlPlaneAddressLimit,
  });
  return t('connection.address.buildVariableRefused', { reason });
}

/** Both configuration failures on one line, in the order they were found. */
function joinFailures(first: string, second: string): string {
  return [first, second].filter((line) => line !== '').join(' ');
}

/**
 * The one sentence this runtime shows for a broken override, in the register
 * every other line on this dialog uses. Reused rather than rebuilt per
 * failure kind: the operator's next act is the same regardless of whether the
 * file held invalid JSON or a `controlPlaneUrl` its schema refused -- open the
 * file, or use the field this dialog now offers instead of it.
 */
const overrideFailureMessage =
  'ФАЙЛ /runtime/project.override.json НЕ ПРИМЕНЁН — ОШИБКА В JSON ИЛИ В АДРЕСЕ CONTROL PLANE. ' +
  'ИСПОЛЬЗУЕТСЯ /runtime/project.default.json. ИСПРАВЬТЕ ФАЙЛ ИЛИ УКАЖИТЕ РУЧНОЙ АДРЕС В ЭТОМ ДИАЛОГЕ.';

export async function resolveControlPlaneAddresses(
  signal: AbortSignal,
): Promise<ResolvedControlPlaneAddresses> {
  const manual = readManualControlPlaneAddress();
  if (manual.length > 0) return { addresses: manual, source: 'manual', overrideFailure: '' };

  /*
   * Run alongside `loadProjectConfiguration` rather than before it: both read
   * `/runtime/project.override.json`, and awaiting them in sequence would
   * double the round trips this runtime already pays once per launch for no
   * reason -- the two checks are independent and neither waits on the other's
   * answer.
   */
  const [overrideFailure, project] = await Promise.all([
    checkProjectOverride(signal),
    loadProjectConfiguration(signal).catch(() => null),
  ]);

  if (project !== null && project.config.controlPlaneUrl.length > 0) {
    return { addresses: project.config.controlPlaneUrl, source: 'project-file', overrideFailure };
  }
  // A `null` project means the runtime configuration is unavailable on a
  // route that ships without it; the variable is then the only answer left,
  // and no address at all is a valid one. A broken override was already found
  // above, independent of whether the rest of the file could still be read
  // and merged.

  /*
   * The build variable is checked against `controlPlaneUrl`'s own schema, the
   * same one the in-app field and the override file have always been checked
   * against. It used to be split on commas and used as it stood, which is how
   * `C:/Program Files/Git/api` -- Git Bash's rewrite of the documented `/api`
   * -- became the primary link and reached `fetch`. A variable baked into a
   * static export at build time is the least examined of the three sources,
   * not the most trustworthy: nobody sees it again after the build.
   *
   * A refused variable yields no address, so no client is constructed and no
   * request is attempted; the source is still reported as the build variable,
   * because "not configured" would send the operator looking for a setting
   * that is in fact set and wrong.
   */
  const configured = process.env.NEXT_PUBLIC_HQ_CONTROL_PLANE_URL;
  const entries = configured === undefined ? [] : parseControlPlaneAddressList(configured);
  if (entries.length === 0) return { addresses: [], source: 'none', overrideFailure };
  const outcome = validateControlPlaneAddresses(entries);
  if (!outcome.ok) {
    /*
     * A refused address yields none, and the web build's own origin does not
     * stand in for it. A deployment that named an external plane and mistyped
     * it would otherwise pair its devices against the plane it happens to be
     * served from -- a group nobody asked for -- and nothing here can tell a
     * typo from a value Git Bash rewrote. The operator reads the reason and
     * clears the variable or corrects it; an unset variable is what invites
     * the same-origin default.
     */
    return {
      addresses: [],
      source: 'build-variable',
      overrideFailure: joinFailures(overrideFailure, buildVariableRefusalMessage(outcome.refusal)),
    };
  }
  return { addresses: outcome.addresses, source: 'build-variable', overrideFailure };
}

/**
 * Whether `/runtime/project.override.json` exists and, if so, whether its
 * `controlPlaneUrl` is something this runtime can actually use.
 *
 * Checked independently of `loadProjectConfiguration`'s own read of the same
 * file, and deliberately narrow: that loader throws on a malformed override
 * so a broken file is never silently discarded from the configuration it
 * feeds, and this runtime used to catch that throw in the same blanket
 * `try {} catch {}` as "no runtime configuration shipped on this route at
 * all" -- so the operator who mistyped `controlPlaneUrl` was told the same
 * thing as the operator who never wrote a file. Only `controlPlaneUrl` is
 * checked here, because a defect anywhere else in the override -- a bad
 * `developerAccessCode`, say -- is a fact for whichever runtime reads that
 * field, not for the address this one is trying to find; folding every
 * possible override defect into one failure line would tell an operator who
 * broke an unrelated setting that their control plane address is the
 * problem. A 404 and the Tauri application-shell fallback both mean "no
 * override" and stay silent, exactly as `loadOptionalJson` already treats
 * them.
 */
async function checkProjectOverride(signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/runtime/project.override.json', { cache: 'no-store', signal });
  } catch {
    // Unreachable entirely; `loadProjectConfiguration`'s own fetch below finds
    // the same thing and is where the "no runtime configuration" fallthrough
    // belongs.
    return '';
  }
  if (response.status === 404) return '';
  if (!response.ok) return overrideFailureMessage;
  let body: string;
  try {
    body = await response.text();
  } catch {
    return overrideFailureMessage;
  }
  const normalized = body.trimStart().toLowerCase();
  if (normalized.startsWith('<!doctype html') || normalized.startsWith('<html')) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return overrideFailureMessage;
  }
  const override = productionOverrideSchema.safeParse(parsed);
  if (!override.success) return overrideFailureMessage;
  const controlPlaneUrl = override.data.values['controlPlaneUrl'];
  if (controlPlaneUrl === undefined) return '';
  return safeParseControlPlaneUrl(controlPlaneUrl).success ? '' : overrideFailureMessage;
}
