// @vitest-environment jsdom
import { act, createRef } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalTextarea } from './TerminalTextarea.js';

/*
 * `packages/ui` carries no Testing Library: React 19's own `act` and
 * `react-dom/client` are enough to mount a primitive and dispatch DOM events
 * at it, and they are already dependencies of the package.
 *
 * Base UI has no textarea, so this primitive is a raw `<textarea>` -- the one
 * the UI boundary check permits. Its own logic is the class prefix, the ref
 * forwarding and the change fan-out that gives the multiline control the same
 * `onValueChange` shape as Base UI's `Input`.
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

const textarea = (container: HTMLElement): HTMLTextAreaElement => {
  const element = container.querySelector('textarea');
  if (element === null) throw new Error('textarea not rendered');
  return element;
};

const nativeValueSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  'value',
)?.set;

/** React listens for `input`, not `change`, and reads the value off the element. */
function type(element: HTMLTextAreaElement, value: string): void {
  if (nativeValueSetter === undefined) throw new Error('no native value setter');
  nativeValueSetter.call(element, value);
  act(() => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe('TerminalTextarea', () => {
  it('renders a real textarea under the shared input classes plus its own', () => {
    const bare = mount(<TerminalTextarea />);
    const element = textarea(bare);
    expect(element.tagName).toBe('TEXTAREA');
    // It shares `hq-input`/`terminal-input` with TerminalInput so the two text
    // controls are styled as one, and adds the multiline-only class last.
    expect(element.getAttribute('class')).toBe('hq-input terminal-input terminal-textarea');

    const dressed = mount(<TerminalTextarea className="content-editor__body" />);
    expect(dressed.querySelector('textarea')?.getAttribute('class')).toBe(
      'hq-input terminal-input terminal-textarea content-editor__body',
    );
  });

  it('forwards the ref to the textarea and passes the native props through', () => {
    const reference = createRef<HTMLTextAreaElement>();
    const container = mount(
      <TerminalTextarea ref={reference} rows={6} placeholder="описание" defaultValue="строка" />,
    );
    const element = textarea(container);
    expect(reference.current).toBe(element);
    expect(element.rows).toBe(6);
    expect(element.placeholder).toBe('описание');
    expect(element.value).toBe('строка');
  });

  it('calls onChange before onValueChange, handing both the same event', () => {
    const order: string[] = [];
    let seenEvent: ChangeEvent<HTMLTextAreaElement> | undefined;
    const onChange = vi.fn((event: ChangeEvent<HTMLTextAreaElement>) => {
      order.push('onChange');
      seenEvent = event;
    });
    const onValueChange = vi.fn((_value: string, event: ChangeEvent<HTMLTextAreaElement>) => {
      order.push('onValueChange');
      // The raw event stays available to the value-shaped callback as well.
      expect(event).toBe(seenEvent);
    });
    const container = mount(<TerminalTextarea onChange={onChange} onValueChange={onValueChange} />);
    const element = textarea(container);

    type(element, 'первая строка');
    expect(order).toEqual(['onChange', 'onValueChange']);
    expect(onChange.mock.calls[0]?.[0].target).toBe(element);
    expect(onValueChange.mock.calls[0]?.[0]).toBe('первая строка');
  });

  it('fires whichever change callback it was given, and neither is required', () => {
    const onValueChange = vi.fn();
    const valueOnly = mount(<TerminalTextarea onValueChange={onValueChange} />);
    type(textarea(valueOnly), 'только значение');
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange.mock.calls[0]?.[0]).toBe('только значение');

    const onChange = vi.fn();
    const changeOnly = mount(<TerminalTextarea onChange={onChange} />);
    type(textarea(changeOnly), 'только событие');
    expect(onChange).toHaveBeenCalledTimes(1);

    // A read-only consumer passes no callback at all; the wired handler still runs.
    const silent = mount(<TerminalTextarea />);
    expect(() => type(textarea(silent), 'без обработчиков')).not.toThrow();
  });
});
