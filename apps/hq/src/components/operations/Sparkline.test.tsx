// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sparkline } from './OpsUi';

/**
 * What a sparkline does with a series whose range is not the one it assumed.
 *
 * Every plot in the application used to divide its values by three and clamp
 * the result into a fixed band, so a caller with megabytes per second scaled
 * the numbers by hand at the call site and anything above the ceiling flattened
 * into a straight line at the top of the box without saying so. R31 gives the
 * plots a real series, and a real series has whatever range its channel has.
 */
function heights(container: HTMLElement): readonly number[] {
  const points = container.querySelector('polyline')?.getAttribute('points') ?? '';
  return points
    .split(' ')
    .filter((pair) => pair.length > 0)
    .map((pair) => Number(pair.split(',')[1]));
}

describe('a sparkline plots the series it was handed', () => {
  it('does not flatten a series that leaves the old hard-coded range', () => {
    // Under the previous arithmetic every one of these read as the ceiling:
    // 300/3, 450/3 and 600/3 all clamp to the same height.
    const { container } = render(<Sparkline values={[300, 450, 600]} label="Трафик" />);

    const drawn = heights(container);
    expect(new Set(drawn).size).toBe(3);
    // Larger reading, higher point: the y axis grows downwards.
    expect(drawn[0]).toBeGreaterThan(drawn[1] ?? 0);
    expect(drawn[1]).toBeGreaterThan(drawn[2] ?? 0);
  });

  it('spans the domain it is given rather than the values it received', () => {
    const { container } = render(
      <Sparkline values={[50, 100]} domain={[0, 200]} label="Загрузка" />,
    );

    const drawn = heights(container);
    const [low, high] = [drawn[0] ?? 0, drawn[1] ?? 0];
    // A quarter and a half of the declared domain, not the bottom and the top
    // of an axis fitted to the two readings.
    expect(low).toBeLessThan(34);
    expect(high).toBeLessThan(low);
    expect(high).toBeGreaterThan(2);
  });

  it('holds a reading past the top of a declared domain at the ceiling', () => {
    const { container } = render(<Sparkline values={[0, 500]} domain={[0, 100]} label="Пик" />);

    const drawn = heights(container);
    expect(drawn[1]).toBe(2);
  });

  it('draws one reading as a line across the plot instead of an invisible vertex', () => {
    const { container } = render(<Sparkline values={[42]} label="Один отсчёт" />);

    const points = container.querySelector('polyline')?.getAttribute('points') ?? '';
    expect(points.split(' ')).toHaveLength(2);
    expect(points.startsWith('0,')).toBe(true);
    expect(points).toContain('100,');
  });

  it('draws a flat series through the middle rather than collapsing it to the floor', () => {
    const { container } = render(<Sparkline values={[70, 70, 70]} label="Ровно" />);

    for (const height of heights(container)) expect(height).toBe(18);
  });

  it('draws no line at all when there is nothing to plot', () => {
    const { container } = render(<Sparkline values={[]} label="Пусто" />);

    expect(container.querySelector('polyline')).toBeNull();
    // The grid stays, so a panel does not lose its shape while a series fills.
    expect(container.querySelector('path')).not.toBeNull();
  });

  it('ignores a reading that is not a number rather than drawing NaN', () => {
    const { container } = render(
      <Sparkline values={[10, Number.NaN, 30]} domain={[0, 100]} label="С пропуском" />,
    );

    const drawn = heights(container);
    expect(drawn).toHaveLength(2);
    for (const height of drawn) expect(Number.isFinite(height)).toBe(true);
  });
});
