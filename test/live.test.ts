// Opt-in live checks against NEAR testnet (read-only + key scope). Run: NEAR_LIVE=1 npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NearRpc } from '../src/near/rpc.ts';

const live = process.env.NEAR_LIVE === '1';

test('testnet RPC reports chain_id testnet', { skip: !live && 'set NEAR_LIVE=1' }, async () => {
  const rpc = new NearRpc();
  await rpc.assertTestnet();
  assert.equal(typeof (await rpc.viewFunction('hello.near-examples.testnet', 'get_greeting')), 'string');
});

test('mainnet RPC is refused before any write', { skip: !live && 'set NEAR_LIVE=1' }, async () => {
  const rpc = new NearRpc('https://rpc.mainnet.near.org');
  await assert.rejects(() => rpc.assertTestnet(), /not testnet/);
});
