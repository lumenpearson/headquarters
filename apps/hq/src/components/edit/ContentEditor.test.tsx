// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  contentElementId,
  readContentValue,
  seedContentValue,
} from '../../application/edit/contentFields';
import { operationsStore } from '../../state/operationsStore';
import { ContentEditor } from './ContentEditor';

/** The seed event and report every case below edits. Both ship in the world. */
const eventId = 'EV-1001';
const reportId = 'REP-01';

function select(field: string, entityId: string): void {
  operationsStore.getState().selectEditElement(contentElementId(field, entityId));
}

function timestampOf(id: string): string {
  const event = operationsStore.getState().events.find((candidate) => candidate.id === id);
  if (event === undefined) throw new Error(`the seed has no ${id}`);
  return event.timestamp;
}

describe('ContentEditor', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.getState().exitEditMode();
    operationsStore.getState().enterEditMode();
  });

  it('tells a screen reader that a refused value was refused', () => {
    select('case.title', 'CASE-01');
    render(<ContentEditor />);

    const field = screen.getByRole('textbox');
    expect(field.getAttribute('aria-invalid')).toBeNull();

    // Past the field's own ceiling: the store's validator refuses it, and the
    // panel has to say so in a way a reader announces. The text control
    // commits on blur, not on every keystroke.
    fireEvent.change(field, { target: { value: 'Т'.repeat(400) } });
    fireEvent.blur(field);

    const message = screen.getByRole('status');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(message.getAttribute('id'));
    expect(message.textContent).toBeTruthy();
  });

  it('changes the time of day of an event and leaves its calendar date alone', () => {
    select('event.time', eventId);
    const { container } = render(<ContentEditor />);

    const control = container.querySelector('input[type="time"]');
    if (control === null) throw new Error('the time field renders no time control');
    // The seconds matter: `event.time` validates `HH:MM:SS`, and a control
    // without `step` would round the operator's value to the minute.
    expect(control.getAttribute('step')).toBe('1');

    const seeded = seedContentValue('event.time', eventId) ?? '';
    // Never the value already there. A case that types back what the seed
    // holds passes against a build where the control changes nothing (C51).
    const typed = seeded.startsWith('23') ? '05:17:41' : '23:17:41';
    const dateBefore = readContentValue(operationsStore.getState(), 'event.date', eventId);

    fireEvent.change(control, { target: { value: typed } });

    expect(readContentValue(operationsStore.getState(), 'event.time', eventId)).toBe(typed);
    expect(operationsStore.getState().content.overrides[`event.time@${eventId}`]).toBe(typed);
    // The codec keeps the day the operator did not touch.
    expect(readContentValue(operationsStore.getState(), 'event.date', eventId)).toBe(dateBefore);
  });

  it('leaves the world alone when the time picker is cleared', () => {
    select('event.time', eventId);
    const { container } = render(<ContentEditor />);
    const control = container.querySelector('input[type="time"]');
    if (control === null) throw new Error('the time field renders no time control');
    const before = timestampOf(eventId);

    // Clearing a picker reports an empty string. Applying it would be a patch
    // to a value the field refuses, and an error message the operator did not
    // earn by typing anything.
    fireEvent.change(control, { target: { value: '' } });

    expect(timestampOf(eventId)).toBe(before);
    expect(operationsStore.getState().content.overrides).toEqual({});
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('changes a report instant through the datetime control', () => {
    select('report.createdAt', reportId);
    const { container } = render(<ContentEditor />);

    const control = container.querySelector('input[type="datetime-local"]');
    if (control === null) throw new Error('the datetime field renders no datetime control');
    expect(control.getAttribute('step')).toBe('1');

    // The control speaks local wall-clock time and the world stores an
    // instant, so the value shown is the codec's, not the stored string.
    const shown = (control as HTMLInputElement).value;
    expect(shown).not.toBe('');
    const typed = shown.startsWith('2031') ? '2032-01-09T04:05:06' : '2031-01-09T04:05:06';

    fireEvent.change(control, { target: { value: typed } });

    const stored = operationsStore.getState().reports[reportId]?.createdAt;
    expect(stored).toBe(new Date(typed).toISOString());
    expect(operationsStore.getState().content.overrides[`report.createdAt@${reportId}`]).toBe(
      stored,
    );
  });

  it('holds a multiline draft until focus leaves the field', () => {
    const operationId = operationsStore.getState().operation.id;
    select('operation.summary', operationId);
    const { container } = render(<ContentEditor />);

    const control = container.querySelector('textarea');
    if (control === null) throw new Error('the summary field renders no textarea');
    const seeded = seedContentValue('operation.summary', operationId) ?? '';
    const typed = `${seeded}\nВторая строка сводки.`;

    fireEvent.change(control, { target: { value: typed } });
    // A history entry per keystroke would make undo step back one letter at a
    // time, so nothing is applied while the operator is still typing.
    expect(operationsStore.getState().operation.summary).toBe(seeded);

    fireEvent.blur(control);

    expect(operationsStore.getState().operation.summary).toBe(typed);
    expect(operationsStore.getState().content.overrides[`operation.summary@${operationId}`]).toBe(
      typed,
    );
    // A line break belongs in a paragraph, which is what `multiline` declares.
    expect(control.getAttribute('rows')).toBe('4');
  });

  it('commits a single-line draft when focus leaves the field', () => {
    select('case.title', 'CASE-02');
    render(<ContentEditor />);

    const control = screen.getByRole('textbox');
    const seeded = seedContentValue('case.title', 'CASE-02') ?? '';
    const typed = `${seeded} / ПРОВЕРЕНО`;

    fireEvent.change(control, { target: { value: typed } });
    expect(operationsStore.getState().cases['CASE-02']?.title).toBe(seeded);

    // Leaving the field is a way of finishing the edit, alongside Enter: an
    // operator who types and then clicks the next value has finished typing.
    fireEvent.blur(control);

    expect(operationsStore.getState().cases['CASE-02']?.title).toBe(typed);
  });

  it('puts one field back through its own reset and leaves the others changed', () => {
    select('case.title', 'CASE-02');
    const seededTitle = seedContentValue('case.title', 'CASE-02') ?? '';
    const seededSummary = seedContentValue('operation.summary', 'OP-GS-042') ?? '';
    operationsStore.getState().applyContentPatch([
      { id: 'case.title', entityId: 'CASE-02', value: `${seededTitle} / ПРОВЕРЕНО` },
      { id: 'operation.summary', entityId: 'OP-GS-042', value: `${seededSummary} Дополнено.` },
    ]);
    render(<ContentEditor />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Вернуть исходное значение: case.title@CASE-02' }),
    );

    // The world, not only the record of it: a reset that dropped the override
    // without projecting it would leave the edited title on screen.
    expect(operationsStore.getState().cases['CASE-02']?.title).toBe(seededTitle);
    expect(operationsStore.getState().content.overrides).toEqual({
      'operation.summary@OP-GS-042': `${seededSummary} Дополнено.`,
    });
    expect(operationsStore.getState().operation.summary).toBe(`${seededSummary} Дополнено.`);
  });

  it('puts every content edit back through the section reset', () => {
    const seededTitle = seedContentValue('case.title', 'CASE-02') ?? '';
    const seededSummary = seedContentValue('operation.summary', 'OP-GS-042') ?? '';
    operationsStore.getState().applyContentPatch([
      { id: 'case.title', entityId: 'CASE-02', value: `${seededTitle} / ПРОВЕРЕНО` },
      { id: 'operation.summary', entityId: 'OP-GS-042', value: `${seededSummary} Дополнено.` },
    ]);
    render(<ContentEditor />);

    fireEvent.click(screen.getByRole('button', { name: 'ВЕРНУТЬ ВСЁ СОДЕРЖИМОЕ' }));

    expect(operationsStore.getState().content.overrides).toEqual({});
    expect(operationsStore.getState().cases['CASE-02']?.title).toBe(seededTitle);
    expect(operationsStore.getState().operation.summary).toBe(seededSummary);
  });
});

/**
 * A record card is a modal dialog: while one is open the floating panel behind
 * it is `aria-hidden` and outside the tab ring, so a field selected inside the
 * card could be reached from nowhere. The editor moves into the card and back.
 */
describe('ContentEditor placement', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
    operationsStore.getState().exitEditMode();
    operationsStore.getState().enterEditMode();
    select('event.title', eventId);
  });

  it('draws in the panel while no card is open, and nowhere else', () => {
    const panel = render(<ContentEditor />);
    expect(panel.container.querySelector('.edit-content')).not.toBeNull();

    const card = render(<ContentEditor host="drawer" />);
    expect(card.container.querySelector('.edit-content')).toBeNull();
  });

  it('draws in the card while one is open, and not behind it', () => {
    operationsStore.getState().openDrawer('event', eventId);

    const panel = render(<ContentEditor />);
    const card = render(<ContentEditor host="drawer" />);

    // Both hosts render this component; exactly one of them draws, so one
    // field never has two drafts and one error message never has two ids.
    expect(panel.container.querySelector('.edit-content')).toBeNull();
    expect(card.container.querySelector('.edit-content')).not.toBeNull();
    expect(card.getByRole('textbox')).toBeTruthy();
  });

  it('draws nowhere outside edit mode, whatever is selected', () => {
    operationsStore.getState().openDrawer('event', eventId);
    operationsStore.getState().applyContentPatch([
      {
        id: 'event.title',
        entityId: eventId,
        value: `${seedContentValue('event.title', eventId) ?? ''} / ПРОВЕРЕНО`,
      },
    ]);
    operationsStore.getState().exitEditMode();

    const card = render(<ContentEditor host="drawer" />);

    // The card is drawn outside edit mode too, and an edit made earlier is
    // still in the overrides. Neither is a reason to put an editor in it.
    expect(card.container.querySelector('.edit-content')).toBeNull();
  });
});
