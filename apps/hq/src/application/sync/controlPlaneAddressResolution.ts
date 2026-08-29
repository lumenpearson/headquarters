import { productionOverrideSchema } from '@gremuchaya/config';

import { loadProjectConfiguration } from '@/infrastructure/config/RuntimeConfigLoader';

import { parseControlPlaneAddressList } from './controlPlaneLinks';
import {
  readManualControlPlaneAddress,
  safeParseControlPlaneUrl,
} from './manualControlPlaneAddress';

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

export type ControlPlaneAddressSource = 'manual' | 'project-file' | 'build-variable' | 'none';

export interface ResolvedControlPlaneAddresses {
  readonly addresses: readonly string[];
  readonly source: ControlPlaneAddressSource;
  /**
   * Non-empty when `/runtime/project.override.json` exists but did not apply
   * -- invalid JSON, a value `controlPlaneUrl`'s own schema refuses, or
   * anything else the override's own schema refuses. Empty when there is no
   * override file (a 404, or the Tauri application-shell fallback a route
   * with no runtime configuration resolves to) or it applied cleanly.
   */
  readonly overrideFailure: string;
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

  const configured = process.env.NEXT_PUBLIC_HQ_CONTROL_PLANE_URL;
  const envAddresses = configured === undefined ? [] : parseControlPlaneAddressList(configured);
  return {
    addresses: envAddresses,
    source: envAddresses.length > 0 ? 'build-variable' : 'none',
    overrideFailure,
  };
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
