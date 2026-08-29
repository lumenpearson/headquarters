// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  MaterialLibraryClient,
  MaterialLibraryEvent,
} from '@/infrastructure/materials/materialLibrary';

import { useMaterialLibraryEvents } from './useMaterialLibraryEvents';

const bridgeClient = { origin: 'local-mirror' } as unknown as MaterialLibraryClient;

describe('the group library event feed a screen holds', () => {
  it('never opens the stream while disabled', () => {
    let called = false;
    const client = groupClientWithEvents([], () => {
      called = true;
    });

    const { result } = renderHook(() => useMaterialLibraryEvents(client, false));

    expect(result.current).toEqual([]);
    expect(called).toBe(false);
  });

  it('never opens the stream against a library with no lifecycle surface', () => {
    const { result } = renderHook(() => useMaterialLibraryEvents(bridgeClient, true));

    expect(result.current).toEqual([]);
  });

  it('accumulates events newest first, from sequence zero', async () => {
    const events: MaterialLibraryEvent[] = [
      { sequence: 1, kind: 'created', materialId: 'm1', occurredAt: '', correlationId: '' },
      { sequence: 2, kind: 'trashed', materialId: 'm1', occurredAt: '', correlationId: '' },
    ];
    let requestedAfter = -1;
    const client = groupClientWithEvents(events, (after) => {
      requestedAfter = after;
    });

    const { result } = renderHook(() => useMaterialLibraryEvents(client, true));

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current).toEqual([events[1], events[0]]);
    expect(requestedAfter).toBe(0);
  });

  it('aborts its subscription signal on unmount', async () => {
    let capturedSignal: AbortSignal | undefined;
    const client = {
      origin: 'group-library',
      watchEvents(_afterSequence: number, signal?: AbortSignal) {
        capturedSignal = signal;
        return (async function* () {
          // Never yields; the point is observing the signal after unmount.
          await new Promise<void>(() => undefined);
        })();
      },
    } as unknown as MaterialLibraryClient;

    const { unmount } = renderHook(() => useMaterialLibraryEvents(client, true));
    await waitFor(() => expect(capturedSignal).toBeDefined());

    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });
});

function groupClientWithEvents(
  events: readonly MaterialLibraryEvent[],
  onWatch: (afterSequence: number) => void,
): MaterialLibraryClient {
  return {
    origin: 'group-library',
    watchEvents(afterSequence: number) {
      onWatch(afterSequence);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  } as unknown as MaterialLibraryClient;
}
