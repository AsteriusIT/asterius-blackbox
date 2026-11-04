import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { checkIdToken } from '../src/entra.js';

const ISS = 'https://login.microsoftonline.com/tenant-1/v2.0';
let priv: CryptoKey;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  priv = kp.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' }] });
});

const token = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string; key?: CryptoKey } = {}) =>
  new SignJWT({ tid: 'tenant-1', oid: 'oid-1', nonce: 'n1', name: 'Ada', email: 'Ada@X.io', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? 'client-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(opts.key ?? priv);

describe('checkIdToken', () => {
  it('accepts a valid token and extracts the identity', async () => {
    expect(await checkIdToken(await token({}), 'n1', keys)).toEqual({ externalId: 'tenant-1:oid-1', email: 'ada@x.io', name: 'Ada', groups: [] });
    expect((await checkIdToken(await token({ groups: ['g1', 'g2'] }), 'n1', keys)).groups).toEqual(['g1', 'g2']);
  });
  it('rejects nonce, tenant, issuer, audience, oid and signature problems', async () => {
    await expect(checkIdToken(await token({}), 'other', keys)).rejects.toThrow(/nonce/);
    await expect(checkIdToken(await token({ tid: 'evil' }), 'n1', keys)).rejects.toThrow(/tenant/);
    await expect(checkIdToken(await token({}, { iss: 'https://evil/v2.0' }), 'n1', keys)).rejects.toThrow(/iss/);
    await expect(checkIdToken(await token({}, { aud: 'other' }), 'n1', keys)).rejects.toThrow(/aud/);
    await expect(checkIdToken(await token({ oid: '' }), 'n1', keys)).rejects.toThrow(/oid/);
    const other = (await generateKeyPair('RS256')).privateKey;
    await expect(checkIdToken(await token({}, { key: other }), 'n1', keys)).rejects.toThrow(/signature/);
  });
});
