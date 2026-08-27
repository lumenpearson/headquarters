// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operationsStore } from '../state/operationsStore.js';
import { TacticalMapScreen } from './TacticalMapScreen.js';

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

/*
 * The surface stands in for the provider so the assertions can read the layer
 * stack it was handed. Rendering the real one would test Yandex Maps API v3
 * loading in jsdom, which is neither what `map.mode` selects nor something
 * jsdom can do.
 *
 * `vi.hoisted` because `vi.mock` factories run before the module body: a plain
 * `const` declared here would still be in its temporal dead zone.
 */
const surface = vi.hoisted(() => ({
  layers: null as Readonly<Record<string, boolean>> | null,
}));

vi.mock('@/components/operations/YandexTacticalMap', () => ({
  YandexTacticalMap: (properties: { readonly layers: Readonly<Record<string, boolean>> }) => {
    surface.layers = properties.layers;
    return null;
  },
}));

/*
 * `TileGrid` draws nothing until it has measured two boxes, and the shared stub
 * in `vitest.setup.ts` observes nothing on purpose. Reporting them here is what
 * puts any tile on the screen at all; the assertions below read what the
 * surface tile was handed, never where the resolver placed it, so no made-up
 * geometry is asserted.
 *
 * The second box is `.tile-grid__floor`, the empty panel the grid counts its
 * row budget in: 68px is what `operations.css` draws below 2500px -- a 42px
 * header, two 12px paddings and two 1px borders. jsdom performs no layout, so
 * a box it is not told cannot be measured.
 */
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

function representationButton(label: string): HTMLElement {
  return screen.getByRole('button', { name: label });
}

describe('map.mode chooses the representation the tactical map opens in', () => {
  beforeEach(() => {
    surface.layers = null;
    // Rebuilds the personalization slice from the factory snapshot, so each
    // case starts from the schema default rather than the previous patch.
    operationsStore.getState().resetWorld();
  });

  it('opens in the tactical representation by default, drawing the operator stack whole', () => {
    render(<TacticalMapScreen />);

    expect(surface.layers).toEqual(operationsStore.getState().ui.mapLayers);
    expect(representationButton('ТАКТИКА').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/GEO \/ ТАКТИКА/u)).not.toBeNull();
  });

  it('opens in the cartographic representation when the setting names it', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'map.mode', value: 'map' }]);

    render(<TacticalMapScreen />);

    expect(surface.layers?.restricted).toBe(false);
    expect(surface.layers?.sensors).toBe(false);
    // The overlays cartography still needs are untouched.
    expect(surface.layers?.routes).toBe(true);
    expect(surface.layers?.alerts).toBe(true);
    expect(representationButton('КАРТА').getAttribute('aria-pressed')).toBe('true');
    // A layer switched on while nothing is drawn would be a lie, so the panel
    // names what the representation is holding back.
    expect(screen.getByText(/НЕ ОТРИСОВЫВАЕТ/u).textContent).toContain('ЗОНЫ ОГРАНИЧЕНИЙ');
  });

  it('opens in the satellite representation when the setting names it, and says imagery is missing', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'map.mode', value: 'satellite' }]);

    render(<TacticalMapScreen />);

    expect(surface.layers?.routes).toBe(false);
    expect(surface.layers?.restricted).toBe(false);
    expect(surface.layers?.sensors).toBe(false);
    expect(screen.getByText('СНИМКИ НЕДОСТУПНЫ')).not.toBeNull();
  });

  it('names the initial representation only: the operator switches for the session', () => {
    render(<TacticalMapScreen />);
    expect(surface.layers?.restricted).toBe(true);

    fireEvent.click(representationButton('КАРТА'));

    expect(surface.layers?.restricted).toBe(false);
    expect(representationButton('КАРТА').getAttribute('aria-pressed')).toBe('true');
  });

  it('masks the stack for the surface without writing the operator layers back', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'map.mode', value: 'satellite' }]);
    render(<TacticalMapScreen />);

    // What the operator switched on survives the representation, so returning
    // to it returns their stack rather than an emptied one.
    expect(operationsStore.getState().ui.mapLayers.routes).toBe(true);

    fireEvent.click(representationButton('ТАКТИКА'));

    expect(surface.layers).toEqual(operationsStore.getState().ui.mapLayers);
  });

  it('re-seeds from the setting when its value changes, so a hydrated draft still lands', () => {
    render(<TacticalMapScreen />);
    expect(surface.layers?.restricted).toBe(true);

    // The persisted draft arrives from an effect in `OperationsRuntime`, after
    // this screen's first render; a value captured once would never see it.
    fireEvent.click(representationButton('КАРТА'));
    // Wrapped in act: the store is written from outside React here, and the
    // assertion would otherwise run before the subscription re-rendered.
    act(() => {
      operationsStore.getState().applySettingsPatch([{ id: 'map.mode', value: 'satellite' }]);
    });

    expect(surface.layers?.routes).toBe(false);
    expect(representationButton('СПУТНИК').getAttribute('aria-pressed')).toBe('true');
  });
});
