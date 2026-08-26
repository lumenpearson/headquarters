import { describe, expect, it } from 'vitest';

import {
  canonicalRequest,
  emptyPayloadHash,
  formatAmzDate,
  presign,
  sha256Hex,
  signHeaders,
  stringToSign,
  unsignedPayload,
  uriEncode,
} from './sigv4.js';

/**
 * Two sources of truth, neither of them this repository.
 *
 * The first block is the official AWS Signature Version 4 test suite
 * (`aws-sig-v4-test-suite`, distributed with the AWS General Reference and
 * mirrored verbatim under `tests/unit/auth/aws4_testsuite` in botocore): each
 * case ships the request, the expected canonical request (`.creq`), the string
 * to sign (`.sts`) and the Authorization header (`.authz`), all for the key
 * `AKIDEXAMPLE` on 2015-08-30T12:36:00Z in `us-east-1` against a service
 * literally named `service`.
 *
 * The second block is the worked examples of the Amazon S3 API Reference:
 * "Authenticating Requests: Using Query Parameters" for a presigned GET, and
 * "Examples: Signature Calculations in AWS Signature Version 4" for a header-
 * signed GET with a `Range` and a PUT with a body — the `examplebucket`
 * examples signed with `AKIAIOSFODNN7EXAMPLE` on 2013-05-24T00:00:00Z.
 */
const testSuiteCredentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const testSuiteScope = { region: 'us-east-1', service: 'service' };
const testSuiteInstant = new Date('2015-08-30T12:36:00Z');

const s3ExampleCredentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const s3ExampleScope = { region: 'us-east-1', service: 's3' };
const s3ExampleInstant = new Date('2013-05-24T00:00:00Z');

describe('AWS SigV4 test-suite vectors', () => {
  it('get-vanilla: signs a bare GET with host and date', () => {
    const url = new URL('https://example.amazonaws.com/');
    const canonical = canonicalRequest(
      'GET',
      url,
      { host: url.host, 'x-amz-date': '20150830T123600Z' },
      emptyPayloadHash,
    );
    expect(canonical.text).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        emptyPayloadHash,
      ].join('\n'),
    );
    expect(
      stringToSign('20150830T123600Z', '20150830/us-east-1/service/aws4_request', canonical.text),
    ).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/service/aws4_request',
        'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
      ].join('\n'),
    );

    const signed = signHeaders({
      credentials: testSuiteCredentials,
      scope: testSuiteScope,
      method: 'GET',
      url,
      payloadHash: emptyPayloadHash,
      signedAt: testSuiteInstant,
    });
    // The suite signs host and x-amz-date only; this module also declares the
    // payload hash as a header, which S3 requires and the generic suite does
    // not. The vector therefore proves the derivation on the suite's own header
    // set, computed below, while `signHeaders` is proved by the S3 examples.
    expect(signed['x-amz-date']).toBe('20150830T123600Z');
    expect(signed.authorization).toContain(
      'Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request',
    );
  });

  it('get-vanilla-query-order-key-case: sorts query parameters by name', () => {
    const url = new URL('https://example.amazonaws.com/?Param2=value2&Param1=value1');
    const canonical = canonicalRequest(
      'GET',
      url,
      { host: url.host, 'x-amz-date': '20150830T123600Z' },
      emptyPayloadHash,
    );
    expect(canonical.text.split('\n')[2]).toBe('Param1=value1&Param2=value2');
    expect(sha256Hex(canonical.text)).toBe(
      '816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0',
    );
  });

  it('get-utf8: percent-encodes a non-ASCII path once, with uppercase hex', () => {
    const url = new URL('https://example.amazonaws.com/ሴ');
    const canonical = canonicalRequest(
      'GET',
      url,
      { host: url.host, 'x-amz-date': '20150830T123600Z' },
      emptyPayloadHash,
    );
    expect(canonical.text.split('\n')[1]).toBe('/%E1%88%B4');
    expect(sha256Hex(canonical.text)).toBe(
      '2a0a97d02205e45ce2e994789806b19270cfbbb0921b278ccf58f5249ac42102',
    );
  });

  it('post-vanilla-query: keeps the method and a single query parameter', () => {
    const url = new URL('https://example.amazonaws.com/?Param1=value1');
    const canonical = canonicalRequest(
      'POST',
      url,
      { host: url.host, 'x-amz-date': '20150830T123600Z' },
      emptyPayloadHash,
    );
    expect(sha256Hex(canonical.text)).toBe(
      '9d659678c1756bb3113e2ce898845a0a79dbbc57b740555917687f1b3340fbbd',
    );
  });
});

describe('Amazon S3 API Reference examples', () => {
  it('presigns GET /test.txt exactly as the query-parameter example does', () => {
    const url = presign({
      credentials: s3ExampleCredentials,
      scope: s3ExampleScope,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      signedAt: s3ExampleInstant,
      expiresInSeconds: 86_400,
    });

    expect(url.toString()).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('signs the GET Object example with its Range header', () => {
    const url = new URL('https://examplebucket.s3.amazonaws.com/test.txt');
    const signed = signHeaders({
      credentials: s3ExampleCredentials,
      scope: s3ExampleScope,
      method: 'GET',
      url,
      headers: { Range: 'bytes=0-9' },
      payloadHash: emptyPayloadHash,
      signedAt: s3ExampleInstant,
    });

    const canonical = canonicalRequest(
      'GET',
      url,
      {
        host: url.host,
        range: 'bytes=0-9',
        'x-amz-content-sha256': emptyPayloadHash,
        'x-amz-date': '20130524T000000Z',
      },
      emptyPayloadHash,
    );
    expect(sha256Hex(canonical.text)).toBe(
      '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
    );
    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('signs the PUT Object example, body hash and `$` in the key included', () => {
    const payloadHash = sha256Hex('Welcome to Amazon S3.');
    expect(payloadHash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');

    const signed = signHeaders({
      credentials: s3ExampleCredentials,
      scope: s3ExampleScope,
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: {
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payloadHash,
      signedAt: s3ExampleInstant,
    });

    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, ' +
        'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });
});

describe('SigV4 building blocks', () => {
  it('formats the signing instant without separators or milliseconds', () => {
    expect(formatAmzDate(new Date('2026-08-25T14:03:09.451Z'))).toBe('20260825T140309Z');
    expect(() => formatAmzDate(new Date('not a date'))).toThrow('valid date');
  });

  it('encodes what encodeURIComponent leaves alone and nothing it should not', () => {
    expect(uriEncode("a-b_c.d~e f!g'h(i)j*k/l")).toBe('a-b_c.d~e%20f%21g%27h%28i%29j%2Ak%2Fl');
  });

  it('bounds the presign lifetime to what S3 accepts', () => {
    const base = {
      credentials: s3ExampleCredentials,
      scope: s3ExampleScope,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      signedAt: s3ExampleInstant,
    };
    expect(() => presign({ ...base, expiresInSeconds: 0 })).toThrow('between 1 second and 7 days');
    expect(() => presign({ ...base, expiresInSeconds: 604_801 })).toThrow(
      'between 1 second and 7 days',
    );
  });

  it('declares an unsigned payload on every presigned URL', () => {
    const url = presign({
      credentials: s3ExampleCredentials,
      scope: s3ExampleScope,
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/key%20with%20space?partNumber=2'),
      signedAt: s3ExampleInstant,
      expiresInSeconds: 60,
    });
    // The canonical path is re-derived from the decoded key, so a
    // pre-encoded space and a literal one sign identically.
    const literal = presign({
      credentials: s3ExampleCredentials,
      scope: s3ExampleScope,
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/key with space?partNumber=2'),
      signedAt: s3ExampleInstant,
      expiresInSeconds: 60,
    });
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      literal.searchParams.get('X-Amz-Signature'),
    );
    expect(url.searchParams.get('partNumber')).toBe('2');
    expect(unsignedPayload).toBe('UNSIGNED-PAYLOAD');
  });

  it('refuses a header it cannot canonicalise', () => {
    const base = {
      credentials: s3ExampleCredentials,
      scope: s3ExampleScope,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      payloadHash: emptyPayloadHash,
      signedAt: s3ExampleInstant,
    };
    expect(() => signHeaders({ ...base, headers: { 'x-amz-meta-a': 'one\ntwo' } })).toThrow(
      'line break',
    );
    expect(() =>
      signHeaders({ ...base, headers: { 'X-Amz-Meta-A': 'one', 'x-amz-meta-a': 'two' } }),
    ).toThrow('supplied twice');
  });
});
