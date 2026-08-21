// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { Profiler } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { operationsStore } from '../state/operationsStore.js';
import { OverviewScreen } from './OverviewScreen.js';

// OverviewScreen calls useRouter() from next/navigation, which throws outside
// an App Router tree. This is the first component test in the package, so no
// router mock exists yet; the stub below only needs to satisfy the calls the
// component makes on render (the test never clicks anything that navigates).
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
 * Pins the subscription contract of `useOperationsStore`, which wraps every
 * selector in `useShallow` (operationsStore.ts). That wrapper is why selectors
 * such as `Object.values(state.sectors)` are safe despite allocating a new
 * array on each call: the shallow compare hands React back the previous
 * reference when the contents match. Remove it and this test fails.
 *
 * Profiling is deliberate. Counting renders of a wrapper component cannot
 * observe this: a child re-rendering from its own store subscription does not
 * re-render its parent, so a wrapper's count stays at 1 no matter what the
 * child does. React's Profiler fires on every commit inside the profiled tree.
 */
describe('OverviewScreen subscription cost', () => {
  it('does not re-render when an unrelated part of the store changes', () => {
    let commits = 0;
    render(
      <Profiler
        id="overview"
        onRender={() => {
          commits += 1;
        }}
      >
        <OverviewScreen />
      </Profiler>,
    );
    const before = commits;

    // Notify subscribers without changing anything the screen reads.
    act(() => {
      operationsStore.setState((state) => ({ ...state }));
    });

    expect(commits).toBe(before);
  });

  // Without this positive control the assertion above could pass simply because
  // the subscription is broken and nothing ever re-renders.
  it('sanity check: does re-render when something it reads actually changes', () => {
    const original = operationsStore.getState().operation;
    let commits = 0;
    render(
      <Profiler
        id="overview-sanity"
        onRender={() => {
          commits += 1;
        }}
      >
        <OverviewScreen />
      </Profiler>,
    );
    const before = commits;

    act(() => {
      operationsStore.setState((state) => ({
        operation: { ...state.operation, title: 'CHANGED-FOR-TEST' },
      }));
    });

    expect(commits).toBeGreaterThan(before);
    operationsStore.setState({ operation: original });
  });
});
