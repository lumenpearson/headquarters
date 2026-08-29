'use client';

import { useEffect, useState } from 'react';

import {
  isMaterialLifecycleClient,
  type MaterialLibraryClient,
  type MaterialLibraryEvent,
} from '@/infrastructure/materials/materialLibrary';

const maxRememberedEvents = 20;

/**
 * The group library's own change feed (`WatchMaterialEvents`), which is what
 * tells this device about a material another one just uploaded, trashed,
 * restored or replaced.
 *
 * Subscribed only while `enabled` is true and the library the caller holds is
 * lifecycle-capable -- the loopback bridge has no such stream, and a screen
 * whose import dialog is closed has no surface to report an event on. Every
 * subscription starts at sequence `0`: this hook keeps no cursor across
 * remounts, so a caller wanting to resume from where it left off would need
 * to persist one itself.
 *
 * Newest first, capped at `maxRememberedEvents` -- a live feed a screen reads
 * as a short recent log, not an unbounded history the group history screen
 * (F8) already owns.
 */
export function useMaterialLibraryEvents(
  client: MaterialLibraryClient,
  enabled: boolean,
): readonly MaterialLibraryEvent[] {
  const [events, setEvents] = useState<readonly MaterialLibraryEvent[]>([]);
  /*
   * What subscription `events` currently answers for, so a new one -- a
   * different library or the dialog reopening -- clears the log during render
   * rather than with a `setState` inside the effect that opens it (adjusting
   * state while rendering, in the idiom `FilesScreen`'s own sort-reseed
   * already uses, not a cascading update from inside the effect).
   */
  const subscriptionKey = `${enabled ? '1' : '0'}:${client.origin}`;
  const [subscribedFor, setSubscribedFor] = useState(subscriptionKey);
  if (subscribedFor !== subscriptionKey) {
    setSubscribedFor(subscriptionKey);
    setEvents([]);
  }

  useEffect(() => {
    if (!enabled || !isMaterialLifecycleClient(client)) return;
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of client.watchEvents(0, controller.signal)) {
          if (controller.signal.aborted) return;
          setEvents((current) => [event, ...current].slice(0, maxRememberedEvents));
        }
      } catch {
        /*
         * A dropped stream is not reported through this hook: the screen that
         * asked for a live feed is not the operator's channel for transport
         * failures, and `ControlPlaneSession` already owns that surface.
         */
      }
    })();
    return () => controller.abort();
  }, [client, enabled]);

  return events;
}
