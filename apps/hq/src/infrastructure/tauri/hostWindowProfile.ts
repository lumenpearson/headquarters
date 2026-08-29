import { invoke, isTauri } from '@tauri-apps/api/core';

/** The four families `HostWindowFamily` serialises, and nothing else. */
export const hostWindowFamilies = ['win11', 'win10', 'legacy', 'other'] as const;

export type HostWindowFamily = (typeof hostWindowFamilies)[number];

/**
 * Mirrors `HostWindowProfile` in `src-tauri/src/host_profile.rs`, whose
 * `serde(rename_all = "camelCase")` puts these exact keys on the IPC boundary.
 *
 * `rounded` is not a second opinion about the family: the native side derives
 * it from the same classification, and R24 asks the two Windows generations to
 * differ in that one respect and no other.
 */
export interface HostWindowProfile {
  readonly family: HostWindowFamily;
  /** The NT build, or `null` when the host would not answer with one. */
  readonly buildNumber: number | null;
  readonly rounded: boolean;
}

/**
 * What a browser session is.
 *
 * `other` rather than a guess from the user agent: the classification R24 acts
 * on is a kernel build number, a browser cannot supply one, and a shell that
 * inferred `win11` from a Windows user agent would ask DWM for corners on a
 * window DWM does not own.
 */
export const webHostWindowProfile: HostWindowProfile = {
  family: 'other',
  buildNumber: null,
  rounded: false,
};

/**
 * Reads which Windows generation the shell is running on (R24).
 *
 * `host_window_profile` and `apply_window_corners` were registered in
 * `generate_handler!` and called from nowhere, which is the concrete form of
 * the R24 defect: a native classification that no title bar could act on.
 */
export async function readHostWindowProfile(): Promise<HostWindowProfile> {
  if (!isTauri()) return webHostWindowProfile;
  return parseHostWindowProfile(await invoke<unknown>('host_window_profile'));
}

/**
 * Asks DWM for the corner treatment the profile calls for.
 *
 * Rounding is the only thing this decides, and only Windows 11 is actually
 * asked: `apply_corners` in `src-tauri/src/host_profile.rs` classifies the
 * host before calling `DwmSetWindowAttribute` and returns early for every
 * other family, so `DWMWCP_ROUND` is the one preference this call ever sends.
 * Windows 10 and legacy hosts are left square by DWM's own default rather
 * than by a `DWMWCP_DONOTROUND` this call requests -- `DWMWA_WINDOW_CORNER_
 * PREFERENCE` only exists from build 22000, and earlier DWM builds reject it
 * with `E_INVALIDARG` and draw square corners anyway, so there is nothing for
 * a second code path to ask for.
 *
 * On the web build there is no window to address and nothing is invoked: a
 * browser draws the tab chrome, and the title bar below is drawn by this
 * application either way.
 */
export async function applyWindowCorners(rounded: boolean): Promise<void> {
  if (!isTauri()) return;
  // The command rejects with a plain string; the caller decides whether an
  // operator ever hears about a corner that stayed square.
  await invoke<null>('apply_window_corners', { rounded });
}

/**
 * Reads the profile the native side returned.
 *
 * The IPC boundary is inside the same process and the producer is our own Rust,
 * so this is a shape check rather than a security check: a build where the two
 * sides disagree should fail loudly here instead of asking DWM for a corner
 * preference derived from `undefined`.
 */
export function parseHostWindowProfile(value: unknown): HostWindowProfile {
  if (!isRecord(value)) throw new Error('Native shell returned an invalid window profile.');
  const { family, buildNumber, rounded } = value;
  if (
    !isFamily(family) ||
    !(buildNumber === null || buildNumber === undefined || isBuildNumber(buildNumber)) ||
    typeof rounded !== 'boolean'
  ) {
    throw new Error('Native shell returned an invalid window profile.');
  }
  return {
    family,
    buildNumber: isBuildNumber(buildNumber) ? buildNumber : null,
    rounded,
  };
}

function isFamily(value: unknown): value is HostWindowFamily {
  return typeof value === 'string' && (hostWindowFamilies as readonly string[]).includes(value);
}

function isBuildNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
