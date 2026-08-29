'use client';

import { useEffect, useState } from 'react';

import { readTelemetryMeasurement, type TelemetryMeasurement } from './telemetryMeasurement';
import { telemetryMeasurementClient } from './telemetryMeasurementClient';

/**
 * The system screen's measured half, polled beside its simulated readings
 * (R31).
 *
 * `null` means no client is registered: nothing has wired
 * `setTelemetryMeasurementClient` yet, which is every deployment today, and
 * is a state distinct from a registered client that answered "not built" or
 * "no sources" — those are `TelemetryMeasurement`'s own `available: false`
 * branch, with a notice `SystemScreen` can print. A screen reading `null`
 * shows nothing extra, which is what today's screen already does; that is the
 * whole of the degrade this hook exists to keep true.
 *
 * The poll is read fresh from `telemetryMeasurementClient()` on every tick
 * rather than captured once, so a client registered after this hook first
 * mounted -- pairing completes after the screen is already open -- is picked
 * up on the next interval instead of requiring a remount.
 */
export function useTelemetryMeasurement(pollMs: number): TelemetryMeasurement | null {
  const [reading, setReading] = useState<TelemetryMeasurement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      const client = telemetryMeasurementClient();
      if (client === null) {
        if (!cancelled) setReading(null);
        return;
      }
      void readTelemetryMeasurement(client).then((result) => {
        if (!cancelled) setReading(result);
      });
    };
    read();
    const timer = window.setInterval(read, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pollMs]);

  return reading;
}
