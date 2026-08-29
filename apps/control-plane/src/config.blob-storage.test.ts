import { describe, expect, it } from 'vitest';

import { loadControlPlaneConfig } from './config.js';

/**
 * The Vercel Blob storage group, parsed at the trust boundary.
 *
 * It lives in its own file rather than inside `config.test.ts` because it is one
 * group with one set of refusals, and every one of them is a startup failure
 * that must name what is wrong: a deployment discovering at the first upload
 * that it configured two object stores, or a cleartext store origin, has already
 * shipped.
 */

const token = 'vercel_blob_rw_store01HQ_abcdefghijklmnopqrstuvwxyz012345';
const publicBaseUrl = 'https://store01hq.public.blob.vercel-storage.com';

describe('blob storage configuration', () => {
  it('is absent when no variable of the group is set', () => {
    expect(loadControlPlaneConfig({}).blobStorage).toBeUndefined();
  });

  it('builds the defaults from the two required values', () => {
    const config = loadControlPlaneConfig({
      HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN: token,
      HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL: publicBaseUrl,
    }).blobStorage;

    expect(config).toMatchObject({
      apiBaseUrl: 'https://blob.vercel-storage.com',
      publicBaseUrl,
      storeId: 'store01HQ',
      grantTtlMs: 900_000,
      maxObjectBytes: 104_857_600n,
    });
  });

  it('keeps the deployment token out of every enumerable property', () => {
    const config = loadControlPlaneConfig({
      HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN: token,
      HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL: publicBaseUrl,
    }).blobStorage;

    // The whole point of the closure: an error, a log line or a health payload
    // that serialized this object cannot carry the credential.
    expect(
      JSON.stringify(config, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(token);
    expect(Object.values(config ?? {}).join(' ')).not.toContain(token);
    expect(config?.openToken()).toBe(token);
  });

  it('names the missing half of the pair', () => {
    expect(() =>
      loadControlPlaneConfig({ HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN: token }),
    ).toThrowError(/HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL/u);
  });

  it('refuses two configured object stores for one library', () => {
    expect(() =>
      loadControlPlaneConfig({
        HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN: token,
        HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL: publicBaseUrl,
        HQ_CONTROL_PLANE_STORAGE_ENDPOINT: 'https://s3.example.com',
        HQ_CONTROL_PLANE_STORAGE_REGION: 'eu-central-1',
        HQ_CONTROL_PLANE_STORAGE_BUCKET: 'hq-materials',
        HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID: 'access-key',
        HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY: 'secret-key-value',
      }),
    ).toThrowError(/exactly one of them/u);
  });

  it('refuses a token that is not the documented five-part form', () => {
    for (const candidate of [
      'vercel_blob_rw_store01HQ',
      'vercel_blob_rw_store01HQ_secret with a space',
      'nope',
    ]) {
      expect(() =>
        loadControlPlaneConfig({
          HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN: candidate,
          HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL: publicBaseUrl,
        }),
      ).toThrowError(/vercel_blob_rw/u);
    }
  });

  it('refuses a cleartext or path-bearing store origin', () => {
    for (const candidate of [
      'http://store01hq.public.blob.vercel-storage.com',
      'https://store01hq.public.blob.vercel-storage.com/materials',
      'https://user:pass@store01hq.public.blob.vercel-storage.com',
    ]) {
      expect(() =>
        loadControlPlaneConfig({
          HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN: token,
          HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL: candidate,
        }),
      ).toThrowError(/HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL/u);
    }
  });

  it('bounds the single-request ceiling the deployment states', () => {
    for (const candidate of ['0', '1024', (2 * 1024 * 1024 * 1024).toString(), 'many']) {
      expect(() =>
        loadControlPlaneConfig({
          HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN: token,
          HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL: publicBaseUrl,
          HQ_CONTROL_PLANE_BLOB_STORAGE_MAX_OBJECT_BYTES: candidate,
        }),
      ).toThrowError(/HQ_CONTROL_PLANE_BLOB_STORAGE_MAX_OBJECT_BYTES/u);
    }
  });

  it('mints a client token that names the object and not the deployment token', () => {
    const config = loadControlPlaneConfig({
      HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN: token,
      HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL: publicBaseUrl,
    }).blobStorage;
    const validUntil = new Date('2026-08-29T09:15:00.000Z');

    const minted = config?.mintClientToken({
      pathname: 'materials/group/hash',
      contentType: 'video/mp4',
      maximumSizeInBytes: 1024n,
      validUntil,
    });

    expect(minted?.startsWith('vercel_blob_client_store01HQ_')).toBe(true);
    expect(minted).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    // Two grants for two objects are two different tokens, so a leaked one is
    // spendable on exactly the object it was minted for.
    const other = config?.mintClientToken({
      pathname: 'materials/group/other',
      contentType: 'video/mp4',
      maximumSizeInBytes: 1024n,
      validUntil,
    });
    expect(other).not.toBe(minted);
  });
});
