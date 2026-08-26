import { describe, expect, it } from 'vitest';

import { createBearerInterceptor } from './authInterceptor';

/** The two fields of a Connect request this interceptor touches. */
function request(header: Headers = new Headers()) {
  return { header } as unknown as Parameters<
    ReturnType<ReturnType<typeof createBearerInterceptor>>
  >[0];
}

describe('bearer interceptor', () => {
  it('adds the access token the session holds at the moment of the call', async () => {
    let token = 'access-1';
    const interceptor = createBearerInterceptor(() => token);
    const headers: Headers[] = [];
    const call = interceptor(async (next) => {
      headers.push(next.header);
      return {} as never;
    });

    await call(request());
    // Rotated between calls: the token is read per call, not captured when
    // the transport was built, so a refresh reaches the very next request.
    token = 'access-2';
    await call(request());

    expect(headers.map((header) => header.get('Authorization'))).toEqual([
      'Bearer access-1',
      'Bearer access-2',
    ]);
  });

  it('sends no header at all before the client has a session', async () => {
    const interceptor = createBearerInterceptor(() => undefined);
    let sent: Headers | undefined;
    const call = interceptor(async (next) => {
      sent = next.header;
      return {} as never;
    });

    await call(request());

    // `PairDevice` is unauthenticated: the pairing code is the credential, and
    // an empty bearer header would be a credential claim this client cannot back.
    expect(sent?.has('Authorization')).toBe(false);
  });

  it('leaves a header the caller set itself alone', async () => {
    const interceptor = createBearerInterceptor(() => 'access-1');
    let sent: Headers | undefined;
    const call = interceptor(async (next) => {
      sent = next.header;
      return {} as never;
    });

    await call(request(new Headers({ Authorization: 'Bearer explicit' })));

    expect(sent?.get('Authorization')).toBe('Bearer explicit');
  });
});
