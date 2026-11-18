/**
 * Pairing: what lets one machine of yours ask another to start your agents, and nobody else.
 *
 * A machine that hosts (`konnect host run`) makes a code, 120 random bits, and shows it. You give
 * it once to each machine that may ask (`konnect host pair <machine> <code>`). The code never goes
 * to the service. Every request to the machine, and every answer from it, is sealed with a key
 * made from the code: the machine carries out only what opens with it, so neither the service nor
 * someone holding a copy of your login can ask it for anything, read a request (an agent's login
 * travels in one), or forge its answer.
 *
 * HKDF-SHA256 and AES-256-GCM, from node:crypto. A sealed text is `k1.<nonce>.<sealed>.<tag>`,
 * each part base64url. `bound` says what the sealed text is (which way it goes, and what kind of
 * request), and it opens as nothing else.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const raw = (s: string) => Buffer.from(s, 'base64url');

/** The letters a code is written in: Crockford's base32, which has no I, L, O or U to misread. */
const LETTERS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A code as it is shown: six groups of four. */
export const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/;
/** A sealed text, as it is written. */
export const SEALED = /^k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/;
/** What a machine publishes of its code: a fingerprint, 32 bytes as base64url, from which the code can't be had. */
export const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;

/** A new code. */
export function newCode(): string {
  // 24 letters of 5 bits each, from 15 random bytes.
  const bits = [...randomBytes(15)].map((b) => b.toString(2).padStart(8, '0')).join('');
  const letters = Array.from({ length: 24 }, (_, i) => LETTERS[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]).join('');
  return letters.match(/.{4}/g)!.join('-');
}

/** A code as a person gave it, written as konnect shows one: case, spaces and dashes aside, and O, I and L read as 0 and 1. Undefined when it isn't one. */
export function readCode(given: string): string | undefined {
  const letters = given.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const code = letters.match(/.{1,4}/g)?.join('-') ?? '';
  return CODE.test(code) ? code : undefined;
}

/** What says which machine, in which team, a key is for. */
const place = (team: string, host: string) => `${team}\n${host}`;

/** The key a code gives for one machine in one team. */
export function keyOf(code: string, team: string, host: string): Buffer {
  if (!CODE.test(code)) throw new Error('that isn\'t a pairing code');
  return Buffer.from(hkdfSync('sha256', Buffer.from(code.replace(/-/g, ''), 'ascii'), Buffer.from(place(team, host), 'utf8'), 'konnect host pairing v1', 32));
}

/** What the machine publishes, so that a machine paired with an earlier code is told so before it asks: it gives nothing of the key away. */
export function fingerprint(key: Buffer, team: string, host: string): string {
  return b64(createHash('sha256').update('konnect host fingerprint v1\n').update(place(team, host)).update('\n').update(key).digest());
}

/** Seals `text` with the key, as `bound` alone. */
export function seal(key: Buffer, text: string, bound: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(bound, 'utf8'));
  const sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `k1.${b64(nonce)}.${b64(sealed)}.${b64(cipher.getAuthTag())}`;
}

/** Opens what was sealed with the key as `bound`; throws when it wasn't, or was changed on the way. */
export function unseal(key: Buffer, sealed: string, bound: string): string {
  if (typeof sealed !== 'string' || !SEALED.test(sealed)) throw new Error('that isn\'t sealed');
  const [, nonce, body, tag] = sealed.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key, raw(nonce), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(bound, 'utf8'));
  decipher.setAuthTag(raw(tag));
  return Buffer.concat([decipher.update(raw(body)), decipher.final()]).toString('utf8');
}
