import { type TitlebarElement } from '@gremuchaya/settings-schema';

import { t } from './locale';
import type { MessageId } from './messages';

/**
 * What a `titlebar.elements` member is, in the operator's language.
 *
 * The counterpart of `statuslineLabels.ts`'s `statuslineElementLabel`, over
 * the bar's own five-member roster (`packages/settings-schema`). Read by
 * `TerminalElementsConstructor`'s consumer in `SchemaSetting`, which is what
 * replaced the raw comma-list editor for this setting.
 */
const elementMessages: Readonly<Record<TitlebarElement, MessageId>> = {
  title: 'titlebarElement.title',
  information: 'titlebarElement.information',
  minimize: 'titlebarElement.minimize',
  maximize: 'titlebarElement.maximize',
  close: 'titlebarElement.close',
};

export function titlebarElementLabel(element: TitlebarElement): string {
  return t(elementMessages[element]);
}
