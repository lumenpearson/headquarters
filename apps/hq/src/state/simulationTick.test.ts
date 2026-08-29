import { describe, expect, it } from 'vitest';

import {
  simulationChannelRanges,
  type SessionMetricName,
} from '../application/simulation/simulationCurves';
import { metricsHistoryDepth, operationsStore } from './operationsStore';

/**
 * The tick reading the curves an operator drew (R31).
 *
 * Every case here drives the store through moments it chose, because
 * `simulationTick` takes the moment as an argument. That is the seam: the run
 * is a pure function of the moments it was handed and the settings it read, so
 * a case can state what the curve says at a phase and check the world against
 * it by hand rather than against whatever the last run happened to produce.
 */

/** The first moment of every run below; the value itself carries no meaning. */
const start = 1_700_000_000_000;

/**
 * A run whose scatter and smoothing are off, so a reading is the curve and
 * nothing else. The cases that mean to exercise noise or smoothing turn them
 * back on themselves.
 */
function settleRun(
  patches: readonly { readonly id: string; readonly value: unknown }[] = [],
): void {
  operationsStore.getState().resetWorld();
  operationsStore
    .getState()
    .applySettingsPatch([
      { id: 'simulation.interpolation', value: 'linear' },
      { id: 'simulation.loop', value: false },
      { id: 'simulation.periodSeconds', value: 10 },
      { id: 'simulation.updateIntervalMs', value: 1_000 },
      { id: 'simulation.timeScale', value: 1 },
      { id: 'simulation.noise', value: 0 },
      { id: 'simulation.smoothing', value: 0 },
      ...(patches as readonly { readonly id: string; readonly value: never }[]),
    ]);
}

/** A curve that rises from `from` to `to` across the whole period. */
function ramp(channel: string, from: number, to: number): readonly string[] {
  return [`${channel}=0,${from},0,0`, `${channel}=1,${to},0,0`];
}

function tickAt(...moments: readonly number[]): void {
  for (const moment of moments) operationsStore.getState().simulationTick(moment);
}

function metric(name: SessionMetricName): number {
  return operationsStore.getState().metrics[name];
}

describe('the tick reads the curves rather than its own counter', () => {
  it('produces the value the curve states at each phase', () => {
    // 0 % to 100 % of the CPU range over a ten-second period, read at one
    // second per tick: phase 0, 0.1, 0.2, and the reading is the range's own
    // low bound plus that fraction of its span.
    settleRun([{ id: 'simulation.valueCurve', value: ramp('cpu', 0, 100) }]);
    const { minimum, maximum } = simulationChannelRanges.cpu;

    tickAt(start);
    expect(metric('cpu')).toBe(minimum);
    tickAt(start + 1_000);
    expect(metric('cpu')).toBe(Math.round(minimum + 0.1 * (maximum - minimum)));
    tickAt(start + 2_000);
    expect(metric('cpu')).toBe(Math.round(minimum + 0.2 * (maximum - minimum)));
    tickAt(start + 5_000);
    expect(metric('cpu')).toBe(Math.round(minimum + 0.5 * (maximum - minimum)));
  });

  it('rests a channel nothing was drawn for in the middle of its range', () => {
    // The counter it replaced walked every counter from wherever it started.
    // A curve says nothing about RAM here, and "nothing drawn" is a reading of
    // its own — the middle of the range — not a frozen seed value.
    settleRun([{ id: 'simulation.valueCurve', value: ramp('cpu', 0, 100) }]);
    const { minimum, maximum } = simulationChannelRanges.ram;
    const middle = Math.round((minimum + maximum) / 2);
    expect(metric('ram')).not.toBe(middle);

    tickAt(start);

    expect(metric('ram')).toBe(middle);
  });

  it('drives storage, which the counter never moved at all', () => {
    settleRun([{ id: 'simulation.valueCurve', value: ramp('storage', 0, 100) }]);
    const before = metric('storage');

    tickAt(start, start + 2_000, start + 5_000);

    expect(metric('storage')).not.toBe(before);
    expect(metric('storage')).toBe(
      Math.round(
        simulationChannelRanges.storage.minimum +
          0.5 * (simulationChannelRanges.storage.maximum - simulationChannelRanges.storage.minimum),
      ),
    );
  });

  it('reads the system nodes and the comms links through their own channels', () => {
    settleRun([
      {
        id: 'simulation.valueCurve',
        value: [...ramp('link-latency', 100, 100), ...ramp('node-temperature', 0, 0)],
      },
    ]);

    tickAt(start);

    const state = operationsStore.getState();
    const nodes = Object.values(state.systemNodes);
    const links = Object.values(state.channels);
    expect(nodes.length).toBeGreaterThan(0);
    expect(links.length).toBeGreaterThan(0);
    // Every node lands on the same temperature and every link on the same
    // latency, because one curve drives the whole channel.
    for (const node of nodes) {
      expect(node.temperature).toBe(simulationChannelRanges['node-temperature'].minimum);
    }
    for (const link of links) {
      expect(link.latency).toBe(simulationChannelRanges['link-latency'].maximum);
    }
  });

  it('reads a comms link’s packet loss through its own channel, not the seed alone', () => {
    settleRun([{ id: 'simulation.valueCurve', value: ramp('packet-loss', 100, 100) }]);
    const before = Object.values(operationsStore.getState().channels).map(
      (channel) => channel.packetLoss,
    );

    tickAt(start);

    const links = Object.values(operationsStore.getState().channels);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.packetLoss).toBe(simulationChannelRanges['packet-loss'].maximum);
    }
    // The seed drew scattered packet loss per channel; a curve overrides all
    // of it identically, which the seed's own scatter could not have produced.
    expect(before.some((value) => value !== simulationChannelRanges['packet-loss'].maximum)).toBe(
      true,
    );
  });

  it('reads a sensor’s and a camera’s signal through their own channels', () => {
    settleRun([
      {
        // Channels are written in ascending name order, as the schema requires:
        // `camera-signal` sorts before `sensor-signal`.
        id: 'simulation.valueCurve',
        value: [...ramp('camera-signal', 100, 100), ...ramp('sensor-signal', 0, 0)],
      },
    ]);

    tickAt(start);

    const state = operationsStore.getState();
    const sensors = Object.values(state.sensors);
    const cameras = Object.values(state.cameras);
    expect(sensors.length).toBeGreaterThan(0);
    expect(cameras.length).toBeGreaterThan(0);
    for (const sensor of sensors) {
      expect(sensor.signal).toBe(simulationChannelRanges['sensor-signal'].minimum);
    }
    for (const camera of cameras) {
      expect(camera.signal).toBe(simulationChannelRanges['camera-signal'].maximum);
    }
  });

  it('scatters two sensors’ and two cameras’ readings differently from one seed', () => {
    // The same argument as the system nodes above: without a sample ordinal of
    // its own, every sensor and every camera would move in lockstep.
    settleRun([
      {
        id: 'simulation.valueCurve',
        value: [...ramp('camera-signal', 50, 50), ...ramp('sensor-signal', 50, 50)],
      },
      { id: 'simulation.noise', value: 0.5 },
    ]);

    tickAt(start);

    const sensorSignals = Object.values(operationsStore.getState().sensors).map(
      (sensor) => sensor.signal,
    );
    const cameraSignals = Object.values(operationsStore.getState().cameras).map(
      (camera) => camera.signal,
    );
    expect(new Set(sensorSignals).size).toBeGreaterThan(1);
    expect(new Set(cameraSignals).size).toBeGreaterThan(1);
  });
});

describe('smoothing carries the previous reading forward', () => {
  it('moves half the remaining distance each reading at 0.5', () => {
    settleRun([
      { id: 'simulation.valueCurve', value: ramp('cpu', 100, 100) },
      { id: 'simulation.smoothing', value: 0.5 },
    ]);
    const target = simulationChannelRanges.cpu.maximum;
    const seeded = metric('cpu');

    tickAt(start);
    const first = Math.round(seeded + (target - seeded) / 2);
    expect(metric('cpu')).toBe(first);

    // The second reading is carried from the first *as it was recorded*, which
    // is the reading a screen shows and the history keeps. Smoothing against
    // an unrounded value the world never held would be a second series.
    tickAt(start + 1_000);
    expect(metric('cpu')).toBe(Math.round(first + (target - first) / 2));
  });

  it('follows the curve exactly at 0, so the reading owes nothing to the last one', () => {
    settleRun([{ id: 'simulation.valueCurve', value: ramp('cpu', 100, 100) }]);

    tickAt(start);

    expect(metric('cpu')).toBe(simulationChannelRanges.cpu.maximum);
  });
});

describe('the moment is an argument, so a run is reproducible', () => {
  it('lands on the same phase however many ticks the interval was split into', () => {
    // Two half-second ticks and one full-second tick spend the same second.
    // A run that counted steps instead of milliseconds could not agree here.
    settleRun([{ id: 'simulation.valueCurve', value: ramp('cpu', 0, 100) }]);
    tickAt(start, start + 500, start + 1_000);
    const split = metric('cpu');

    settleRun([{ id: 'simulation.valueCurve', value: ramp('cpu', 0, 100) }]);
    tickAt(start, start + 1_000);

    expect(metric('cpu')).toBe(split);
    expect(operationsStore.getState().metrics.elapsedMs).toBe(1_000);
  });

  it('spends the timeline at the scale the operator asked for', () => {
    // The same elapsed second, twice, at two scales. The phase is the only
    // thing between them, so a run that stored `simulation.timeScale` without
    // reading it would land on one reading both times.
    const { minimum, maximum } = simulationChannelRanges.cpu;
    settleRun([{ id: 'simulation.valueCurve', value: ramp('cpu', 0, 100) }]);
    tickAt(start, start + 1_000);
    const atOne = metric('cpu');

    settleRun([
      { id: 'simulation.valueCurve', value: ramp('cpu', 0, 100) },
      { id: 'simulation.timeScale', value: 2 },
    ]);
    tickAt(start, start + 1_000);

    // The period is ten seconds: one second of it is a tenth of the curve at
    // scale 1 and a fifth at scale 2.
    expect(atOne).toBe(Math.round(minimum + 0.1 * (maximum - minimum)));
    expect(metric('cpu')).toBe(Math.round(minimum + 0.2 * (maximum - minimum)));
  });

  it('timestamps the world from the moment it was handed, not from a clock', () => {
    settleRun();

    tickAt(start + 7_000);

    expect(operationsStore.getState().objects['K-17']?.lastSeenAt).toBe(
      new Date(start + 7_000).toISOString(),
    );
  });

  it('replays identically for the same moments and settings', () => {
    settleRun([
      { id: 'simulation.valueCurve', value: ramp('cpu', 10, 90) },
      { id: 'simulation.noise', value: 0.2 },
      { id: 'simulation.seed', value: 4_242 },
    ]);
    tickAt(start, start + 1_000, start + 2_000);
    const first = operationsStore.getState().metricsHistory.cpu;

    settleRun([
      { id: 'simulation.valueCurve', value: ramp('cpu', 10, 90) },
      { id: 'simulation.noise', value: 0.2 },
      { id: 'simulation.seed', value: 4_242 },
    ]);
    tickAt(start, start + 1_000, start + 2_000);

    expect(operationsStore.getState().metricsHistory.cpu).toEqual(first);
  });

  it('produces one series per seed, and the same one every time for a seed', () => {
    /*
     * Reproducibility alone is not determinism. A run that ignored
     * `simulation.seed` entirely would replay identically too, and would then
     * report the same world on a machine the operator had seeded differently.
     * The pair of claims is the whole property: same seed, same series; other
     * seed, other series.
     *
     * The readings are taken tick by tick rather than from the history, because
     * the history opens on the reading `resetWorld` seeded the world with,
     * which no seed setting reaches and which both runs therefore share.
     */
    const scattered = (seed: number): readonly number[] => {
      settleRun([
        // A flat curve, so every difference between the two runs is scatter and
        // not the curve moving underneath it.
        { id: 'simulation.valueCurve', value: ramp('cpu', 50, 50) },
        { id: 'simulation.noise', value: 0.3 },
        { id: 'simulation.seed', value: seed },
      ]);
      const readings: number[] = [];
      for (const moment of [start, start + 1_000, start + 2_000, start + 3_000]) {
        operationsStore.getState().simulationTick(moment);
        readings.push(metric('cpu'));
      }
      return readings;
    };

    const first = scattered(1);
    const again = scattered(1);
    const other = scattered(4_242);

    expect(again).toEqual(first);
    // Every reading moved, not merely the series as a whole: a seed that
    // reached only the first sample would leave the rest in step.
    expect(other).toHaveLength(first.length);
    expect(other.filter((value, index) => value === first[index])).toEqual([]);
  });

  it('scatters two series of one channel differently from one seed', () => {
    // Every node reads the same curve, at the same phase, from the same seed,
    // and their range is the one range of `node-load`. Only the sample index
    // tells them apart, and without it the whole world would move in lockstep
    // -- ten nodes reporting one number to the digit.
    settleRun([
      { id: 'simulation.valueCurve', value: ramp('node-load', 50, 50) },
      { id: 'simulation.noise', value: 0.5 },
    ]);

    tickAt(start);

    const loads = Object.values(operationsStore.getState().systemNodes).map((node) => node.load);
    expect(loads.length).toBeGreaterThan(1);
    expect(new Set(loads).size).toBeGreaterThan(1);
  });

  it('draws the curve and nothing around it once the scatter is off', () => {
    // The other half of the case above, and the reason the two are worth
    // stating together: with `simulation.noise` at zero the same nodes collapse
    // onto one number, so the spread above is the setting's doing and not the
    // fixture's.
    settleRun([{ id: 'simulation.valueCurve', value: ramp('node-load', 50, 50) }]);

    tickAt(start);

    const { minimum, maximum } = simulationChannelRanges['node-load'];
    const loads = Object.values(operationsStore.getState().systemNodes).map((node) => node.load);
    expect(loads.length).toBeGreaterThan(1);
    expect(new Set(loads)).toEqual(new Set([Math.round(minimum + 0.5 * (maximum - minimum))]));
  });
});

describe('the tick cadence is the operator’s, and a pause is not spent', () => {
  it('does not advance the run while the simulation is paused', () => {
    settleRun();
    tickAt(start, start + 1_000);
    const elapsed = operationsStore.getState().metrics.elapsedMs;
    operationsStore.getState().setProductionOption('paused', true);

    tickAt(start + 2_000, start + 3_000);

    expect(operationsStore.getState().metrics.elapsedMs).toBe(elapsed);
    expect(operationsStore.getState().metrics.simulationStep).toBe(2);
  });

  it('does not carry a whole pause into the curve when the run resumes', () => {
    settleRun();
    tickAt(start, start + 1_000);
    const elapsed = operationsStore.getState().metrics.elapsedMs;
    operationsStore.getState().setProductionOption('paused', true);
    tickAt(start + 600_000);
    operationsStore.getState().setProductionOption('paused', false);

    tickAt(start + 601_000);

    // Ten minutes passed on the wall clock. The run spends four of the
    // intervals it asked for and no more.
    expect(operationsStore.getState().metrics.elapsedMs).toBe(elapsed + 4_000);
  });
});

describe('the metric history is a bounded ring buffer', () => {
  it('keeps the last readings and no more, however long the session runs', () => {
    // A looping curve, so no two consecutive readings are the same number and
    // a buffer trimmed from the wrong end cannot pass by holding still.
    settleRun([
      { id: 'simulation.valueCurve', value: ramp('cpu', 0, 100) },
      { id: 'simulation.loop', value: true },
    ]);
    const taken: number[] = [operationsStore.getState().metricsHistory.cpu[0] ?? 0];

    for (let index = 0; index <= metricsHistoryDepth * 2; index += 1) {
      operationsStore.getState().simulationTick(start + index * 1_000);
      taken.push(metric('cpu'));
    }

    const history = operationsStore.getState().metricsHistory;
    for (const series of Object.values(history)) {
      expect(series).toHaveLength(metricsHistoryDepth);
    }
    // The window is the last readings taken, in order: not the first ones the
    // session happened to see, and not a buffer that stopped accepting.
    expect(history.cpu).toEqual(taken.slice(-metricsHistoryDepth));
  });

  it('starts from the reading the world opens on rather than from an invented sample', () => {
    operationsStore.getState().resetWorld();
    const state = operationsStore.getState();

    expect(state.metricsHistory.cpu).toEqual([state.metrics.cpu]);
    expect(state.metricsHistory.readiness).toEqual([state.metrics.readiness]);
  });

  it('records every reading the tick produced, in order', () => {
    settleRun([{ id: 'simulation.valueCurve', value: ramp('cpu', 0, 100) }]);
    const opening = operationsStore.getState().metricsHistory.cpu;

    tickAt(start, start + 1_000);

    const { minimum, maximum } = simulationChannelRanges.cpu;
    expect(operationsStore.getState().metricsHistory.cpu).toEqual([
      ...opening,
      minimum,
      Math.round(minimum + 0.1 * (maximum - minimum)),
    ]);
  });
});

describe('the criticality curve decides how high a reading may climb', () => {
  it('caps the reading inside the band the second curve allows', () => {
    settleRun([
      { id: 'simulation.valueCurve', value: ramp('cpu', 100, 100) },
      { id: 'simulation.criticalityCurve', value: ramp('cpu', 0.25, 0.25) },
    ]);
    const { minimum, maximum } = simulationChannelRanges.cpu;

    tickAt(start);

    expect(metric('cpu')).toBe(Math.round(minimum + 0.25 * (maximum - minimum)));
  });

  it('gives a generated event the band the curve reports', () => {
    settleRun([
      { id: 'simulation.updateIntervalMs', value: 5_000 },
      { id: 'simulation.criticalityCurve', value: ramp('cpu', 0.9, 0.9) },
    ]);

    tickAt(start, start + 16_000);

    const generated = operationsStore.getState().events[0];
    expect(generated?.source).toBe('SIMULATION');
    expect(generated?.severity).toBe('critical');
  });

  it('reads the middle bands as a warning rather than as an alarm', () => {
    settleRun([
      { id: 'simulation.updateIntervalMs', value: 5_000 },
      { id: 'simulation.criticalityCurve', value: ramp('cpu', 0.6, 0.6) },
    ]);

    tickAt(start, start + 16_000);

    expect(operationsStore.getState().events[0]?.severity).toBe('warning');
  });

  it('reports a normal band while no criticality curve is drawn', () => {
    settleRun([{ id: 'simulation.updateIntervalMs', value: 5_000 }]);

    tickAt(start, start + 16_000);

    expect(operationsStore.getState().events[0]?.severity).toBe('normal');
  });

  it('reports the band a marked preset stands for when no curve is drawn either', () => {
    // R31's remaining gap: before `simulation.preset` had a reader, every
    // generated event read `normal` regardless of which preset was marked.
    settleRun([
      { id: 'simulation.updateIntervalMs', value: 5_000 },
      { id: 'simulation.preset', value: 'critical' },
    ]);

    tickAt(start, start + 16_000);

    expect(operationsStore.getState().events[0]?.severity).toBe('critical');
  });

  it('generates one event per interval of run time rather than per tick', () => {
    settleRun();
    const opening = operationsStore.getState().events.length;

    // Fourteen seconds at one second a tick: fifteen readings, and not one
    // event, where a tick counter would have produced four.
    for (let index = 0; index <= 14; index += 1) {
      operationsStore.getState().simulationTick(start + index * 1_000);
    }
    expect(operationsStore.getState().events).toHaveLength(opening);

    operationsStore.getState().simulationTick(start + 15_000);
    expect(operationsStore.getState().events).toHaveLength(opening + 1);
  });
});
