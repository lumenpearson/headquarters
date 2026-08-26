import { describe, expect, it } from 'vitest';

import { estimateClock, median, summarizeClockSamples } from './clock';

describe('group clock estimation', () => {
  it('cancels a symmetric network out of the offset', () => {
    // The server is 1000 ms ahead and each direction takes 10 ms: sent at 0,
    // received by the server at its 1010, answered at its 1012, back at 22.
    const estimate = estimateClock({
      clientSendMs: 0,
      serverReceiveMs: 1_010,
      serverSendMs: 1_012,
      clientReceiveMs: 22,
    });

    expect(estimate.offsetMs).toBe(1_000);
    // 22 ms of round trip less the 2 ms the server spent holding the request.
    expect(estimate.latencyMs).toBe(20);
  });

  it('reports no offset for two clocks that already agree', () => {
    const estimate = estimateClock({
      clientSendMs: 100,
      serverReceiveMs: 110,
      serverSendMs: 110,
      clientReceiveMs: 120,
    });

    expect(estimate.offsetMs).toBe(0);
    expect(estimate.latencyMs).toBe(20);
  });

  it('bounds a server share that is longer than the whole round trip', () => {
    // The server claims 100 ms of processing inside a 20 ms round trip, which
    // only a clock stepped mid-request can produce. Subtracting it as stated
    // would report a negative latency.
    const estimate = estimateClock({
      clientSendMs: 0,
      serverReceiveMs: 1_000,
      serverSendMs: 1_100,
      clientReceiveMs: 20,
    });

    expect(estimate.latencyMs).toBe(0);
  });

  it('bounds a server share that reads as negative', () => {
    // The same fault the other way: a send instant before the receive instant
    // would otherwise be subtracted as a *gain* and inflate the latency to
    // 110 ms inside a 10 ms round trip.
    const estimate = estimateClock({
      clientSendMs: 0,
      serverReceiveMs: 500,
      serverSendMs: 400,
      clientReceiveMs: 10,
    });

    expect(estimate.latencyMs).toBe(10);
  });

  it('takes the middle value, and the mean of the middle two for an even count', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('keeps the median of several rounds so one delayed round changes nothing', () => {
    const sampledAt = '2026-08-26T10:00:00.000Z';
    const summary = summarizeClockSamples(
      [
        { clientSendMs: 0, serverReceiveMs: 1_010, serverSendMs: 1_012, clientReceiveMs: 22 },
        { clientSendMs: 0, serverReceiveMs: 1_008, serverSendMs: 1_010, clientReceiveMs: 20 },
        // One round held for most of a second on the way back.
        { clientSendMs: 0, serverReceiveMs: 1_009, serverSendMs: 1_011, clientReceiveMs: 900 },
      ],
      sampledAt,
    );

    // The delayed round estimates 560 ms; a mean would report 706 and a screen
    // would be cued more than half a second early.
    expect(summary.offsetMs).toBe(999);
    expect(summary.sampledAt).toBe(sampledAt);
  });

  it('answers zero for an estimate taken from nothing', () => {
    // A round that never answered leaves no sample; reporting a made-up offset
    // would be worse than reporting none.
    expect(summarizeClockSamples([], '')).toEqual({ offsetMs: 0, latencyMs: 0, sampledAt: '' });
  });
});
