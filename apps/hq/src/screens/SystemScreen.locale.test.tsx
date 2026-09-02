// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveFromTables } from '@/application/localization/messages';

import { operationsStore } from '../state/operationsStore.js';
import { SystemScreen } from './SystemScreen.js';

// `TileGrid` calls useRouter() to offer a relocated tile its own screen; the
// stub only has to survive the render, as in the screen's other test files.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// Same stub the screen's other test files set: `TileGrid` measures two boxes
// with `ResizeObserver` before it draws anything, and jsdom performs no
// layout of its own.
globalThis.ResizeObserver = class {
  constructor(private readonly report: (entries: readonly ResizeObserverEntry[]) => void) {}
  observe(target: Element): void {
    const floor = target.classList.contains('tile-grid__floor');
    target.getBoundingClientRect = () =>
      ({ height: floor ? 68 : 900, width: floor ? 0 : 1600 }) as DOMRect;
    this.report([{ target, contentRect: { height: 900, width: 1600 } } as ResizeObserverEntry]);
  }
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

describe('SystemScreen locale', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('translates its header and the system-nodes tile it shares no other screen with', () => {
    const { container } = render(<SystemScreen />);

    expect(container.querySelector('h1')?.textContent).toBe('СИСТЕМА И РЕСУРСЫ');
    const nodesTitle = () =>
      container.querySelector('.system-nodes .ops-panel__header h2')?.textContent;
    expect(nodesTitle()).toBe('СИСТЕМНЫЕ УЗЛЫ');

    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'localization.locale', value: 'en' }]);
    });

    expect(container.querySelector('h1')?.textContent).toBe('SYSTEM AND RESOURCES');
    expect(nodesTitle()).toBe('SYSTEM NODES');
  });

  it('falls back to English rather than Russian for a locale this catalogue has no line for', () => {
    const tables = {
      ru: { 'system.nodesTitle': 'СИСТЕМНЫЕ УЗЛЫ' },
      en: { 'system.nodesTitle': 'SYSTEM NODES' },
    };
    const thirdLocale = 'xx' as unknown as Parameters<typeof resolveFromTables>[1];
    expect(
      resolveFromTables({ ...tables, [thirdLocale]: {} }, thirdLocale, 'system.nodesTitle'),
    ).toBe('SYSTEM NODES');
  });
});
