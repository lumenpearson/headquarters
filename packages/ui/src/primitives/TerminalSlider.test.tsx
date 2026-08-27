// @vitest-environment jsdom
import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TerminalSlider } from './TerminalSlider.js';
import type { TerminalSliderProps } from './TerminalSlider.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns the track geometry, the hidden range input and the keyboard
 * stepping, so none of that is asserted here -- only what the wrapper adds: the
 * `data-adjusting` state R23 asks for, the single-argument callback it narrows
 * the library's pair down to, the raw value it prints instead of the formatted
 * one, and the label it pushes onto the thumb.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The control is laid out as 200 x 8 px at the origin; jsdom performs no layout of its own. */
const controlRect = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 200,
  bottom: 8,
  width: 200,
  height: 8,
  toJSON: () => ({}),
} as DOMRect;

type HarnessProps = Omit<TerminalSliderProps, 'value' | 'onValueChange' | 'label'> & {
  readonly initial: number;
  readonly onChange: (value: number) => void;
};

/** A controlled owner, as the consumers in apps/hq are: every change is fed back as the next `value`. */
function Harness({ initial, onChange, ...rest }: HarnessProps) {
  const [value, setValue] = useState(initial);
  return (
    <TerminalSlider
      {...rest}
      label="Громкость"
      value={value}
      onValueChange={(next) => {
        onChange(next);
        setValue(next);
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

function query(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} not rendered`);
  return element;
}

const root = (container: HTMLElement): HTMLElement => query(container, '.terminal-slider');

const control = (container: HTMLElement): HTMLElement =>
  query(container, '.terminal-slider__control');

const thumbInput = (container: HTMLElement): HTMLInputElement => {
  const input = container.querySelector<HTMLInputElement>('input[type="range"]');
  if (input === null) throw new Error('thumb input not rendered');
  return input;
};

const firstCall = (onChange: ReturnType<typeof vi.fn>): unknown[] => {
  const call: unknown[] | undefined = onChange.mock.calls.at(0);
  if (call === undefined) throw new Error('onValueChange was never called');
  return call;
};

const PointerEventConstructor: typeof MouseEvent =
  typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;

function pointer(target: Element, type: 'pointerdown' | 'pointerup', clientX: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEventConstructor(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: 4,
        button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        ...({ pointerId: 1 } as PointerEventInit),
      }),
    );
  });
}

/*
 * Where the press lands on the track is Base UI's arithmetic, and under jsdom it
 * runs against a fabricated rect and the default border width, so no test here
 * asserts which value comes out -- only that one did, and that the wrapper
 * carried it. Focusing the thumb first keeps Base UI from deferring its own
 * focus call into an animation frame outside `act`.
 */
function pressTrack(container: HTMLElement, clientX: number): void {
  act(() => thumbInput(container).focus());
  pointer(control(container), 'pointerdown', clientX);
}

beforeAll(() => {
  // jsdom implements neither pointer capture nor layout.
  Object.assign(Element.prototype, {
    setPointerCapture(): void {},
    releasePointerCapture(): void {},
    hasPointerCapture(): boolean {
      return true;
    },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(controlRect);
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalSlider', () => {
  it('marks itself adjusting while the pointer changes the value and clears it on release', () => {
    const onChange = vi.fn();
    const container = mount(<Harness initial={0} onChange={onChange} />);
    expect(root(container).hasAttribute('data-adjusting')).toBe(false);

    pressTrack(container, 150);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(root(container).getAttribute('data-adjusting')).toBe('');

    // Base UI reports the settled value separately, and only then is the cursor released.
    pointer(control(container), 'pointerup', 150);
    expect(root(container).hasAttribute('data-adjusting')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('hands the consumer the new value alone, without the library event details', () => {
    const onChange = vi.fn();
    const container = mount(<Harness initial={0} onChange={onChange} min={0} max={200} />);
    pressTrack(container, 150);

    const call = firstCall(onChange);
    // One argument, a number: Base UI passes `(value, eventDetails)`, the wrapper passes the value.
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe('number');
    expect(call[0]).not.toBe(0);
    // What the consumer was told is what the control adopted.
    expect(thumbInput(container).value).toBe(String(call[0]));
  });

  it('prints the raw value it was given rather than the locale-formatted text', () => {
    const container = mount(
      <Harness initial={1234.5} onChange={vi.fn()} min={0} max={2000} step={0.5} />,
    );
    // Base UI's own readout would group the thousands; this one is the prop as given.
    expect(query(container, 'output').textContent).toBe('1234.5');
  });

  it('names the thumb with the slider label, and hides the readout when asked', () => {
    const labelled = mount(<Harness initial={10} onChange={vi.fn()} className="hq-mixer__fader" />);
    const input = thumbInput(labelled);
    expect(input.getAttribute('aria-label')).toBe('Громкость');
    // A label of its own displaces the label element Base UI would otherwise point the thumb at.
    expect(input.hasAttribute('aria-labelledby')).toBe(false);
    expect(root(labelled).className).toBe('terminal-slider hq-mixer__fader');
    expect(labelled.querySelector('output')).not.toBeNull();

    const quiet = mount(<Harness initial={10} onChange={vi.fn()} showValue={false} />);
    expect(quiet.querySelector('output')).toBeNull();
    expect(thumbInput(quiet).getAttribute('aria-label')).toBe('Громкость');
  });

  it('accepts nothing from the pointer while disabled and never reports itself adjusting', () => {
    const onChange = vi.fn();
    const container = mount(<Harness initial={10} onChange={onChange} disabled />);
    expect(thumbInput(container).disabled).toBe(true);

    pressTrack(container, 150);
    expect(onChange).not.toHaveBeenCalled();
    expect(root(container).hasAttribute('data-adjusting')).toBe(false);
    expect(thumbInput(container).value).toBe('10');
  });

  it('stays marked adjusting for good when it is disabled mid-press', () => {
    /*
     * Defect, pinned deliberately: `adjusting` is cleared by nothing but
     * `onValueCommitted` (TerminalSlider.tsx:60), and Base UI drops its release
     * listeners the moment the slider turns disabled, so the commit never
     * arrives and the R23 cursor never comes off. Clearing the flag when
     * `disabled` turns on must fail this assertion.
     */
    const onChange = vi.fn();
    const container = mount(<Harness initial={0} onChange={onChange} />);
    const entry = mounted.at(-1);
    if (entry === undefined) throw new Error('nothing mounted');

    pressTrack(container, 150);
    expect(root(container).getAttribute('data-adjusting')).toBe('');

    act(() => entry.root.render(<Harness initial={0} onChange={onChange} disabled />));
    pointer(control(container), 'pointerup', 150);
    expect(root(container).getAttribute('data-adjusting')).toBe('');
  });
});
