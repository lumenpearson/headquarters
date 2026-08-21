'use client';

import { useEffect, useState } from 'react';

import { groupKeybinds, keybindCategoryLabel } from '@/application/keybinds/grouping';
import { formatChord } from '@/application/keybinds/match';
import { keybindRegistry } from '@/application/keybinds/registry';

import { subscribeKeybindFired } from './KeybindRuntime';

/**
 * How long a row stays lit after its keybind fires. Long enough to notice on a
 * glance, short enough that two presses read as two.
 */
const highlightMs = 700;

/**
 * R11: the list of every application-wide keybind, lighting up as they are
 * pressed.
 *
 * Built from the registry rather than written out, so a keybind cannot exist
 * without appearing here and cannot appear here without existing. The
 * highlight is what makes it a reference an operator can check against rather
 * than a table they have to trust.
 */
export function KeybindList() {
  const [firedId, setFiredId] = useState<string | null>(null);

  useEffect(() => {
    let timer = 0;
    const unsubscribe = subscribeKeybindFired((id) => {
      setFiredId(id);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFiredId(null), highlightMs);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  return (
    <div className="keybind-list">
      {groupKeybinds(keybindRegistry).map((group) => (
        <section key={group.category} className="keybind-list__group">
          <h4>{keybindCategoryLabel(group.category)}</h4>
          <ul>
            {group.keybinds.map((keybind) => (
              <li
                key={keybind.id}
                className="keybind-list__row"
                data-fired={firedId === keybind.id ? 'true' : 'false'}
              >
                <kbd>{formatChord(keybind.chord)}</kbd>
                <span>{keybind.description}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
