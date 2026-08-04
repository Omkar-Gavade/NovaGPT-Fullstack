import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope encryption for user-supplied provider keys (T2).
 *
 * Two layers. A random **data key** encrypts the secret; the **master key**
 * encrypts the data key. The ciphertext and the wrapped data key go to Mongo;
 * the master key never does.
 *
 * **Why envelopes rather than encrypting with the master key directly.**
 * Rotating a directly-applied master key means decrypting and re-encrypting
 * every record — a long, risky, all-or-nothing migration that in practice never
 * happens. With envelopes, rotation re-wraps a handful of data keys and leaves
 * every ciphertext untouched. It also means a database dump alone recovers
 * nothing, because the key that unlocks it was never in the database
 * (docs/backend/10-security.md#envelope-encryption-for-user-keys).
 *
 * **Why AES-256-GCM.** Authenticated encryption. Tampering with the ciphertext
 * fails decryption instead of producing plausible garbage — and garbage here
 * would be sent to a provider, rejected as an auth failure, and send debugging
 * in entirely the wrong direction.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the GCM-recommended size
const VERSION = 1;

export class EnvelopeCipher {
  /**
   * @param {object} deps
   * @param {Buffer|string} deps.masterKey 32 bytes, base64 when a string
   * @param {string} [deps.masterKeyId] recorded per record so a rotation knows
   *                                    which master unwrapped which envelope
   */
  constructor({ masterKey, masterKeyId = "primary" }) {
    this.masterKey = toKey(masterKey);
    this.masterKeyId = masterKeyId;
  }

  /** A fresh master key, for `.env` generation and for tests. */
  static generateMasterKey() {
    return randomBytes(KEY_BYTES).toString("base64");
  }

  /**
   * @param {string} plaintext
   * @returns {{version:number, masterKeyId:string, wrappedKey:string, iv:string, tag:string, ciphertext:string, keyIv:string, keyTag:string}}
   */
  encrypt(plaintext) {
    if (typeof plaintext !== "string" || plaintext.length === 0) {
      throw new TypeError("Nothing to encrypt");
    }

    // A data key per record. Sharing one across records would mean a single
    // compromised key exposes every user's secrets at once.
    const dataKey = randomBytes(KEY_BYTES);
    const payload = seal(dataKey, Buffer.from(plaintext, "utf8"));
    const wrapped = seal(this.masterKey, dataKey);

    return {
      version: VERSION,
      masterKeyId: this.masterKeyId,
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      tag: payload.tag,
      wrappedKey: wrapped.ciphertext,
      keyIv: wrapped.iv,
      keyTag: wrapped.tag,
    };
  }

  /** @returns {string} the plaintext. Throws if the record was tampered with. */
  decrypt(record) {
    if (record?.version !== VERSION) {
      throw new Error(`Unsupported envelope version: ${record?.version}`);
    }
    const dataKey = open(this.masterKey, {
      ciphertext: record.wrappedKey,
      iv: record.keyIv,
      tag: record.keyTag,
    });
    return open(dataKey, record).toString("utf8");
  }

  /**
   * Re-wrap a record's data key under a new master key.
   *
   * The point of the whole design: the payload ciphertext is copied unchanged,
   * so rotating the master is proportional to the number of records rather than
   * to the volume of data, and it cannot corrupt a payload it never touches.
   */
  rewrap(record, nextCipher) {
    const dataKey = open(this.masterKey, {
      ciphertext: record.wrappedKey,
      iv: record.keyIv,
      tag: record.keyTag,
    });
    const wrapped = seal(nextCipher.masterKey, dataKey);
    return {
      ...record,
      masterKeyId: nextCipher.masterKeyId,
      wrappedKey: wrapped.ciphertext,
      keyIv: wrapped.iv,
      keyTag: wrapped.tag,
    };
  }

  /**
   * The only thing ever returned to a user about a stored key: enough to
   * recognise which key it is, never enough to use it. A user who lost their
   * key retrieves it from the provider, not from us
   * (docs/backend/10-security.md#rules-for-user-supplied-keys).
   */
  static mask(plaintext) {
    const value = String(plaintext ?? "");
    if (value.length <= 8) return "…";
    return `${value.slice(0, 3)}…${value.slice(-4)}`;
  }
}

function seal(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function open(key, { ciphertext, iv, tag }) {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  // `final()` throws when the tag does not match — that is the authentication,
  // and it must not be caught here and turned into an empty result.
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
}

function toKey(value) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "base64");
  if (key.length !== KEY_BYTES) {
    throw new TypeError(`An encryption master key must be ${KEY_BYTES} bytes (base64-encoded)`);
  }
  return key;
}

/** Constant-time comparison, for anywhere a secret is compared to input. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  // Length is not secret, and `timingSafeEqual` throws on a mismatch.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
