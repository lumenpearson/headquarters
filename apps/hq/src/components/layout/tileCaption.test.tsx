// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Panel } from '@/components/operations/OpsUi';

import { TileCaptionProvider, type TileCaptionScope } from './tileCaption';

/**
 * That a caption reaches the heading an operator is looking at.
 *
 * The resolver is proven pure in `application/localization/elementTranslations
 * .test.ts`; what is proven here is the wiring that was missing until now --
 * the panel asks for the scope its grid supplies, and draws what comes back.
 * Every assertion below fails if the call in `Panel` is removed, which is the
 * only reason to write them at this level rather than one level down.
 */
const brief: TileCaptionScope = {
  entries: [`ru:overview:brief=${encodeURIComponent('СВОДКА СМЕНЫ')}`],
  locale: 'ru',
  screen: 'overview',
  element: 'brief',
};

function heading(): string {
  return screen.getByRole('heading', { level: 2 }).textContent ?? '';
}

describe('the caption a tile header draws', () => {
  it('draws the operator’s caption in place of the shipped title', () => {
    render(
      <TileCaptionProvider scope={brief}>
        <Panel title="ОБЗОР ОПЕРАЦИИ">
          <p>тело</p>
        </Panel>
      </TileCaptionProvider>,
    );

    expect(heading()).toBe('СВОДКА СМЕНЫ');
  });

  it('draws the shipped title when the operator has written nothing', () => {
    render(
      <TileCaptionProvider scope={{ ...brief, entries: [] }}>
        <Panel title="ОБЗОР ОПЕРАЦИИ">
          <p>тело</p>
        </Panel>
      </TileCaptionProvider>,
    );

    expect(heading()).toBe('ОБЗОР ОПЕРАЦИИ');
  });

  it('draws the shipped title when the caption belongs to another language', () => {
    render(
      <TileCaptionProvider scope={{ ...brief, locale: 'en' }}>
        <Panel title="ОБЗОР ОПЕРАЦИИ">
          <p>тело</p>
        </Panel>
      </TileCaptionProvider>,
    );

    expect(heading()).toBe('ОБЗОР ОПЕРАЦИИ');
  });

  it('leaves a panel that is not a tile alone', () => {
    // Settings, drawers and the developer gallery draw panels outside any
    // grid. They have no address, so no entry can rename them.
    render(
      <Panel title="ОБЗОР ОПЕРАЦИИ">
        <p>тело</p>
      </Panel>,
    );

    expect(heading()).toBe('ОБЗОР ОПЕРАЦИИ');
  });

  it('renames the tile’s own heading and not the panels inside it', () => {
    // Inheriting down the tree would rename every nested panel as a side
    // effect of renaming the tile that contains them.
    render(
      <TileCaptionProvider scope={brief}>
        <Panel title="ОБЗОР ОПЕРАЦИИ">
          <Panel title="ВЛОЖЕННАЯ ПАНЕЛЬ">
            <p>тело</p>
          </Panel>
        </Panel>
      </TileCaptionProvider>,
    );

    expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual([
      'СВОДКА СМЕНЫ',
      'ВЛОЖЕННАЯ ПАНЕЛЬ',
    ]);
  });
});
