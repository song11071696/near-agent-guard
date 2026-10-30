import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BorshWriter, base58Decode, base58Encode, formatNear, parseNear } from '../src/near/encoding.ts';

test('base58 known vector and round trip with leading zeros', () => {
  assert.equal(base58Encode(new TextEncoder().encode('hello world')), 'StV1DL6CwTryKyV');
  const b = Uint8Array.from([0, 0, 1, 2, 255]);
  assert.deepEqual(base58Decode(base58Encode(b)), b);
  assert.equal(base58Encode(new Uint8Array(32)), '1'.repeat(32));
  assert.throws(() => base58Decode('0OIl'));
});

test('borsh primitives are little-endian with u32 length prefixes', () => {
  const w = new BorshWriter().u8(7).u32(0x01020304).u64(1n).u128(2n ** 64n).string('ab');
  assert.equal(
    Buffer.from(w.toBytes()).toString('hex'),
    '07' + '04030201' + '0100000000000000' + '0000000000000000' + '0100000000000000' + '02000000' + '6162',
  );
  assert.throws(() => new BorshWriter().u64(2n ** 64n));
  assert.throws(() => new BorshWriter().u128(-1n));
});

test('NEAR amounts parse and format exactly', () => {
  assert.equal(parseNear('1'), 10n ** 24n);
  assert.equal(parseNear('0.25'), 25n * 10n ** 22n);
  assert.equal(parseNear('0.000000000000000000000001'), 1n);
  assert.equal(formatNear(parseNear('12.5')), '12.5');
  assert.equal(formatNear(0n), '0');
  for (const bad of ['-1', '1e3', 'abc', '0.0000000000000000000000001', '']) assert.throws(() => parseNear(bad), bad);
});
