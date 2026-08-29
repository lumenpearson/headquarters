// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { TerminalField } from './TerminalField.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns the label/control association and the validity state machine.
 * What this wrapper adds is the layout order it fixes -- label, description,
 * control, error -- the two optional parts it drops when their prop is absent,
 * and the `invalid = Boolean(error)` default that lets a consumer pass a
 * message alone and get the invalid styling with it.
 *
 * Note on `error`: `Field.Error` is rendered without a `match` prop, so Base UI
 * mounts it only once native constraint validation has failed. The `invalid`
 * prop alone does not satisfy that, so the message text never reaches the DOM;
 * only the `data-invalid` state it derives does. That is asserted below as the
 * defaulting it is, without pinning the missing message in place.
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

function mustFind<T extends Element>(scope: ParentNode, selector: string): T {
  const element = scope.querySelector<T>(selector);
  if (element === null) throw new Error(`${selector} not rendered`);
  return element;
}

const field = (container: HTMLElement): HTMLElement =>
  mustFind<HTMLElement>(container, '.terminal-field');

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalField', () => {
  it('stacks the label, the description and the control in that order', () => {
    const container = mount(
      <TerminalField label="Позывной" description="Латиница, до 12 знаков" className="panel-field">
        <span data-role="control">alpha-1</span>
      </TerminalField>,
    );
    // `classNames` appends the consumer class rather than replacing the base one.
    const rootClass = field(container).className;
    expect(rootClass).toContain('terminal-field');
    expect(rootClass.endsWith('panel-field')).toBe(true);
    const children = Array.from(field(container).children);
    expect(children.map((child) => child.textContent)).toEqual([
      'Позывной',
      'Латиница, до 12 знаков',
      'alpha-1',
    ]);
    expect(children[0]?.className).toContain('terminal-field__label');
    expect(children[1]?.className).toContain('terminal-field__description');
    expect(children[2]?.className).toBe('');
  });

  it('drops the description when the consumer has none', () => {
    const container = mount(
      <TerminalField label="Позывной">
        <span>alpha-1</span>
      </TerminalField>,
    );
    expect(container.querySelector('.terminal-field__description')).toBeNull();
    expect(field(container).children).toHaveLength(2);

    // An empty description is falsy and is dropped in the same way.
    const blank = mount(
      <TerminalField label="Позывной" description="">
        <span>alpha-1</span>
      </TerminalField>,
    );
    expect(blank.querySelector('.terminal-field__description')).toBeNull();
  });

  it('derives the invalid state from the error message, and lets the consumer override it', () => {
    const withError = mount(
      <TerminalField label="Позывной" error="Позывной занят">
        <span>alpha-1</span>
      </TerminalField>,
    );
    // No `invalid` prop was passed: it defaults to `Boolean(error)`.
    expect(field(withError).hasAttribute('data-invalid')).toBe(true);
    expect(mustFind(withError, '.terminal-field__label').hasAttribute('data-invalid')).toBe(true);

    const suppressed = mount(
      <TerminalField label="Позывной" error="Позывной занят" invalid={false}>
        <span>alpha-1</span>
      </TerminalField>,
    );
    expect(field(suppressed).hasAttribute('data-invalid')).toBe(false);

    const withoutError = mount(
      <TerminalField label="Позывной">
        <span>alpha-1</span>
      </TerminalField>,
    );
    expect(field(withoutError).hasAttribute('data-invalid')).toBe(false);

    // Invalid without a message is the other half of the default being a default.
    const flagged = mount(
      <TerminalField label="Позывной" invalid>
        <span>alpha-1</span>
      </TerminalField>,
    );
    expect(field(flagged).hasAttribute('data-invalid')).toBe(true);
  });

  it('marks the whole group disabled so the parts can style off it', () => {
    const container = mount(
      <TerminalField label="Позывной" description="Латиница, до 12 знаков" disabled>
        <span>alpha-1</span>
      </TerminalField>,
    );
    expect(field(container).hasAttribute('data-disabled')).toBe(true);
    expect(mustFind(container, '.terminal-field__label').hasAttribute('data-disabled')).toBe(true);
    expect(mustFind(container, '.terminal-field__description').hasAttribute('data-disabled')).toBe(
      true,
    );

    const enabled = mount(
      <TerminalField label="Позывной">
        <span>alpha-1</span>
      </TerminalField>,
    );
    expect(field(enabled).hasAttribute('data-disabled')).toBe(false);
  });
});
