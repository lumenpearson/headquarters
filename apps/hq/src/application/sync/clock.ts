import type { ClockEstimate } from './connection';
import type { ClockSample } from './controlPlanePort';

/**
 * The clock arithmetic of one `TimeSync` round, NTP-style.
 *
 * With the client's send and receive instants `t0` and `t3` and the server's
 * receive and send instants `t1` and `t2`:
 *
 *   offset  = ((t1 - t0) + (t2 - t3)) / 2
 *   latency = (t3 - t0) - (t2 - t1)
 *
 * The offset is what to add to this machine's clock to read the server's, and
 * it cancels the network's share provided the two directions take about the
 * same time. The latency is the round trip with the server's own processing
 * removed -- the server takes `t1` before authentication and `t2` last for
 * exactly this subtraction (`service.ts`, `timeSync`). Both are what
 * `Presence.clock_offset_ms` and `Presence.latency_ms` mean.
 */
export function estimateClock(sample: ClockSample): {
  readonly offsetMs: number;
  readonly latencyMs: number;
} {
  const offsetMs =
    (sample.serverReceiveMs -
      sample.clientSendMs +
      (sample.serverSendMs - sample.clientReceiveMs)) /
    2;
  const roundTripMs = sample.clientReceiveMs - sample.clientSendMs;
  /*
   * The server's own share is bounded from both sides before it is
   * subtracted. A server that stepped its clock between the two reads reports
   * a negative share, which would *inflate* the latency, or a share longer
   * than the whole round trip, which would make it negative. Neither is a
   * reading an operator can act on, and both come from the same fault.
   */
  const processingMs = Math.min(
    Math.max(0, sample.serverSendMs - sample.serverReceiveMs),
    Math.max(0, roundTripMs),
  );
  return { offsetMs, latencyMs: Math.max(0, roundTripMs - processingMs) };
}

/** The middle value; the mean of the two middle values for an even count. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1] ?? upper;
  return (lower + upper) / 2;
}

/**
 * One estimate from several rounds.
 *
 * The median rather than the mean, so a single round delayed by a scheduler
 * pause or a retransmission -- the usual outlier on a set's Wi-Fi -- does not
 * move the answer. Offsets and latencies are taken separately: the round with
 * the median latency need not be the one with the median offset.
 */
export function summarizeClockSamples(
  samples: readonly ClockSample[],
  sampledAt: string,
): ClockEstimate {
  const estimates = samples.map(estimateClock);
  return {
    offsetMs: Math.round(median(estimates.map((estimate) => estimate.offsetMs))),
    latencyMs: Math.round(median(estimates.map((estimate) => estimate.latencyMs))),
    sampledAt,
  };
}
