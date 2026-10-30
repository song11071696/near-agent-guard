// ed25519 key pairs in NEAR's "ed25519:<base58>" format, using node:crypto only.
import crypto from 'node:crypto';
import { base58Decode, base58Encode } from './encoding.ts';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class KeyPair {
  readonly seed: Uint8Array; // 32-byte private seed
  readonly publicKeyBytes: Uint8Array; // 32-byte public key
  private readonly keyObject: crypto.KeyObject;

  private constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
    this.seed = seed;
    this.keyObject = crypto.createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
      format: 'der',
      type: 'pkcs8',
    });
    const jwk = crypto.createPublicKey(this.keyObject).export({ format: 'jwk' });
    this.publicKeyBytes = new Uint8Array(Buffer.from(jwk.x as string, 'base64url'));
  }

  static random(): KeyPair {
    return new KeyPair(new Uint8Array(crypto.randomBytes(32)));
  }

  static fromSeed(seed: Uint8Array): KeyPair {
    return new KeyPair(seed);
  }

  /** Accepts NEAR secret key "ed25519:<base58(seed||pub)>" (64 bytes) or a 32-byte seed. */
  static fromString(secret: string): KeyPair {
    const body = secret.startsWith('ed25519:') ? secret.slice(8) : secret;
    const raw = base58Decode(body);
    if (raw.length !== 64 && raw.length !== 32) throw new Error('unexpected secret key length');
    const kp = new KeyPair(raw.slice(0, 32));
    if (raw.length === 64 && Buffer.compare(Buffer.from(raw.slice(32)), Buffer.from(kp.publicKeyBytes)) !== 0) {
      throw new Error('secret key public half does not match seed');
    }
    return kp;
  }

  get publicKey(): string {
    return 'ed25519:' + base58Encode(this.publicKeyBytes);
  }

  get secretKey(): string {
    return 'ed25519:' + base58Encode(new Uint8Array([...this.seed, ...this.publicKeyBytes]));
  }

  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(crypto.sign(null, Buffer.from(message), this.keyObject));
  }
}

export function verifySignature(publicKey: string, message: Uint8Array, signature: Uint8Array): boolean {
  const raw = base58Decode(publicKey.replace(/^ed25519:/, ''));
  const key = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
  return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
}

export function publicKeyBytes(publicKey: string): Uint8Array {
  if (!publicKey.startsWith('ed25519:')) throw new Error('only ed25519 keys are supported');
  const raw = base58Decode(publicKey.slice(8));
  if (raw.length !== 32) throw new Error('bad ed25519 public key length');
  return raw;
}
