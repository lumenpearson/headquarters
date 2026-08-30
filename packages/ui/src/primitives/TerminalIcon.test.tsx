// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { iconNames, iconSetIds } from '../icons/types.js';
import { TerminalIcon } from './TerminalIcon.js';

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

const svg = (container: HTMLElement): SVGSVGElement => {
  const element = container.querySelector('svg');
  if (element === null) throw new Error('no svg rendered');
  return element;
};

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalIcon', () => {
  it('draws from the terminal adapter by default', () => {
    const rendered = svg(mount(<TerminalIcon name="close" />));
    expect(rendered.getAttribute('aria-hidden')).toBe('true');
    expect(rendered.getAttribute('viewBox')).toBe('0 0 24 24');
    // The terminal 'close' mark is two crossing lines, nothing else.
    expect(rendered.children).toHaveLength(2);
    expect(Array.from(rendered.children).every((child) => child.tagName === 'line')).toBe(true);
  });

  /*
   * The contract every call site's own CSS depends on. Broken once already:
   * an early draft rendered `<svg width={size} height={size} stroke={color}>`
   * directly, which meant `.settings-card__icon svg`'s own `width: 100%` and
   * `stroke: currentColor` rules were fighting a same-element attribute
   * instead of an inherited default, and a settings card rendered at its
   * native 24px instead of the 30px the wrapper asks for.
   */
  it('emits no width, height, stroke or color attribute on the svg itself, for any name in any library', () => {
    for (const iconSet of iconSetIds) {
      for (const name of iconNames) {
        const rendered = svg(mount(<TerminalIcon name={name} iconSet={iconSet} />));
        expect(rendered.getAttribute('width'), `${iconSet}/${name}`).toBeNull();
        expect(rendered.getAttribute('height'), `${iconSet}/${name}`).toBeNull();
        expect(rendered.getAttribute('stroke'), `${iconSet}/${name}`).toBeNull();
        expect(rendered.getAttribute('color'), `${iconSet}/${name}`).toBeNull();
      }
    }
  });

  /*
   * The failure mode `HugeiconsIcon` and lucide's/tabler's own component
   * would each cause: a per-path `stroke`/`stroke-width` baked in by the
   * library breaks CSS inheritance from the `<svg>` down to that path even
   * though the outer element carries neither. lucide and tabler's raw nodes
   * never had this problem (`d`/`key` only); hugeicons' adapter strips it.
   * `terminal`'s own two hand-drawn exceptions (`appearance`'s pie slice,
   * `media`'s play mark) are excluded on purpose -- they are first-party
   * `fill="currentColor" stroke="none"` overrides `settingsCardIcons.tsx`
   * always drew, not a library leaking its own defaults.
   */
  it('leaves no per-child stroke or stroke-width from a switchable library', () => {
    const withoutHandDrawnExceptions = iconNames.filter(
      (name) => name !== 'appearance' && name !== 'media',
    );
    for (const iconSet of iconSetIds.filter((id) => id !== 'terminal')) {
      for (const name of withoutHandDrawnExceptions) {
        const rendered = svg(mount(<TerminalIcon name={name} iconSet={iconSet} />));
        for (const child of Array.from(rendered.children)) {
          expect(child.getAttribute('stroke'), `${iconSet}/${name} child`).toBeNull();
          expect(child.getAttribute('stroke-width'), `${iconSet}/${name} child`).toBeNull();
        }
      }
    }
  });

  it('falls back to the terminal adapter for an iconSet it does not recognise', () => {
    const known = svg(mount(<TerminalIcon name="menu" iconSet="terminal" />));
    const unknown = svg(mount(<TerminalIcon name="menu" iconSet="a-library-that-was-removed" />));
    expect(unknown.innerHTML).toBe(known.innerHTML);
  });

  it('carries a size hint as a custom property, never as a width/height attribute', () => {
    const rendered = svg(mount(<TerminalIcon name="menu" size={18} />));
    expect(rendered.getAttribute('width')).toBeNull();
    expect(rendered.getAttribute('height')).toBeNull();
    expect(rendered.style.getPropertyValue('--terminal-icon-size')).toBe('18px');
  });

  it('draws a different shape once the library changes, for the same name', () => {
    const terminal = svg(mount(<TerminalIcon name="close" iconSet="terminal" />)).innerHTML;
    const lucide = svg(mount(<TerminalIcon name="close" iconSet="lucide" />)).innerHTML;
    const hugeicons = svg(mount(<TerminalIcon name="close" iconSet="hugeicons" />)).innerHTML;
    const tabler = svg(mount(<TerminalIcon name="close" iconSet="tabler" />)).innerHTML;
    const shapes = new Set([terminal, lucide, hugeicons, tabler]);
    expect(shapes.size).toBe(4);
  });

  it('appends a caller class after its own', () => {
    const rendered = svg(mount(<TerminalIcon name="menu" className="ops-titlebar__glyph" />));
    expect(rendered.classList.contains('terminal-icon')).toBe(true);
    expect(rendered.className.baseVal.endsWith('ops-titlebar__glyph')).toBe(true);
  });
});
