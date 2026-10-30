import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Intent } from '../src/intent/types.ts';
import { evaluate, validatePolicy } from '../src/policy/engine.ts';
import { ACCOUNT, testPolicy } from './helpers.ts';

const fresh = { spentYocto: 0n, txCount: 0 };
const NEAR = 10n ** 24n;
const fc = (over: Partial<Extract<Intent, { kind: 'function_call' }>> = {}): Intent => ({
  kind: 'function_call', receiverId: 'hello.near-examples.testnet', methodName: 'set_greeting', args: { greeting: 'hi' }, gasTgas: 30, depositNear: '0', ...over,
});
const tr = (amountNear: string, receiverId = `bob.${ACCOUNT}`): Intent => ({ kind: 'transfer', receiverId, amountNear });

test('allowlisted deposit-free call is allowed and routed to the agent FC key', () => {
  const d = evaluate(testPolicy(), fc(), fresh);
  assert.equal(d.verdict, 'allow');
  assert.equal(d.route, 'agent_fc_key');
});

test('contract / method / gas / args / deposit rules', () => {
  const P = testPolicy();
  assert.deepEqual(evaluate(P, fc({ receiverId: 'evil.testnet' }), fresh).reasons, ['CONTRACT_ALLOWLIST']);
  assert.deepEqual(evaluate(P, fc({ methodName: 'delete_everything' }), fresh).reasons, ['METHOD_ALLOWLIST']);
  assert.deepEqual(evaluate(P, fc({ gasTgas: 200 }), fresh).reasons, ['GAS_LIMIT']);
  assert.deepEqual(evaluate(P, fc({ args: { greeting: 'x'.repeat(2000) } }), fresh).reasons, ['ARGS_SIZE']);
  assert.deepEqual(evaluate(P, fc({ depositNear: '0.1' }), fresh).reasons, ['DEPOSIT_LIMIT']);
  assert.ok(evaluate(P, fc({ receiverId: 'hello.near' }), fresh).reasons.includes('TESTNET_ONLY'));
});

test('transfers: allowlist, per-tx cap, approval threshold, routing to owner vault', () => {
  const P = testPolicy();
  assert.equal(evaluate(P, tr('0.1'), fresh).verdict, 'allow');
  assert.equal(evaluate(P, tr('0.1'), fresh).route, 'owner_vault');
  assert.deepEqual(evaluate(P, tr('0.1', 'stranger.testnet'), fresh).reasons, ['RECIPIENT_ALLOWLIST']);
  assert.deepEqual(evaluate(P, tr('0.6'), fresh).reasons, ['PER_TX_LIMIT']);
  assert.deepEqual(evaluate(P, tr('0'), fresh).reasons, ['NONZERO_AMOUNT']);
  const big = evaluate(P, tr('0.3'), fresh);
  assert.equal(big.verdict, 'needs_approval');
  assert.equal(evaluate(P, tr('0.2'), fresh).verdict, 'needs_approval', 'threshold is inclusive');
  assert.equal(evaluate(P, tr('0.3'), { ...fresh, approved: true }).verdict, 'allow');
});

test('approval never overrides a hard limit', () => {
  const d = evaluate(testPolicy(), tr('5'), { ...fresh, approved: true });
  assert.equal(d.verdict, 'deny');
});

test('rolling daily value cap and tx-count rate limit', () => {
  const P = testPolicy();
  assert.deepEqual(evaluate(P, tr('0.15'), { spentYocto: (9n * NEAR) / 10n, txCount: 3 }).reasons, ['DAILY_LIMIT']);
  assert.equal(evaluate(P, tr('0.1'), { spentYocto: (9n * NEAR) / 10n, txCount: 3 }).verdict, 'allow', 'exactly at cap is ok');
  assert.deepEqual(evaluate(P, fc(), { spentYocto: 0n, txCount: 20 }).reasons, ['RATE_LIMIT']);
});

test('forbidden and unparseable intents are always denied', () => {
  for (const kind of ['add_key', 'delete_key', 'deploy_contract', 'delete_account'] as const) {
    const d = evaluate(testPolicy(), { kind, receiverId: 'self' }, fresh);
    assert.equal(d.verdict, 'deny');
    assert.deepEqual(d.reasons, ['FORBIDDEN_ACTION']);
  }
  assert.deepEqual(evaluate(testPolicy(), { kind: 'unknown', reason: 'x' }, fresh).reasons, ['UNPARSEABLE_TASK']);
});

test('policy validation refuses mainnet', () => {
  assert.throws(() => validatePolicy({ ...testPolicy(), network: 'mainnet' as 'testnet' }), /mainnet/);
  assert.throws(() => validatePolicy({ ...testPolicy(), contracts: { 'wrap.near': { methods: ['x'] } } }));
  assert.throws(() => validatePolicy({ ...testPolicy(), transferAllowlist: ['alice.near'] }));
  assert.ok(validatePolicy(testPolicy()));
});
