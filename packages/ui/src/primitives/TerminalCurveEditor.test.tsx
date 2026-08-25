// @vitest-environment jsdom
import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TerminalCurveEditor } from './TerminalCurveEditor.js';
import type {
  CurveEditorDomain,
  CurveEditorPoint,
  TerminalCurveEditorProps,
} from './TerminalCurveEditor.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const domain: CurveEditorDomain = { time: [0, 10], value: [0, 1] };

const point = (time: number, value: number): CurveEditorPoint => ({
  time,
  value,
  inTangent: 0,
  outTangent: 0,
});

const threePoints: readonly CurveEditorPoint[] = [point(0, 0.2), point(5, 0.5), point(10, 0.8)];

/** The plot is laid out as 200 x 100 px at the origin; jsdom performs no layout of its own. */
const plotRect = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 200,
  bottom: 100,
  width: 200,
  height: 100,
  toJSON: () => ({}),
} as DOMRect;

type HarnessProps = Omit<
  TerminalCurveEditorProps,
  'points' | 'onPointsChange' | 'path' | 'label'
> & {
  readonly initial: readonly CurveEditorPoint[];
  readonly onChange: (points: readonly CurveEditorPoint[]) => void;
};

/** A controlled owner, as the consumer in apps/hq is: every change is fed back as the next `points`. */
function Harness({ initial, onChange, ...rest }: HarnessProps) {
  const [points, setPoints] = useState(initial);
  return (
    <TerminalCurveEditor
      {...rest}
      label="Кривая"
      points={points}
      path={points}
      onPointsChange={(next) => {
        onChange(next);
        setPoints(next);
      }}
    />
  );
}

const mounted: { root: Root; container: HTMLDivElement }[] = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

const PointerEventConstructor: typeof MouseEvent =
  typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;

function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
): void {
  act(() => {
    target.dispatchEvent(
      new PointerEventConstructor(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
        ...({ pointerId: 1 } as PointerEventInit),
      }),
    );
  });
}

function key(target: Element, name: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }),
    );
  });
}

function doubleClick(target: Element, clientX: number, clientY: number): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY }),
    );
  });
}

const handles = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-handle="point"]'));

const plot = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('.terminal-curve-editor__plot');
  if (element === null) throw new Error('plot not rendered');
  return element;
};

const root = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('.terminal-curve-editor');
  if (element === null) throw new Error('editor not rendered');
  return element;
};

const lastPoints = (onChange: ReturnType<typeof vi.fn>): readonly CurveEditorPoint[] => {
  const call = onChange.mock.calls.at(-1);
  if (call === undefined) throw new Error('onPointsChange was never called');
  return call[0] as readonly CurveEditorPoint[];
};

beforeAll(() => {
  // jsdom implements neither pointer capture nor layout.
  Object.assign(Element.prototype, {
    setPointerCapture(): void {},
    releasePointerCapture(): void {},
    hasPointerCapture(): boolean {
      return true;
    },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(plotRect);
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalCurveEditor', () => {
  it('renders one slider handle per point with the value axis in its aria attributes', () => {
    const container = mount(<Harness initial={threePoints} onChange={vi.fn()} domain={domain} />);
    const rendered = handles(container);
    expect(rendered).toHaveLength(3);
    expect(root(container).getAttribute('role')).toBe('group');
    expect(root(container).getAttribute('aria-label')).toBe('Кривая');
    const middle = rendered[1];
    expect(middle?.getAttribute('role')).toBe('slider');
    expect(middle?.getAttribute('tabindex')).toBe('0');
    expect(middle?.getAttribute('aria-valuemin')).toBe('0');
    expect(middle?.getAttribute('aria-valuemax')).toBe('1');
    expect(middle?.getAttribute('aria-valuenow')).toBe('0.5');
    expect(middle?.getAttribute('aria-valuetext')).toBe('0.50 при 5');
    expect(middle?.getAttribute('aria-label')).toBe('Кривая: точка 2 из 3, 5');
    expect(Number.parseFloat(middle?.style.left ?? '')).toBeCloseTo(50, 6);
    expect(Number.parseFloat(middle?.style.top ?? '')).toBeCloseTo(50, 6);
    expect(container.querySelector('.terminal-curve-editor__path')?.getAttribute('d')).toBe(
      'M0.000 80.000 L50.000 50.000 L100.000 20.000',
    );
  });

  it('nudges the value from the keyboard by a hundredth of the range, ten with Shift, clamped to the domain', () => {
    const onChange = vi.fn();
    const container = mount(<Harness initial={threePoints} onChange={onChange} domain={domain} />);
    const middle = handles(container)[1];
    if (middle === undefined) throw new Error('no middle handle');

    key(middle, 'ArrowUp');
    expect(lastPoints(onChange)[1]?.value).toBeCloseTo(0.51, 10);
    key(middle, 'ArrowUp', { shiftKey: true });
    expect(lastPoints(onChange)[1]?.value).toBeCloseTo(0.61, 10);
    // Ten Shift steps from 0.61 would reach 1.61; the domain ends at 1.
    key(middle, 'ArrowUp', { shiftKey: true });
    key(middle, 'ArrowUp', { shiftKey: true });
    key(middle, 'ArrowUp', { shiftKey: true });
    key(middle, 'ArrowUp', { shiftKey: true });
    expect(lastPoints(onChange)[1]?.value).toBe(1);
    const calls = onChange.mock.calls.length;
    // At the ceiling the key changes nothing and the consumer hears nothing.
    key(middle, 'ArrowUp');
    expect(onChange.mock.calls.length).toBe(calls);
    // Every other point is untouched by a nudge.
    expect(lastPoints(onChange)[0]).toEqual(threePoints[0]);
    expect(lastPoints(onChange)[2]).toEqual(threePoints[2]);
    expect(middle.getAttribute('aria-valuenow')).toBe('1');
  });

  it('snaps a nudged value to the grid the consumer asked for', () => {
    const onChange = vi.fn();
    const container = mount(
      <Harness initial={threePoints} onChange={onChange} domain={domain} snap={{ value: 0.25 }} />,
    );
    const middle = handles(container)[1];
    if (middle === undefined) throw new Error('no middle handle');
    key(middle, 'ArrowUp');
    expect(lastPoints(onChange)[1]?.value).toBe(0.75);
  });

  it('keeps the endpoints on the domain edges: only their value moves', () => {
    const onChange = vi.fn();
    const container = mount(<Harness initial={threePoints} onChange={onChange} domain={domain} />);
    const first = handles(container)[0];
    if (first === undefined) throw new Error('no first handle');
    key(first, 'ArrowRight');
    expect(onChange).not.toHaveBeenCalled();
    key(first, 'ArrowUp');
    expect(lastPoints(onChange)[0]?.time).toBe(0);
    expect(lastPoints(onChange)[0]?.value).toBeCloseTo(0.21, 10);
  });

  it('removes a point with Delete while more than minPoints remain, and never an endpoint', () => {
    const onChange = vi.fn();
    const container = mount(
      <Harness initial={threePoints} onChange={onChange} domain={domain} minPoints={3} />,
    );
    const middle = handles(container)[1];
    if (middle === undefined) throw new Error('no middle handle');
    key(middle, 'Delete');
    expect(onChange).not.toHaveBeenCalled();
    expect(handles(container)).toHaveLength(3);

    const loose = mount(<Harness initial={threePoints} onChange={onChange} domain={domain} />);
    const first = handles(loose)[0];
    const second = handles(loose)[1];
    if (first === undefined || second === undefined) throw new Error('handles missing');
    key(first, 'Delete');
    expect(onChange).not.toHaveBeenCalled();
    act(() => second.focus());
    key(second, 'Delete');
    expect(lastPoints(onChange).map((entry) => entry.time)).toEqual([0, 10]);
    expect(handles(loose)).toHaveLength(2);
    expect(document.activeElement).toBe(handles(loose)[0]);
  });

  it('adds a point from the keyboard at the widest gap, on the drawn line, up to maxPoints', () => {
    const onChange = vi.fn();
    const uneven: readonly CurveEditorPoint[] = [point(0, 0), point(2, 0.2), point(10, 1)];
    const container = mount(
      <Harness initial={uneven} onChange={onChange} domain={domain} maxPoints={3} />,
    );
    key(plot(container), 'Enter');
    expect(onChange).not.toHaveBeenCalled();

    const roomy = mount(
      <Harness initial={uneven} onChange={onChange} domain={domain} maxPoints={4} />,
    );
    key(plot(roomy), 'Enter');
    const next = lastPoints(onChange);
    expect(next.map((entry) => entry.time)).toEqual([0, 2, 6, 10]);
    // The drawn path is the linear polyline through the points here, so the
    // new point sits on the chord between (2, 0.2) and (10, 1).
    expect(next[2]?.value).toBeCloseTo(0.6, 10);
    expect(next[2]?.inTangent).toBeCloseTo(0.1, 10);
    expect(handles(roomy)).toHaveLength(4);
    expect(document.activeElement).toBe(handles(roomy)[2]);
    key(plot(roomy), ' ');
    expect(handles(roomy)).toHaveLength(4);
  });

  it('adds a point where the plot was double-clicked', () => {
    const onChange = vi.fn();
    const container = mount(<Harness initial={threePoints} onChange={onChange} domain={domain} />);
    // 200 x 100 px plot: x=150 is 75% of the time span, y=25 is 75% of the value span.
    doubleClick(plot(container), 150, 25);
    const next = lastPoints(onChange);
    expect(next.map((entry) => entry.time)).toEqual([0, 5, 7.5, 10]);
    expect(next[2]?.value).toBeCloseTo(0.75, 10);
  });

  it('drags a point with the pointer, commits on every move and never lets it cross a neighbour', () => {
    const onChange = vi.fn();
    const container = mount(<Harness initial={threePoints} onChange={onChange} domain={domain} />);
    const middle = handles(container)[1];
    if (middle === undefined) throw new Error('no middle handle');

    pointer(middle, 'pointerdown', 100, 50);
    // Under the travel threshold nothing is committed and nothing is adjusting.
    pointer(middle, 'pointermove', 102, 52);
    expect(onChange).not.toHaveBeenCalled();
    expect(root(container).hasAttribute('data-adjusting')).toBe(false);

    pointer(middle, 'pointermove', 120, 30);
    expect(root(container).hasAttribute('data-adjusting')).toBe(true);
    expect(lastPoints(onChange)[1]?.time).toBeCloseTo(6, 10);
    expect(lastPoints(onChange)[1]?.value).toBeCloseTo(0.7, 10);

    // Far past the last point: the time stops one minimum gap short of it.
    pointer(middle, 'pointermove', 400, 30);
    const next = lastPoints(onChange);
    expect(next[1]?.time).toBeCloseTo(10 - 10 / 1000, 10);
    expect(next.map((entry) => entry.time)).toEqual(
      [...next.map((entry) => entry.time)].sort((a, b) => a - b),
    );
    expect(new Set(next.map((entry) => entry.time)).size).toBe(3);

    pointer(middle, 'pointerup', 400, 30);
    expect(root(container).hasAttribute('data-adjusting')).toBe(false);
    const calls = onChange.mock.calls.length;
    // A move after the release is not a drag.
    pointer(middle, 'pointermove', 50, 50);
    expect(onChange.mock.calls.length).toBe(calls);
  });

  it('drags a tangent handle into a slope relative to its point', () => {
    const onChange = vi.fn();
    const container = mount(
      <Harness initial={threePoints} onChange={onChange} domain={domain} showTangents />,
    );
    const outHandle = container.querySelector<HTMLElement>('[data-handle="out"][data-index="1"]');
    const inHandle = container.querySelector<HTMLElement>('[data-handle="in"][data-index="1"]');
    if (outHandle === null || inHandle === null) throw new Error('tangent handles missing');
    expect(container.querySelectorAll('[data-handle="in"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-handle="out"]')).toHaveLength(3);
    expect(outHandle.getAttribute('role')).toBe('slider');
    expect(outHandle.getAttribute('aria-valuemin')).toBe('-3.2');
    expect(outHandle.getAttribute('aria-valuemax')).toBe('3.2');

    // From the point at (100, 50) to (150, 25): a quarter of each span, so a
    // unit slope of 1 -- in value per time, 1 * (1 / 10).
    pointer(outHandle, 'pointerdown', 110, 45);
    pointer(outHandle, 'pointermove', 150, 25);
    expect(lastPoints(onChange)[1]?.outTangent).toBeCloseTo(0.1, 10);
    expect(lastPoints(onChange)[1]?.inTangent).toBe(0);
    pointer(outHandle, 'pointerup', 150, 25);

    key(inHandle, 'ArrowDown');
    expect(lastPoints(onChange)[1]?.inTangent).toBeCloseTo(-0.02, 10);
    expect(lastPoints(onChange)[1]?.outTangent).toBeCloseTo(0.1, 10);
  });

  it('ignores every input when read-only and says so', () => {
    const onChange = vi.fn();
    const container = mount(
      <Harness initial={threePoints} onChange={onChange} domain={domain} readOnly />,
    );
    expect(root(container).hasAttribute('data-readonly')).toBe(true);
    const middle = handles(container)[1];
    if (middle === undefined) throw new Error('no middle handle');
    expect(middle.getAttribute('aria-readonly')).toBe('true');
    expect(handles(container)).toHaveLength(3);

    key(middle, 'ArrowUp');
    key(middle, 'Delete');
    key(plot(container), 'Enter');
    doubleClick(plot(container), 150, 25);
    pointer(middle, 'pointerdown', 100, 50);
    pointer(middle, 'pointermove', 140, 20);
    pointer(middle, 'pointerup', 140, 20);
    expect(onChange).not.toHaveBeenCalled();
    expect(root(container).hasAttribute('data-adjusting')).toBe(false);
  });
});
