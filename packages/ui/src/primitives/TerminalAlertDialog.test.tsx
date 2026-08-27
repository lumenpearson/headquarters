// @vitest-environment jsdom
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalAlertDialog } from './TerminalAlertDialog.js';
import { TerminalButton } from './TerminalButton.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI owns the alert dialog's modality and dismissal. This wrapper adds a
 * fixed two-button footer, so what is asserted here is the footer's order,
 * labels and tones, its defaults, and the one thing the consumer hears back:
 * `onConfirm` from the right button and from that button only.
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

function query(selector: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${selector} not rendered`);
  return element;
}

const missing = (selector: string): boolean => document.body.querySelector(selector) === null;

function click(element: Element): void {
  act(() => (element as HTMLElement).click());
}

/** The footer holds exactly the cancel and confirm controls, in that order. */
function footerButtons(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.terminal-dialog__footer button'));
}

function open(container: HTMLDivElement): void {
  const trigger = container.querySelector('button');
  if (trigger === null) throw new Error('trigger not rendered');
  click(trigger);
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalAlertDialog', () => {
  it('keeps the alert unmounted until its trigger is activated', () => {
    const container = mount(
      <TerminalAlertDialog
        trigger={<TerminalButton>Удалить</TerminalButton>}
        title="Удалить материал?"
        description="Действие необратимо."
        confirmLabel="УДАЛИТЬ"
        onConfirm={vi.fn()}
      />,
    );

    const trigger = container.querySelector<HTMLElement>('button');
    // The consumer's element is kept and merely wired up as the trigger.
    expect(trigger?.textContent).toBe('Удалить');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(missing('[role="alertdialog"]')).toBe(true);

    open(container);
    expect(missing('[role="alertdialog"]')).toBe(false);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
  });

  it('wears both dialog classes and names itself from the title and description it composes', () => {
    const container = mount(
      <TerminalAlertDialog
        trigger={<TerminalButton>Удалить</TerminalButton>}
        title="Удалить материал?"
        description={<em data-testid="rich-description">Действие необратимо.</em>}
        confirmLabel="УДАЛИТЬ"
        onConfirm={vi.fn()}
      />,
    );
    open(container);

    const popup = query('[role="alertdialog"]');
    // The alert borrows the dialog skin and adds its own modifier; there is no
    // `className` prop, so this pair is all a consumer ever gets.
    expect(Array.from(popup.classList)).toEqual(['terminal-dialog', 'terminal-alert-dialog']);

    const title = query('header.terminal-dialog__header h2');
    expect(title.textContent).toBe('Удалить материал?');
    expect(popup.getAttribute('aria-labelledby')).toBe(title.id);

    const description = query('.terminal-dialog__description');
    expect(popup.getAttribute('aria-describedby')).toBe(description.id);
    // `description` is a ReactNode, so arbitrary markup survives into the slot.
    expect(description.querySelector('[data-testid="rich-description"]')).not.toBe(null);
  });

  it('confirms from the confirm button only, and dismisses either way', () => {
    const onConfirm = vi.fn();
    const container = mount(
      <TerminalAlertDialog
        trigger={<TerminalButton>Удалить</TerminalButton>}
        title="Удалить материал?"
        description="Действие необратимо."
        confirmLabel="УДАЛИТЬ"
        onConfirm={onConfirm}
      />,
    );

    open(container);
    const [cancel] = footerButtons();
    click(cancel as Element);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(missing('[role="alertdialog"]')).toBe(true);

    open(container);
    const confirm = footerButtons()[1];
    click(confirm as Element);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Both footer controls are AlertDialog.Close: confirming dismisses too.
    expect(missing('[role="alertdialog"]')).toBe(true);
  });

  it('defaults the cancel label to ОТМЕНА and the confirm tone to critical', () => {
    const container = mount(
      <TerminalAlertDialog
        trigger={<TerminalButton>Удалить</TerminalButton>}
        title="Удалить материал?"
        description="Действие необратимо."
        confirmLabel="УДАЛИТЬ"
        onConfirm={vi.fn()}
      />,
    );
    open(container);

    const [cancel, confirm] = footerButtons();
    expect(cancel?.textContent).toBe('ОТМЕНА');
    expect(cancel?.dataset['tone']).toBe('neutral');
    expect(confirm?.textContent).toBe('УДАЛИТЬ');
    expect(confirm?.dataset['tone']).toBe('critical');
  });

  it('passes an explicit cancelLabel and tone to the footer, leaving cancel neutral', () => {
    const container = mount(
      <TerminalAlertDialog
        trigger={<TerminalButton>Применить</TerminalButton>}
        title="Применить пресет?"
        description="Текущая раскладка будет заменена."
        confirmLabel="ПРИМЕНИТЬ"
        cancelLabel="НАЗАД"
        tone="primary"
        onConfirm={vi.fn()}
      />,
    );
    open(container);

    const [cancel, confirm] = footerButtons();
    expect(cancel?.textContent).toBe('НАЗАД');
    // Only the confirm control is toned; cancel is always the neutral default.
    expect(cancel?.dataset['tone']).toBe('neutral');
    expect(confirm?.dataset['tone']).toBe('primary');
    expect(confirm?.className).toContain('terminal-button--primary');
  });
});
