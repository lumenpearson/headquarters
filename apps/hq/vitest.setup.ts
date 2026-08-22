import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/*
 * Testing Library registers its own cleanup only when a global `afterEach`
 * exists, which requires vitest `globals: true`. This project keeps globals
 * off, so without this file every render accumulates in the document and
 * `screen` queries start matching elements left over from earlier tests.
 *
 * Guarded because setup files run for node-environment tests too, where there
 * is no document to clean.
 */
afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});

/*
 * jsdom implements no layout and therefore no `ResizeObserver`, which
 * `TileGrid` uses to learn how much room a screen was given. Without a stub
 * every component test that renders a resolver-laid-out screen dies on the
 * constructor rather than on anything it set out to check.
 *
 * The stub observes nothing on purpose. A version that reported a made-up box
 * would have component tests asserting a layout jsdom never performed, and the
 * layout is proven against a real engine in `tests/tile-layout.spec.ts`.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
