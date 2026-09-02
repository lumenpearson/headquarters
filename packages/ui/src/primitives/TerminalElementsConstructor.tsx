'use client';

import { classNames } from './classNames.js';

export interface TerminalElementsConstructorOption {
  readonly value: string;
  readonly label: string;
}

export interface TerminalElementsConstructorProps {
  /** The chosen members, in the order they draw -- `titlebar.elements` and
   * `statusline.elements` are both an arrangement, not merely a subset. */
  readonly value: readonly string[];
  /** Every member the bar knows how to draw, whether chosen or not. */
  readonly options: ReadonlyArray<TerminalElementsConstructorOption>;
  readonly onValueChange: (value: readonly string[]) => void;
  readonly label: string;
  readonly className?: string;
}

/**
 * A pick-and-order control for a bar's own roster (R25's titlebar
 * constructor, and `statusline.elements`' twin of the same problem): what
 * `titlebar.elements` and `statusline.elements` took before this primitive
 * was a comma-delimited text field the operator typed member ids into by
 * hand, with no catalogue of what a member was called or which ones existed.
 *
 * Chosen members are rows, in the order the bar draws them, each carrying its
 * own reorder and remove controls; the rest are add buttons below. There is
 * no drag: `TileGrid` already reserves drag for tile placement (`edit.css`),
 * and a bar of five to ten members reorders in at most a few keypresses this
 * way, each one landing exactly where a screen reader or a keyboard-only
 * operator can reach it, which a drop target cannot promise either of.
 */
export function TerminalElementsConstructor({
  value,
  options,
  onValueChange,
  label,
  className,
}: TerminalElementsConstructorProps) {
  const labelOf = (id: string): string =>
    options.find((option) => option.value === id)?.label ?? id;
  const available = options.filter((option) => !value.includes(option.value));

  const add = (id: string): void => {
    if (value.includes(id)) return;
    onValueChange([...value, id]);
  };
  const remove = (id: string): void => {
    onValueChange(value.filter((entry) => entry !== id));
  };
  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(target, 0, item);
    onValueChange(next);
  };

  return (
    <div
      role="group"
      aria-label={label}
      className={classNames('terminal-elements-constructor', 'grid min-w-0 gap-hq-2', className)}
    >
      <ol className="terminal-elements-constructor__chosen m-0 grid list-none gap-hq-1 p-0">
        {value.map((id, index) => (
          <li
            key={id}
            className="terminal-elements-constructor__row flex items-center gap-hq-2 border border-hq-line-2 px-hq-2 py-hq-1 text-hq-text-1 [font-family:var(--font-mono)] text-hq-xs uppercase"
          >
            <span className="terminal-elements-constructor__label flex-1">{labelOf(id)}</span>
            <button
              type="button"
              className="terminal-elements-constructor__move"
              disabled={index === 0}
              onClick={() => move(index, -1)}
              aria-label={`${labelOf(id)}: выше`}
            >
              ↑
            </button>
            <button
              type="button"
              className="terminal-elements-constructor__move"
              disabled={index === value.length - 1}
              onClick={() => move(index, 1)}
              aria-label={`${labelOf(id)}: ниже`}
            >
              ↓
            </button>
            <button
              type="button"
              className="terminal-elements-constructor__remove"
              onClick={() => remove(id)}
              aria-label={`${labelOf(id)}: убрать`}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      {available.length === 0 ? null : (
        <div className="terminal-elements-constructor__available flex flex-wrap gap-hq-2">
          {available.map((option) => (
            <button
              key={option.value}
              type="button"
              className="terminal-elements-constructor__add border border-hq-line-2 px-hq-2 py-hq-1 text-hq-text-2 [font-family:var(--font-mono)] text-hq-xs uppercase"
              onClick={() => add(option.value)}
            >
              + {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
