import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Per-user encryption at rest for reminder text.
 *
 * Where the master key comes from
 * -------------------------------
 * By default it is derived from TELEGRAM_BOT_TOKEN with HKDF-SHA256, so there
 * is nothing extra to generate or store: the token is already a secret, it
 * lives in the deployment environment, and — crucially — it is NOT in the
 * database. A dump of Upstash therefore cannot be decrypted.
 *
 * Setting ENCRYPTION_KEY explicitly overrides that and is the more robust
 * option, because it survives rotating the bot token in BotFather. Both keys
 * are tried on decryption, so switching from one to the other never orphans
 * existing records — they are re-encrypted with the primary key on next save.
 *
 * What is deliberately NOT used as a key: the Telegram user id. It is stored
 * next to the ciphertext and the algorithm is public, so it would provide
 * obfuscation rather than confidentiality.
 *
 * Threat model
 * ------------
 * Protects against: a dump or breach of the Upstash database, and anyone with
 * read access to it.
 * Does NOT protect against: Telegram itself (the Bot API has no end-to-end
 * encryption — the delivered message is plaintext by definition), or someone
 * who holds the deployment's environment variables.
 *
 * Why per-user keys
 * -----------------
 * Every user gets their own key, derived from the master key and their Telegram
 * id. Each ciphertext is additionally bound to "<userId>|<reminderId>" as GCM
 * additional authenticated data. A record belonging to user A therefore cannot
 * be decrypted in the context of user B — not by a bug, not by a swapped id,
 * not by copying blobs between records. It fails loudly instead of returning
 * someone else's text.
 */

const VERSION = 'v2';
const LEGACY_VERSION = 'v1';
const USER_KEY_SALT = 'tg-reminder-bot|hkdf|v1';
const MASTER_FROM_TOKEN_SALT = 'tg-reminder-bot|master-key-from-bot-token|v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export interface MasterKey {
  /** Short stable fingerprint, stored inside the ciphertext to identify the key. */
  id: string;
  key: Buffer;
  source: 'ENCRYPTION_KEY' | 'TELEGRAM_BOT_TOKEN';
}

let masterKeysCache: MasterKey[] | undefined;
let masterKeysSignature: string | undefined;

/** Cache of per-user keys, keyed by "<masterKeyId>:<userId>". */
const userKeyCache = new Map<string, Buffer>();

function fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 8);
}

/**
 * All usable master keys, primary first. Recomputed whenever the relevant
 * environment changes, so no stale key survives a redeploy or a test.
 */
function loadMasterKeys(): MasterKey[] {
  const explicit = process.env.ENCRYPTION_KEY?.trim() ?? '';
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const signature = `${explicit}|${botToken}`;

  if (masterKeysCache && masterKeysSignature === signature) return masterKeysCache;

  const keys: MasterKey[] = [];

  if (explicit) {
    const key = Buffer.from(explicit, 'base64');
    if (key.length !== 32) {
      throw new Error(
        `ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}. ` +
          'Either fix it or remove it — without it the key is derived from TELEGRAM_BOT_TOKEN.'
      );
    }
    keys.push({ key, id: fingerprint(key), source: 'ENCRYPTION_KEY' });
  }

  if (botToken && botToken !== 'dummy_token_for_build') {
    const key = Buffer.from(
      hkdfSync('sha256', botToken, Buffer.from(MASTER_FROM_TOKEN_SALT), 'master-key', 32)
    );
    keys.push({ key, id: fingerprint(key), source: 'TELEGRAM_BOT_TOKEN' });
  }

  masterKeysCache = keys;
  masterKeysSignature = signature;
  return keys;
}

/** True when text will be stored encrypted. */
export function isEncryptionEnabled(): boolean {
  return loadMasterKeys().length > 0;
}

/** Which key is in use — surfaced by /api/setup. */
export function getEncryptionStatus(): {
  enabled: boolean;
  source: string | null;
  keyId: string | null;
  fallbackKeys: number;
} {
  const keys = loadMasterKeys();
  return {
    enabled: keys.length > 0,
    source: keys[0]?.source ?? null,
    keyId: keys[0]?.id ?? null,
    fallbackKeys: Math.max(0, keys.length - 1),
  };
}

/**
 * The active master key in base64, for pinning it as ENCRYPTION_KEY before
 * rotating the bot token. Returns null when encryption is off.
 */
export function exportMasterKey(): string | null {
  const primary = loadMasterKeys()[0];
  return primary ? primary.key.toString('base64') : null;
}

function deriveUserKey(master: MasterKey, userId: number): Buffer {
  const cacheKey = `${master.id}:${userId}`;
  const cached = userKeyCache.get(cacheKey);
  if (cached) return cached;

  const key = Buffer.from(hkdfSync('sha256', master.key, Buffer.from(USER_KEY_SALT), `user:${userId}`, 32));
  userKeyCache.set(cacheKey, key);
  return key;
}

function buildAad(version: string, userId: number, context: string): Buffer {
  return Buffer.from(`${version}|${userId}|${context}`, 'utf8');
}

/** True if the stored value looks like something this module produced. */
export function isCiphertext(value: string): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts[0] === VERSION) return parts.length === 5;
  if (parts[0] === LEGACY_VERSION) return parts.length === 4;
  return false;
}

/**
 * Encrypts `plaintext` for one user. Returns the plaintext unchanged when no
 * key is available, so the bot keeps working in any configuration.
 */
export function encryptForUser(userId: number, plaintext: string, context: string): string {
  const master = loadMasterKeys()[0];
  if (!master) return plaintext;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveUserKey(master, userId), iv);
  cipher.setAAD(buildAad(VERSION, userId, context));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    master.id,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function tryDecrypt(
  master: MasterKey,
  userId: number,
  version: string,
  ivPart: string,
  tagPart: string,
  dataPart: string,
  context: string
): string | null {
  try {
    const decipher = createDecipheriv(ALGORITHM, deriveUserKey(master, userId), Buffer.from(ivPart, 'base64url'));
    decipher.setAAD(buildAad(version, userId, context));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString(
      'utf8'
    );
  } catch {
    return null;
  }
}

/**
 * Decrypts a value produced by `encryptForUser`.
 *
 * Returns the value unchanged if it is legacy plaintext (written before
 * encryption was enabled), and `null` if it is ciphertext that does not
 * authenticate — wrong user, wrong reminder, tampering, or a master key that is
 * no longer available (e.g. the bot token was rotated).
 */
export function decryptForUser(userId: number, value: string, context: string): string | null {
  if (!isCiphertext(value)) return value;

  const keys = loadMasterKeys();
  if (keys.length === 0) return null;

  const parts = value.split('.');
  const version = parts[0];
  const [ivPart, tagPart, dataPart] =
    version === VERSION ? [parts[2], parts[3], parts[4]] : [parts[1], parts[2], parts[3]];
  const keyId = version === VERSION ? parts[1] : null;

  // Try the key the ciphertext was written with first, then every other key we
  // hold. That is what makes moving between ENCRYPTION_KEY and the token-derived
  // key seamless: old records keep opening while new ones use the primary key.
  const ordered = keyId ? [...keys].sort((a, b) => (a.id === keyId ? -1 : b.id === keyId ? 1 : 0)) : keys;

  for (const master of ordered) {
    const result = tryDecrypt(master, userId, version, ivPart, tagPart, dataPart, context);
    if (result !== null) return result;
  }

  return null;
}
