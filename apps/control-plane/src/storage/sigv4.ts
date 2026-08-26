import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, as specified in the AWS General Reference
 * ("Signature Version 4 signing process") and the Amazon S3 API Reference
 * ("Authenticating Requests (AWS Signature Version 4)"), written against
 * `node:crypto` alone.
 *
 * The repository carries no cloud SDK by design: the control plane's only
 * runtime dependencies are the drivers it cannot do without, and a signing
 * algorithm that fits in one file is not one of them. What this module does
 * not do is also deliberate: it never reads a credential from the environment,
 * never keeps one between calls, and never puts one anywhere but the HMAC
 * chain. The caller passes credentials in and gets a signature out.
 *
 * Correctness is proved in `sigv4.test.ts` against the vectors of the
 * official AWS SigV4 test suite and the worked examples in the S3 API
 * Reference, not against a second implementation.
 */

export const sigV4Algorithm = 'AWS4-HMAC-SHA256';
/** The `x-amz-content-sha256` value a presigned URL declares: the body is not part of the signature. */
export const unsignedPayload = 'UNSIGNED-PAYLOAD';
/** SHA-256 of the empty string, the payload hash of a bodiless signed request. */
export const emptyPayloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SigV4Scope {
  readonly region: string;
  /** `s3` for object storage; the AWS test suite uses the literal `service`. */
  readonly service: string;
}

export interface SigV4Request {
  readonly method: string;
  /** Host, path and query are all signed; a fragment is ignored. */
  readonly url: URL;
  /** Headers to sign. `host` is derived from `url` and must not be supplied. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SigV4SignedHeadersInput extends SigV4Request {
  readonly credentials: SigV4Credentials;
  readonly scope: SigV4Scope;
  /** Hex SHA-256 of the body, or {@link unsignedPayload}. */
  readonly payloadHash: string;
  readonly signedAt: Date;
}

export interface SigV4PresignInput extends SigV4Request {
  readonly credentials: SigV4Credentials;
  readonly scope: SigV4Scope;
  readonly signedAt: Date;
  /** 1 second to 7 days, the range S3 accepts for `X-Amz-Expires`. */
  readonly expiresInSeconds: number;
}

export interface CanonicalRequest {
  readonly text: string;
  readonly signedHeaders: string;
}

const maximumPresignSeconds = 7 * 24 * 60 * 60;

/**
 * Signs a request the control plane sends itself — CreateMultipartUpload,
 * CompleteMultipartUpload, AbortMultipartUpload, HeadObject — and returns the
 * complete header set to send: the caller's headers plus `host`, `x-amz-date`,
 * `x-amz-content-sha256` and `authorization`.
 */
export function signHeaders(input: SigV4SignedHeadersInput): Readonly<Record<string, string>> {
  const amzDate = formatAmzDate(input.signedAt);
  const headers: Record<string, string> = {
    ...lowercaseHeaders(input.headers ?? {}),
    host: input.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': input.payloadHash,
  };
  const canonical = canonicalRequest(input.method, input.url, headers, input.payloadHash);
  const credentialScope = formatCredentialScope(amzDate, input.scope);
  const signature = sign(
    input.credentials.secretAccessKey,
    amzDate,
    input.scope,
    stringToSign(amzDate, credentialScope, canonical.text),
  );
  return Object.freeze({
    ...headers,
    authorization:
      `${sigV4Algorithm} Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`,
  });
}

/**
 * Produces a presigned URL: the request's own query parameters plus the
 * `X-Amz-*` set, with the signature appended last. Only `host` is a signed
 * header, so whoever holds the URL can send it from any client without
 * reproducing headers — which is exactly what an upload grant handed to a
 * browser needs.
 */
export function presign(input: SigV4PresignInput): URL {
  if (
    !Number.isSafeInteger(input.expiresInSeconds) ||
    input.expiresInSeconds < 1 ||
    input.expiresInSeconds > maximumPresignSeconds
  ) {
    throw new Error('A presigned URL must expire between 1 second and 7 days after signing');
  }
  const amzDate = formatAmzDate(input.signedAt);
  const credentialScope = formatCredentialScope(amzDate, input.scope);
  const headers = { ...lowercaseHeaders(input.headers ?? {}), host: input.url.host };
  const signedHeaders = Object.keys(headers).sort().join(';');

  const url = new URL(input.url.toString());
  url.hash = '';
  url.searchParams.set('X-Amz-Algorithm', sigV4Algorithm);
  url.searchParams.set('X-Amz-Credential', `${input.credentials.accessKeyId}/${credentialScope}`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', input.expiresInSeconds.toString());
  url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);

  const canonical = canonicalRequest(input.method, url, headers, unsignedPayload);
  const signature = sign(
    input.credentials.secretAccessKey,
    amzDate,
    input.scope,
    stringToSign(amzDate, credentialScope, canonical.text),
  );
  url.searchParams.set('X-Amz-Signature', signature);
  return url;
}

/**
 * The canonical request, exactly as the S3 rules lay it out: method, the
 * single-encoded path, the sorted and encoded query, the sorted lowercase
 * headers each on its own line, a blank line, the signed-header list, and the
 * payload hash. S3 differs from other AWS services in one point that matters
 * here: the path is URI-encoded once, not twice, so an object key containing
 * `%` is sent as `%25` and signed as `%25`.
 */
export function canonicalRequest(
  method: string,
  url: URL,
  headers: Readonly<Record<string, string>>,
  payloadHash: string,
): CanonicalRequest {
  const canonicalHeaders = Object.entries(lowercaseHeaders(headers)).sort(([left], [right]) =>
    compareAscii(left, right),
  );
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(';');
  const text = [
    method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url),
    canonicalHeaders.map(([name, value]) => `${name}:${value}`).join('\n') + '\n',
    signedHeaders,
    payloadHash,
  ].join('\n');
  return { text, signedHeaders };
}

export function stringToSign(amzDate: string, credentialScope: string, canonical: string): string {
  return [sigV4Algorithm, amzDate, credentialScope, sha256Hex(canonical)].join('\n');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `YYYYMMDDTHHMMSSZ`, the instant every SigV4 artefact is stamped with. */
export function formatAmzDate(instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new Error('A signing instant must be a valid date');
  return instant
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

export function formatCredentialScope(amzDate: string, scope: SigV4Scope): string {
  return `${amzDate.slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`;
}

/**
 * RFC 3986 unreserved characters pass through; everything else is
 * percent-encoded with uppercase hex. `encodeURIComponent` leaves `!'()*`
 * alone and SigV4 does not, which is why they are encoded here by hand.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The signing-key derivation: four HMACs from `AWS4` + secret through the
 * date, region and service to the `aws4_request` terminator. The secret is a
 * parameter and never a captured value.
 */
function sign(secretAccessKey: string, amzDate: string, scope: SigV4Scope, text: string): string {
  const kDate = hmac(`AWS4${secretAccessKey}`, amzDate.slice(0, 8));
  const kRegion = hmac(kDate, scope.region);
  const kService = hmac(kRegion, scope.service);
  const kSigning = hmac(kService, 'aws4_request');
  return createHmac('sha256', kSigning).update(text).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * The path is re-encoded segment by segment from its decoded form, so a key
 * the caller already percent-encoded and one it did not both canonicalise to
 * the same bytes S3 will see.
 */
function canonicalPath(pathname: string): string {
  if (pathname.length === 0) return '/';
  return pathname
    .split('/')
    .map((segment) => uriEncode(safeDecode(segment)))
    .join('/');
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    pairs.push([uriEncode(name), uriEncode(value)]);
  }
  pairs.sort(([leftName, leftValue], [rightName, rightValue]) => {
    const byName = compareAscii(leftName, rightName);
    return byName === 0 ? compareAscii(leftValue, rightValue) : byName;
  });
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

function lowercaseHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.trim().toLowerCase();
    if (key.length === 0) throw new Error('A signed header must have a name');
    if (key in normalized) throw new Error(`Header ${key} is supplied twice`);
    // Sequential spaces collapse and the ends are trimmed, as the canonical
    // form requires; a value with a newline in it cannot be canonicalised.
    const canonicalValue = value.trim().replace(/\s+/gu, ' ');
    if (/[\r\n]/u.test(value)) throw new Error(`Header ${key} must not contain a line break`);
    normalized[key] = canonicalValue;
  }
  return normalized;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function compareAscii(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
