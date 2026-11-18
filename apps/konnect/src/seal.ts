/**
 * Sealing an agent's login for one machine: `konnect agent run --on <machine>` sends the login it
 * was issued in the browser to the machine that hosts, through the service, and it travels sealed
 * to a key only that machine holds.
 *
 * What this keeps: the login out of the service's database and logs while the request waits. What
 * it doesn't: the service issued the login and names the machine's key, so it is trusted as before.
 *
 * X25519, HKDF-SHA256 and AES-256-GCM, from node:crypto. A sealed text is
 * `v1.<sender's one-time key>.<nonce>.<sealed>.<tag>`, each part base64url. `bound` is what the
 * sealed text is for (the team, the machine and the agent), and it opens for nothing else.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const raw = (s: string) => Buffer.from(s, 'base64url');

/** A machine's key as it is published: 32 bytes, base64url. */
export const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
/** A sealed text, as it is written. */
export const SEALED = /^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/;

const publicOf = (x: string): KeyObject => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
const privateOf = (x: string, d: string): KeyObject => createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x, d }, format: 'jwk' });

/** A new pair: `publicKey` to publish, `privateKey` to keep. */
export function newKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  if (!PUBLIC_KEY.test(jwk.x)) throw new Error('konnect couldn\'t make this machine a key');
  void publicKey;
  return { publicKey: jwk.x, privateKey: jwk.d };
}

const keyFor = (shared: Buffer, sender: string, receiver: string) => Buffer.from(hkdfSync('sha256', shared, Buffer.concat([raw(sender), raw(receiver)]), 'konnect host login v1', 32));

/** Seals `text` to the machine whose key is `publicKey`, for `bound` alone. */
export function seal(publicKey: string, text: string, bound: string): string {
  if (!PUBLIC_KEY.test(publicKey)) throw new Error('that isn\'t a machine\'s key');
  const once = generateKeyPairSync('x25519');
  const sender = (once.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const key = keyFor(diffieHellman({ privateKey: once.privateKey, publicKey: publicOf(publicKey) }), sender, publicKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(bound, 'utf8'));
  const sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `v1.${sender}.${b64(nonce)}.${b64(sealed)}.${b64(cipher.getAuthTag())}`;
}

/** Opens what was sealed to this machine's pair for `bound`; throws when it wasn't, or was changed. */
export function unseal(keys: { publicKey: string; privateKey: string }, sealed: string, bound: string): string {
  if (!SEALED.test(sealed)) throw new Error('that isn\'t a sealed login');
  const [, sender, nonce, body, tag] = sealed.split('.');
  const key = keyFor(diffieHellman({ privateKey: privateOf(keys.publicKey, keys.privateKey), publicKey: publicOf(sender) }), sender, keys.publicKey);
  const decipher = createDecipheriv('aes-256-gcm', key, raw(nonce));
  decipher.setAAD(Buffer.from(bound, 'utf8'));
  decipher.setAuthTag(raw(tag));
  return Buffer.concat([decipher.update(raw(body)), decipher.final()]).toString('utf8');
}
