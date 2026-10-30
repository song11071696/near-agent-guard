import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyPair, verifySignature } from '../src/near/keys.ts';

test('RFC 8032 ed25519 test vector 1', () => {
  const kp = KeyPair.fromSeed(new Uint8Array(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')));
  assert.equal(Buffer.from(kp.publicKeyBytes).toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  assert.equal(
    Buffer.from(kp.sign(new Uint8Array())).toString('hex'),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  );
});

test('NEAR secret key string round trip, sign and verify', () => {
  const kp = KeyPair.random();
  assert.match(kp.publicKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const again = KeyPair.fromString(kp.secretKey);
  assert.equal(again.publicKey, kp.publicKey);
  const msg = new TextEncoder().encode('guard');
  const sig = kp.sign(msg);
  assert.ok(verifySignature(kp.publicKey, msg, sig));
  assert.ok(!verifySignature(KeyPair.random().publicKey, msg, sig));
});

test('rejects secret keys whose public half does not match', () => {
  const a = KeyPair.random();
  const b = KeyPair.random();
  const forged = a.secretKey.slice(0, 20) + b.secretKey.slice(20);
  assert.throws(() => KeyPair.fromString(forged));
});
