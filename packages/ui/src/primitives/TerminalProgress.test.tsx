// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { TerminalProgress } from './TerminalProgress.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and read the DOM it
 * produces, and they are already dependencies of the package.
 *
 * Base UI owns the progressbar role, the aria attributes and the indicator
 * width. What is asserted here is what the wrapper adds on top: the
 * `--terminal-progress` custom property the stylesheet fills the track from,
 * the `data-tone` hook, the class-name merge, and the readout it decides to
 * render.
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

function query(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} not rendered`);
  return element;
}

const bar = (container: HTMLElement): HTMLElement => query(container, '.terminal-progress');

/** The stylesheet reads the fill off the indicator's own custom property. */
const fillPercent = (container: HTMLElement): string =>
  query(container, '.terminal-progress__indicator').style.getPropertyValue('--terminal-progress');

const READOUT = '.terminal-progress__header span[aria-hidden="true"]';

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalProgress', () => {
  it('rescales the value onto its own custom property against the min and max it forwards', () => {
    const container = mount(<TerminalProgress value={50} min={20} max={60} label="Загрузка" />);
    // 50 sits three quarters of the way through the 20..60 span.
    expect(fillPercent(container)).toBe('75%');
    expect(bar(container).getAttribute('aria-valuemin')).toBe('20');
    expect(bar(container).getAttribute('aria-valuemax')).toBe('60');
    expect(bar(container).getAttribute('aria-valuenow')).toBe('50');
    expect(query(container, '.terminal-progress__header [role="presentation"]').textContent).toBe(
      'Загрузка',
    );
  });

  it('clamps the custom property to the track and holds it at zero while indeterminate', () => {
    expect(fillPercent(mount(<TerminalProgress value={200} label="Выше" />))).toBe('100%');
    expect(fillPercent(mount(<TerminalProgress value={-40} label="Ниже" />))).toBe('0%');
    // No value means no fill: the wrapper substitutes 0 rather than dividing by null.
    expect(fillPercent(mount(<TerminalProgress value={null} label="Неизвестно" />))).toBe('0%');
  });

  it('defaults the tone to neutral and keeps the consumer class beside its own', () => {
    const neutral = mount(<TerminalProgress value={10} label="Ток" />);
    expect(bar(neutral).getAttribute('data-tone')).toBe('neutral');
    expect(bar(neutral).className).toContain('terminal-progress');

    const critical = mount(
      <TerminalProgress value={10} label="Ток" tone="critical" className="hq-panel__meter" />,
    );
    expect(bar(critical).getAttribute('data-tone')).toBe('critical');
    expect(bar(critical).className).toContain('terminal-progress');
    expect(bar(critical).className.endsWith('hq-panel__meter')).toBe(true);
  });

  it('renders the readout by default and drops it when showValue is off', () => {
    const shown = mount(<TerminalProgress value={50} min={20} max={60} label="Загрузка" />);
    expect(query(shown, READOUT).textContent).toBe('75%');

    const hidden = mount(<TerminalProgress value={50} label="Загрузка" showValue={false} />);
    expect(hidden.querySelector(READOUT)).toBeNull();
    // Hiding the readout must not disturb the track the fill is drawn on.
    expect(fillPercent(hidden)).toBe('50%');
  });

  it('shows the library word for an indeterminate value, never the ellipsis the wrapper asks for', () => {
    /*
     * Defect, pinned deliberately: TerminalProgress.tsx:43 falls back to '…'
     * only when Base UI hands the render function `null`, but Base UI 1.7.0
     * passes the literal string 'indeterminate' instead, so the fallback is
     * dead and an English word reaches a Russian screen. Fixing the wrapper
     * must fail this assertion.
     */
    const container = mount(<TerminalProgress value={null} label="Связь" />);
    expect(query(container, READOUT).textContent).toBe('indeterminate');
  });
});
