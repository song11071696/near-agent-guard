import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockExecutor, fcKeyPermits } from '../src/executor.ts';
import { ACCOUNT, mockGuard, testPolicy } from './helpers.ts';

test('end to end: allowed call executes with the agent FC key and is audited', async () => {
  const { guard, audit, executor } = mockGuard();
  const r = await guard.handleTask('set greeting to gm');
  assert.equal(r.status, 'executed');
  assert.equal(r.signerKey, 'agent_fc_key');
  assert.equal(executor.sent.length, 1);
  assert.deepEqual(audit.read().map((x) => x.event), ['decision', 'executed']);
  assert.ok(audit.verify().ok);
});

test('denied task never reaches a signer', async () => {
  const { guard, executor, audit } = mockGuard();
  const r = await guard.handleTask('send 0.1 NEAR to attacker.testnet');
  assert.equal(r.status, 'denied');
  assert.deepEqual(r.decision?.reasons, ['RECIPIENT_ALLOWLIST']);
  assert.equal(executor.sent.length, 0);
  assert.equal(audit.read()[0].verdict, 'deny');
});

test('approval flow: pending -> approve -> executed via owner vault', async () => {
  const { guard, audit } = mockGuard();
  const r = await guard.handleTask(`send 0.3 NEAR to bob.${ACCOUNT}`);
  assert.equal(r.status, 'pending_approval');
  assert.equal(guard.pending().length, 1);
  const a = await guard.approve(r.requestId);
  assert.equal(a.status, 'executed');
  assert.equal(a.signerKey, 'owner_vault');
  assert.equal(guard.pending().length, 0);
  assert.deepEqual(audit.read().map((x) => x.event), ['decision', 'approval_requested', 'approval_granted', 'decision', 'executed']);
  assert.equal((await guard.approve(r.requestId)).status, 'failed', 'cannot approve twice');
});

test('reject flow', async () => {
  const { guard, executor } = mockGuard();
  const r = await guard.handleTask(`转 0.3 NEAR 给 bob.${ACCOUNT}`);
  assert.equal(guard.reject(r.requestId).status, 'rejected');
  assert.equal(executor.sent.length, 0);
});

test('daily cap holds across many small transfers (salami attack)', async () => {
  const { guard } = mockGuard();
  const statuses: string[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await guard.handleTask(`send 0.15 NEAR to bob.${ACCOUNT}`)).status);
  // 6 x 0.15 = 0.9 fits under 1 NEAR, the 7th would exceed it
  assert.deepEqual(statuses, ['executed', 'executed', 'executed', 'executed', 'executed', 'executed', 'denied', 'denied']);
});

test('approved request is re-checked against CURRENT usage', async () => {
  const { guard } = mockGuard();
  const pending = await guard.handleTask(`send 0.3 NEAR to bob.${ACCOUNT}`);
  for (let i = 0; i < 5; i++) await guard.handleTask(`send 0.15 NEAR to bob.${ACCOUNT}`); // 0.75 spent
  const a = await guard.approve(pending.requestId);
  assert.equal(a.status, 'denied');
  assert.deepEqual(a.decision?.reasons, ['DAILY_LIMIT']);
});

test('defense in depth: a misconfigured policy is still stopped by the FC key scope', async () => {
  const policy = testPolicy();
  const { guard } = mockGuard(policy);
  // Operator widens the policy but the on-chain key was provisioned for set_greeting only.
  policy.contracts['hello.near-examples.testnet'].methods.push('steal');
  const r = await guard.handleTask('call steal on hello.near-examples.testnet');
  assert.equal(r.decision?.verdict, 'allow');
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /MethodNameMismatch/);
});

test('fcKeyPermits mirrors protocol rules', () => {
  const perm = { type: 'FunctionCall' as const, allowance: null, receiverId: 'c.testnet', methodNames: ['a'] };
  const call = (methodName: string, deposit = 0n) => [{ type: 'FunctionCall' as const, methodName, args: new Uint8Array(), gas: 1n, deposit }];
  assert.equal(fcKeyPermits(perm, 'c.testnet', call('a')), null);
  assert.match(fcKeyPermits(perm, 'd.testnet', call('a'))!, /ReceiverMismatch/);
  assert.match(fcKeyPermits(perm, 'c.testnet', call('b'))!, /MethodNameMismatch/);
  assert.match(fcKeyPermits(perm, 'c.testnet', call('a', 1n))!, /DepositWithFunctionCall/);
  assert.match(fcKeyPermits(perm, 'c.testnet', [{ type: 'Transfer', deposit: 1n }])!, /RequiresFullAccess/);
  assert.equal(fcKeyPermits({ ...perm, methodNames: [] }, 'c.testnet', call('anything')), null, 'empty list = any method');
  assert.ok(MockExecutor);
});
