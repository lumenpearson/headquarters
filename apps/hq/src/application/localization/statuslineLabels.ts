import { type StatuslineElement } from '@gremuchaya/settings-schema';

import { t } from './locale';
import type { MessageId } from './messages';

/**
 * What a `statusline.elements` member is, in the operator's language.
 *
 * `statusline.elements` is edited as a comma list of these ids
 * (`SchemaSetting`'s `string-list` editor has no per-value catalogue, unlike
 * `enum`), so its definition fell back to joining the bare identifiers --
 * `system, route, cpu, ram, net, probe, alerts, encoding, clock, hints` --
 * straight into the row's detail text. This is the table that replaces that
 * join with the same words `OpsStatusLine` draws for each element, so a
 * Russian-language settings screen stops naming them in English.
 */
const elementMessages: Readonly<Record<StatuslineElement, MessageId>> = {
  system: 'statuslineElement.system',
  route: 'statuslineElement.route',
  cpu: 'statuslineElement.cpu',
  ram: 'statuslineElement.ram',
  net: 'statuslineElement.net',
  probe: 'statuslineElement.probe',
  alerts: 'statuslineElement.alerts',
  encoding: 'statuslineElement.encoding',
  clock: 'statuslineElement.clock',
  hints: 'statuslineElement.hints',
};

export function statuslineElementLabel(element: StatuslineElement): string {
  return t(elementMessages[element]);
}
