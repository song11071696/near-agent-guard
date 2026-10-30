// Zero-dependency encoders used by the NEAR transaction layer:
// base58 (NEAR keys / hashes), Borsh writer, and NEAR amount helpers.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  let out = '';
  while (x > 0n) {
    out = ALPHABET[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

export function base58Decode(str: string): Uint8Array {
  let x = 0n;
  for (const ch of str) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid base58 character: ${ch}`);
    x = x * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (x > 0n) {
    bytes.unshift(Number(x & 0xffn));
    x >>= 8n;
  }
  for (const ch of str) {
    if (ch === '1') bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

/** Minimal Borsh serializer covering what NEAR transactions need. */
export class BorshWriter {
  private chunks: number[] = [];

  u8(v: number): this {
    this.chunks.push(v & 0xff);
    return this;
  }
  u32(v: number): this {
    for (let i = 0; i < 4; i++) this.chunks.push((v >>> (8 * i)) & 0xff);
    return this;
  }
  private uint(v: bigint, bytes: number): this {
    if (v < 0n) throw new Error('negative integer in borsh');
    if (v >= 1n << BigInt(bytes * 8)) throw new Error(`integer overflows u${bytes * 8}`);
    for (let i = 0; i < bytes; i++) {
      this.chunks.push(Number(v & 0xffn));
      v >>= 8n;
    }
    return this;
  }
  u64(v: bigint): this {
    return this.uint(v, 8);
  }
  u128(v: bigint): this {
    return this.uint(v, 16);
  }
  fixed(bytes: Uint8Array): this {
    for (const b of bytes) this.chunks.push(b);
    return this;
  }
  bytes(bytes: Uint8Array): this {
    this.u32(bytes.length);
    return this.fixed(bytes);
  }
  string(s: string): this {
    return this.bytes(new TextEncoder().encode(s));
  }
  vec<T>(items: T[], each: (w: BorshWriter, item: T) => void): this {
    this.u32(items.length);
    for (const it of items) each(this, it);
    return this;
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export const YOCTO_PER_NEAR = 10n ** 24n;
export const GAS_PER_TGAS = 10n ** 12n;

/** "0.25" NEAR -> yoctoNEAR bigint. Rejects negatives, >24 decimals and junk. */
export function parseNear(amount: string | number): bigint {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid NEAR amount: ${amount}`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 24) throw new Error(`too many decimals in NEAR amount: ${amount}`);
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, '0'));
}

/** yoctoNEAR bigint -> human string, trailing zeros trimmed. */
export function formatNear(yocto: bigint): string {
  const neg = yocto < 0n;
  const v = neg ? -yocto : yocto;
  const whole = v / YOCTO_PER_NEAR;
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}
