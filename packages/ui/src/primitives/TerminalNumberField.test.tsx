// @vitest-environment jsdom
import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalNumberField } from './TerminalNumberField.js';
import type { TerminalNumberFieldProps } from './TerminalNumberField.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI supplies the stepping arithmetic and the parsing. What this wrapper
 * adds is the assembled anatomy -- group, two steppers and the input, each
 * under a fixed class -- the Russian accessible names derived from one `label`
 * prop, the `step`/`disabled` defaults, and an `onValueChange` narrowed to the
 * value alone.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HarnessProps = Omit<TerminalNumberFieldProps, 'value' | 'onValueChange'> & {
  readonly initial: number | null;
  readonly onValueChange: TerminalNumberFieldProps['onValueChange'];
};

/** A controlled owner, as `SchemaSetting` is: every reported value becomes the next `value`. */
function Harness({ initial, onValueChange, ...rest }: HarnessProps) {
  const [value, setValue] = useState(initial);
  return (
    <TerminalNumberField
      {...rest}
      value={value}
      onValueChange={(...args) => {
        // Spread rather than forward one argument, so the spy records the arity
        // the wrapper actually called with.
        onValueChange(...args);
        setValue(args[0]);
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

function find<T extends Element>(container: HTMLElement, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (element === null) throw new Error(`${selector} not rendered`);
  return element;
}

const parts = (container: HTMLElement) => ({
  root: find<HTMLElement>(container, '.terminal-number-field'),
  group: find<HTMLElement>(container, '.terminal-number-field__group'),
  input: find<HTMLInputElement>(container, 'input.terminal-number-field__input'),
  decrement: find<HTMLButtonElement>(container, '.terminal-number-field__step:first-child'),
  increment: find<HTMLButtonElement>(container, '.terminal-number-field__step:last-child'),
});

/** `click()` carries `detail: 0`, which is what Base UI treats as a real press. */
function press(button: HTMLButtonElement): void {
  act(() => button.click());
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalNumberField', () => {
  it('names all three controls from the single label prop and lays them out under fixed classes', () => {
    const container = mount(
      <Harness
        initial={4}
        label="Задержка"
        onValueChange={vi.fn()}
        className="cue-editor__delay"
      />,
    );
    const { root, group, input, decrement, increment } = parts(container);

    expect(root.getAttribute('class')).toBe('terminal-number-field cue-editor__delay');
    expect(group.parentElement).toBe(root);
    expect(input.parentElement).toBe(group);
    expect(decrement.getAttribute('aria-label')).toBe('Уменьшить: Задержка');
    expect(input.getAttribute('aria-label')).toBe('Задержка');
    expect(increment.getAttribute('aria-label')).toBe('Увеличить: Задержка');
    // The decrement sits before the input and the increment after it.
    expect(decrement.textContent).toBe('[−]');
    expect(increment.textContent).toBe('[+]');
    expect(Array.from(group.children)).toEqual([decrement, input, increment]);
  });

  it('steps by the given step, defaults it to one, and reports the value alone', () => {
    const onValueChange = vi.fn();
    const stepped = mount(
      <Harness initial={10} step={5} label="Задержка" onValueChange={onValueChange} />,
    );
    press(parts(stepped).increment);
    // One argument only: Base UI's second `eventDetails` argument is dropped here.
    expect(onValueChange.mock.calls.at(-1)).toEqual([15]);
    press(parts(stepped).decrement);
    expect(onValueChange.mock.calls.at(-1)).toEqual([10]);

    const defaulted = mount(
      <Harness initial={10} label="Задержка" onValueChange={onValueChange} />,
    );
    press(parts(defaulted).increment);
    expect(onValueChange.mock.calls.at(-1)).toEqual([11]);
  });

  it('forwards min, max and format to the field', () => {
    const onValueChange = vi.fn();
    const container = mount(
      <Harness
        initial={2}
        min={2}
        max={3}
        label="Задержка"
        format={{ minimumFractionDigits: 2 }}
        onValueChange={onValueChange}
      />,
    );
    const { input, decrement, increment } = parts(container);
    // Formatting is Intl's; the assertion is only that the options reached it.
    expect(input.value).toBe(
      new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(2),
    );

    press(decrement);
    expect(onValueChange).not.toHaveBeenCalled();
    press(increment);
    expect(onValueChange.mock.calls.at(-1)).toEqual([3]);
    press(increment);
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it('is enabled by default and inert once disabled', () => {
    const onValueChange = vi.fn();
    const enabled = mount(<Harness initial={4} label="Задержка" onValueChange={onValueChange} />);
    expect(parts(enabled).input.disabled).toBe(false);

    const disabled = mount(
      <Harness initial={4} disabled label="Задержка" onValueChange={onValueChange} />,
    );
    const { root, input, increment, decrement } = parts(disabled);
    expect(root.hasAttribute('data-disabled')).toBe(true);
    expect(input.disabled).toBe(true);
    press(increment);
    press(decrement);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(input.value).toBe('4');
  });
});
