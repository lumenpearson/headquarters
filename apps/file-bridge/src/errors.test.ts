import { Code, ConnectError } from '@connectrpc/connect';
import { BridgeFailure, BridgeFailureDetailSchema } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import {
  BridgeFailureError,
  bridgeFailure,
  toBridgeConnectError,
  type BridgeFailureCode,
} from './errors.js';

/**
 * Every code the contract declares, minus the zero value the server may not
 * send. The list is derived from the generated enum rather than written out, so
 * a code added to `bridge.proto` joins these assertions without anyone
 * remembering to add it.
 */
const declaredCodes: readonly BridgeFailureCode[] = Object.values(BridgeFailure)
  .filter((value): value is BridgeFailure => typeof value === 'number')
  .filter((value): value is BridgeFailureCode => value !== BridgeFailure.UNSPECIFIED);

describe('bridge failure codes', () => {
  it('declares more than the zero value', () => {
    expect(declaredCodes.length).toBeGreaterThan(20);
  });

  it.each(declaredCodes)('gives code %i a detail, a status and a sentence', (code) => {
    const error = bridgeFailure(code);
    const [detail] = error.findDetails(BridgeFailureDetailSchema);
    expect(detail?.code).toBe(code);
    expect(detail?.developerMessage).not.toBe('');
    expect(error.rawMessage).toBe(detail?.developerMessage);
    expect(error.code).not.toBe(Code.Unknown);
  });

  it('carries the code a raiser chose rather than the exception class', () => {
    const error = toBridgeConnectError(
      new BridgeFailureError(BridgeFailure.SYMLINK_REFUSED, 'internal note'),
    );
    expect(error.findDetails(BridgeFailureDetailSchema)[0]?.code).toBe(
      BridgeFailure.SYMLINK_REFUSED,
    );
    expect(error.code).toBe(Code.PermissionDenied);
  });

  it('classifies a filesystem ENOENT without quoting the path it failed on', () => {
    // Exactly the shape Node raises, message included. Before codes, this
    // message was the ConnectError's message and reached the browser.
    const enoent = Object.assign(
      new Error("ENOENT: no such file or directory, open '/srv/shoot/incoming/brief.txt'"),
      { code: 'ENOENT' },
    );
    const error = toBridgeConnectError(enoent);
    expect(error.findDetails(BridgeFailureDetailSchema)[0]?.code).toBe(
      BridgeFailure.ENTRY_NOT_FOUND,
    );
    expect(error.rawMessage).not.toContain('/srv/shoot/incoming');
    expect(error.rawMessage).not.toContain('ENOENT');
    // The original stays reachable in-process for the bridge's own logging.
    expect(error.cause).toBe(enoent);
  });

  it('classifies an unrecognised exception without quoting it', () => {
    const raw = new Error("EACCES: permission denied, scandir '/srv/shoot/incoming'");
    const error = toBridgeConnectError(raw);
    expect(error.findDetails(BridgeFailureDetailSchema)[0]?.code).toBe(BridgeFailure.INTERNAL);
    expect(error.rawMessage).not.toContain('/srv/shoot/incoming');
    expect(error.cause).toBe(raw);
  });

  it('leaves a ConnectError alone so a cancellation stays a cancellation', () => {
    const canceled = new ConnectError('operation canceled', Code.Canceled);
    expect(toBridgeConnectError(canceled)).toBe(canceled);
  });
});
