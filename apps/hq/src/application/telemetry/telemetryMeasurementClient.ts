import type { TelemetryMeasurementClient } from './telemetryMeasurement';

/**
 * The measured half's client, for whoever the composition root is once it
 * wires one in.
 *
 * `TelemetryClient` (`infrastructure/controlPlane`) needs a group id, a
 * device id and this session's authenticated transport — the three facts
 * `GroupChannelRuntime` assembles for `ControlPlaneMaterialClient` and
 * `GroupSettingsClient` today (`components/sync/GroupChannelRuntime.tsx`).
 * Registering the built client here, in the idiom `bridgeMaterialLibrary`
 * already sets for the loopback bridge, is what lets `useTelemetryMeasurement`
 * read one without importing that runtime: a screen that only wants to know
 * whether measured telemetry exists must not drag the whole control-plane
 * client into its bundle.
 *
 * No caller sets one yet. Until a future change teaches `GroupChannelRuntime`
 * to build a `TelemetryClient` and call `setTelemetryMeasurementClient` the
 * way it already does for materials and settings, this reads `null`
 * everywhere, and `SystemScreen`'s measured panel stays exactly as absent as
 * it is today — which is the gate R31 asks for: a plane without the wiring
 * degrades to today's screen, not to a broken one.
 */
let client: TelemetryMeasurementClient | null = null;

export function telemetryMeasurementClient(): TelemetryMeasurementClient | null {
  return client;
}

/** Test seam, in the idiom `resetBridgeMaterialLibrary` sets. */
export function setTelemetryMeasurementClient(next: TelemetryMeasurementClient | null): void {
  client = next;
}
