// @vitest-environment jsdom
import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalSwitch } from './TerminalSwitch.js';
import type { TerminalSwitchProps } from './TerminalSwitch.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns the switch state machine and its ARIA state. What is under test
 * is the wrapper's own layer: the native <button> it renders in place of Base
 * UI's default <span>, the `is-active` class it adds on top of Base UI's
 * `data-checked`, the on/off captions and their defaults, `label` mapped onto
 * the accessible name, and the change callback narrowed to a single boolean.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLDivElement }[] = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

const control = (container: HTMLElement): HTMLButtonElement => {
  const element = container.querySelector<HTMLButtonElement>('.terminal-switch');
  if (element === null) throw new Error('switch not rendered');
  return element;
};

const caption = (container: HTMLElement): string | null =>
  container.querySelector<HTMLElement>('.terminal-switch__label')?.textContent ?? null;

function click(target: HTMLElement): void {
  act(() => target.click());
}

type HarnessProps = Omit<TerminalSwitchProps, 'checked' | 'onCheckedChange'> & {
  readonly initial: boolean;
};

/** A controlled owner, as every consumer in apps/hq is. */
function Harness({ initial, ...rest }: HarnessProps) {
  const [checked, setChecked] = useState(initial);
  return <TerminalSwitch {...rest} checked={checked} onCheckedChange={setChecked} />;
}

describe('TerminalSwitch', () => {
  it('renders a native non-submitting button with the label, the off caption and a thumb', () => {
    const container = mount(
      <TerminalSwitch
        checked={false}
        onCheckedChange={vi.fn()}
        label="Ночной режим"
        className="settings-row__control"
      />,
    );
    const button = control(container);
    // Base UI renders a <span> unless told otherwise; this wrapper always asks
    // for a real button, and `type="button"` keeps it out of form submission.
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Ночной режим');
    expect(button.disabled).toBe(false);
    expect([...button.classList]).toEqual(['terminal-switch', 'settings-row__control']);
    expect(caption(container)).toBe('[OFF]');
    expect(container.querySelector('.terminal-switch__thumb')).not.toBeNull();
  });

  it('tracks the checked state with the `is-active` class and the on caption', () => {
    const container = mount(<Harness initial={false} label="Ночной режим" />);
    expect(control(container).classList.contains('is-active')).toBe(false);

    click(control(container));
    expect([...control(container).classList]).toEqual(['terminal-switch', 'is-active']);
    expect(caption(container)).toBe('[ON]');

    // The class follows the state back down; it is not a mount-time constant.
    click(control(container));
    expect(control(container).classList.contains('is-active')).toBe(false);
    expect(caption(container)).toBe('[OFF]');
  });

  it('uses the captions the consumer supplies instead of the defaults', () => {
    const container = mount(
      <Harness initial={false} label="Ночной режим" onLabel="[ВКЛ]" offLabel="[ВЫКЛ]" />,
    );
    expect(caption(container)).toBe('[ВЫКЛ]');
    click(control(container));
    expect(caption(container)).toBe('[ВКЛ]');
  });

  it('reports the next checked state as the single argument of onCheckedChange', () => {
    const onCheckedChange = vi.fn();
    const off = mount(
      <TerminalSwitch checked={false} onCheckedChange={onCheckedChange} label="Ночной режим" />,
    );
    click(control(off));
    // Exactly one argument: Base UI also passes event details, which the
    // wrapper drops so consumers can hand it a plain boolean setter.
    expect(onCheckedChange.mock.calls).toEqual([[true]]);

    onCheckedChange.mockClear();
    const on = mount(
      <TerminalSwitch checked onCheckedChange={onCheckedChange} label="Ночной режим" />,
    );
    click(control(on));
    expect(onCheckedChange.mock.calls).toEqual([[false]]);
  });

  it('stays silent and natively disabled when disabled', () => {
    const onCheckedChange = vi.fn();
    const container = mount(
      <TerminalSwitch
        checked={false}
        onCheckedChange={onCheckedChange}
        label="Ночной режим"
        disabled
      />,
    );
    expect(control(container).disabled).toBe(true);
    click(control(container));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
