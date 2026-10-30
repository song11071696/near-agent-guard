import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { base58Encode, parseNear } from '../src/near/encoding.ts';
import { KeyPair, verifySignature } from '../src/near/keys.ts';
import { serializeTransaction, signTransaction } from '../src/near/transaction.ts';
import type { Transaction } from '../src/near/transaction.ts';

const kp = KeyPair.fromSeed(new Uint8Array(32).fill(1));
const blockHash = base58Encode(new Uint8Array(32).fill(9));

function str(s: string) {
  const b = Buffer.from(s);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}
function u64(v: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
function u128(v: bigint) {
  return Buffer.concat([u64(v & (2n ** 64n - 1n)), u64(v >> 64n)]);
}

test('Transfer transaction matches the NEAR borsh layout byte for byte', () => {
  const tx: Transaction = {
    signerId: 'a.testnet',
    publicKey: kp.publicKey,
    nonce: 5n,
    receiverId: 'b.testnet',
    blockHash,
    actions: [{ type: 'Transfer', deposit: parseNear('1') }],
  };
  const expected = Buffer.concat([
    str('a.testnet'),
    Buffer.from([0]),
    Buffer.from(kp.publicKeyBytes),
    u64(5n),
    str('b.testnet'),
    Buffer.alloc(32, 9),
    Buffer.from([1, 0, 0, 0]),
    Buffer.from([3]),
    u128(10n ** 24n),
  ]);
  assert.equal(Buffer.from(serializeTransaction(tx)).toString('hex'), expected.toString('hex'));
});

test('FunctionCall + AddKey(FunctionCall permission) layout', () => {
  const agent = KeyPair.fromSeed(new Uint8Array(32).fill(2));
  const tx: Transaction = {
    signerId: 'a.testnet',
    publicKey: kp.publicKey,
    nonce: 1n,
    receiverId: 'a.testnet',
    blockHash,
    actions: [
      { type: 'FunctionCall', methodName: 'm', args: Buffer.from('{}'), gas: 30n * 10n ** 12n, deposit: 0n },
      { type: 'AddKey', publicKey: agent.publicKey, nonce: 0n, permission: { type: 'FunctionCall', allowance: 7n, receiverId: 'c.testnet', methodNames: ['x', 'y'] } },
    ],
  };
  const tail = Buffer.concat([
    Buffer.from([2, 0, 0, 0]),
    Buffer.from([2]), str('m'), str('{}'), u64(30n * 10n ** 12n), u128(0n),
    Buffer.from([5, 0]), Buffer.from(agent.publicKeyBytes), u64(0n),
    Buffer.from([0, 1]), u128(7n), str('c.testnet'), Buffer.from([2, 0, 0, 0]), str('x'), str('y'),
  ]);
  const hex = Buffer.from(serializeTransaction(tx)).toString('hex');
  assert.ok(hex.endsWith(tail.toString('hex')));
});

test('signature is ed25519 over sha256(tx) and hash is base58(sha256)', () => {
  const tx: Transaction = { signerId: 'a.testnet', publicKey: kp.publicKey, nonce: 1n, receiverId: 'b.testnet', blockHash, actions: [{ type: 'Transfer', deposit: 1n }] };
  const body = serializeTransaction(tx);
  const digest = new Uint8Array(crypto.createHash('sha256').update(body).digest());
  const s = signTransaction(tx, kp);
  assert.equal(s.hash, base58Encode(digest));
  assert.ok(verifySignature(kp.publicKey, digest, s.signature));
  assert.equal(s.bytes.length, body.length + 1 + 64);
  assert.throws(() => signTransaction(tx, KeyPair.random()), /does not match/);
});
