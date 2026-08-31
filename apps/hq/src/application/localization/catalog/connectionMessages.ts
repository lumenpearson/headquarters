import type { CatalogModule } from './catalogTypes';

/**
 * What an operator is told when the configuration names a control-plane address
 * this client will not use.
 *
 * These are refusals, not diagnostics. Every one of them is read before any
 * request is attempted, by an operator who cannot see the build variable, the
 * project file or the other machine's screen -- so each names the source, the
 * offending value and the act that fixes it. The browser's own `NetworkError`
 * is not among them on purpose: it describes a request that never left, which
 * is a symptom of the configuration rather than a statement about it, and it
 * arrives too late in any case.
 *
 * `connection.address.buildVariableRefused` is the frame and the rest are the
 * reasons, composed rather than written out eight times, so a translator sees
 * one sentence about the source and one about each rule.
 */
export const connectionMessages = {
  'connection.address.buildVariableRefused': {
    ru: 'ПЕРЕМЕННАЯ СБОРКИ NEXT_PUBLIC_HQ_CONTROL_PLANE_URL ОТКЛОНЕНА. {reason}',
    en: 'THE BUILD VARIABLE NEXT_PUBLIC_HQ_CONTROL_PLANE_URL WAS REFUSED. {reason}',
  },
  /*
   * The MSYS case is named rather than folded into "not an http address"
   * because it is reproducible, it will recur for everyone who builds from Git
   * Bash, and the value on screen -- a Windows path where an address belongs --
   * otherwise looks like something the operator typed.
   */
  'connection.address.refusal.msysPath': {
    ru:
      'ЗАДАН ПУТЬ WINDOWS: {address}. GIT BASH (MSYS2) ПРИ СБОРКЕ ПЕРЕПИСЫВАЕТ ЗНАЧЕНИЕ, ' +
      'НАЧИНАЮЩЕЕСЯ СО СЛЭША, В ПУТЬ ОТ КОРНЯ СВОЕЙ УСТАНОВКИ. СОБИРАЙТЕ ИЗ POWERSHELL, ' +
      'ЛИБО ЗАДАЙТЕ ПОЛНЫЙ АДРЕС СО СХЕМОЙ, ЛИБО УКАЖИТЕ АДРЕС ВРУЧНУЮ В ЭТОМ ПРИЛОЖЕНИИ.',
    en:
      'A WINDOWS PATH WAS CONFIGURED: {address}. GIT BASH (MSYS2) REWRITES A VALUE THAT STARTS ' +
      'WITH A SLASH INTO A PATH UNDER ITS OWN INSTALLATION ROOT AT BUILD TIME. BUILD FROM ' +
      'POWERSHELL, OR CONFIGURE A FULL ADDRESS WITH A SCHEME, OR SET THE ADDRESS BY HAND IN ' +
      'THIS APPLICATION.',
  },
  'connection.address.refusal.notAUrl': {
    ru: 'ЗНАЧЕНИЕ НЕ РАЗБИРАЕТСЯ КАК АДРЕС: {address}. НУЖНА СХЕМА HTTP:// ИЛИ HTTPS://.',
    en: 'THE VALUE DOES NOT PARSE AS AN ADDRESS: {address}. AN HTTP:// OR HTTPS:// SCHEME IS REQUIRED.',
  },
  'connection.address.refusal.notHttp': {
    ru: 'СХЕМА НЕ ПОДДЕРЖИВАЕТСЯ: {address}. КЛИЕНТ ГОВОРИТ ТОЛЬКО ПО HTTP И HTTPS.',
    en: 'THE SCHEME IS NOT SUPPORTED: {address}. THIS CLIENT SPEAKS HTTP AND HTTPS ONLY.',
  },
  /*
   * `{address}` is the origin here and never the entry as configured: a user
   * name and a password in an address are a credential, and
   * `reportableAddress` in `application/sync/controlPlaneLinks.ts` is what
   * drops them before this sentence is composed.
   */
  'connection.address.refusal.credentials': {
    ru: 'АДРЕС СОДЕРЖИТ ИМЯ И ПАРОЛЬ: {address}. УБЕРИТЕ УЧЁТНЫЕ ДАННЫЕ ИЗ АДРЕСА.',
    en: 'THE ADDRESS CARRIES A USER NAME AND A PASSWORD: {address}. REMOVE THE CREDENTIALS FROM IT.',
  },
  'connection.address.refusal.repeated': {
    ru: 'АДРЕС ПОВТОРЯЕТСЯ: {address}. ВТОРОЙ КЛИЕНТ К ТОЙ ЖЕ ПЛОСКОСТИ НИЧЕГО НЕ ДОБАВЛЯЕТ.',
    en: 'THE ADDRESS REPEATS: {address}. A SECOND CLIENT TO THE SAME PLANE ADDS NOTHING.',
  },
  'connection.address.refusal.tooMany': {
    ru: 'АДРЕСОВ БОЛЬШЕ {limit}. КАЖДЫЙ АДРЕС СТОИТ КЛИЕНТА, ПРОБЫ И ОПРОСА.',
    en: 'MORE THAN {limit} ADDRESSES ARE CONFIGURED. EACH ONE COSTS A CLIENT, A PROBE AND A POLL.',
  },
  'connection.address.refusal.unclassified': {
    ru: 'АДРЕС НЕ ПРИНЯТ СХЕМОЙ CONTROLPLANEURL: {address}.',
    en: 'THE CONTROLPLANEURL SCHEMA DID NOT ACCEPT THE ADDRESS: {address}.',
  },
} as const satisfies CatalogModule;
