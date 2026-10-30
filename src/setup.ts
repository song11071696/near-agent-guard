// Testnet provisioning (free): create the guarded account through NEAR's public testnet
// helper, then give the agent one function-call access key per allowlisted contract.
import { KeyStore } from './keystore.ts';
import type { GuardConfig } from './keystore.ts';
import { KeyPair } from './near/keys.ts';
import { formatNear, parseNear } from './near/encoding.ts';
import { NearRpc, assertTestnetAccount } from './near/rpc.ts';
import type { Action } from './near/transaction.ts';
import { signTransaction } from './near/transaction.ts';
import type { Policy } from './policy/engine.ts';

export const TESTNET_HELPER = process.env.NEAR_HELPER_URL || 'https://helper.testnet.near.org';

export async function createTestnetAccount(accountId: string, publicKey: string): Promise<void> {
  assertTestnetAccount(accountId);
  const res = await fetch(`${TESTNET_HELPER}/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  if (!res.ok || !text.includes('SuccessValue')) {
    throw new Error(`testnet helper refused to create ${accountId}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
}

async function sendAsOwner(rpc: NearRpc, ks: KeyStore, cfg: GuardConfig, receiverId: string, actions: Action[]) {
  const owner = ks.loadKey(cfg.ownerPublicKey);
  const ak = await rpc.viewAccessKey(cfg.accountId, owner.publicKey);
  const blockHash = await rpc.latestBlockHash();
  const signed = signTransaction(
    { signerId: cfg.accountId, publicKey: owner.publicKey, nonce: ak.nonce + 1n, receiverId, blockHash, actions },
    owner,
  );
  return rpc.sendTransaction(signed.bytes);
}

export interface SetupOptions {
  accountId?: string;
  allowanceNear?: string;
  log?: (s: string) => void;
}

export async function setup(ks: KeyStore, policyFor: (accountId: string) => Policy, opts: SetupOptions = {}) {
  const log = opts.log ?? console.log;
  const rpc = new NearRpc();
  await rpc.assertTestnet();
  log(`✓ RPC ${rpc.url} reports chain_id=testnet`);

  let cfg: GuardConfig;
  if (ks.hasConfig()) {
    cfg = ks.readConfig();
    log(`✓ reusing account ${cfg.accountId}`);
  } else {
    const accountId = opts.accountId ?? `agent-guard-${Date.now().toString(36)}.testnet`;
    const owner = KeyPair.random();
    ks.saveKey(owner);
    log(`… creating ${accountId} via ${TESTNET_HELPER} (free testnet faucet)`);
    await createTestnetAccount(accountId, owner.publicKey);
    cfg = { accountId, ownerPublicKey: owner.publicKey, agentKeys: {} };
    ks.writeConfig(cfg);
    log(`✓ created ${accountId}; owner full-access key stays in the local vault only`);
  }

  const policy = policyFor(cfg.accountId);
  const allowance = parseNear(opts.allowanceNear ?? '0.25');

  // One function-call key per allowlisted contract (a NEAR FC key is bound to one receiver).
  const addKeys: Action[] = [];
  const newAgentKeys: Record<string, string> = {};
  for (const [contract, rule] of Object.entries(policy.contracts)) {
    if (cfg.agentKeys[contract]) continue;
    const k = KeyPair.random();
    ks.saveKey(k);
    newAgentKeys[contract] = k.publicKey;
    addKeys.push({
      type: 'AddKey',
      publicKey: k.publicKey,
      nonce: 0n,
      permission: { type: 'FunctionCall', allowance, receiverId: contract, methodNames: rule.methods },
    });
  }
  if (addKeys.length) {
    const out = await sendAsOwner(rpc, ks, cfg, cfg.accountId, addKeys);
    if (!out.success) throw new Error(`AddKey failed: ${JSON.stringify(out.failure)}`);
    cfg.agentKeys = { ...cfg.agentKeys, ...newAgentKeys };
    ks.writeConfig(cfg);
    log(`✓ added ${addKeys.length} function-call key(s), allowance ${formatNear(allowance)} NEAR each: ${out.explorerUrl}`);
  } else {
    log('✓ agent function-call keys already provisioned');
  }

  // Demo transfer recipient: a sub-account we own (bob.<account>), so test funds are never lost.
  for (const recipient of policy.transferAllowlist) {
    if (!recipient.endsWith('.' + cfg.accountId)) continue;
    try {
      await rpc.viewAccount(recipient);
      log(`✓ transfer recipient ${recipient} exists`);
    } catch {
      const out = await sendAsOwner(rpc, ks, cfg, recipient, [
        { type: 'CreateAccount' },
        { type: 'Transfer', deposit: parseNear('0.05') },
        { type: 'AddKey', publicKey: cfg.ownerPublicKey, nonce: 0n, permission: { type: 'FullAccess' } },
      ]);
      if (!out.success) throw new Error(`creating ${recipient} failed: ${JSON.stringify(out.failure)}`);
      log(`✓ created demo recipient ${recipient}: ${out.explorerUrl}`);
    }
  }
  return cfg;
}

/** Proves the on-chain layer: sign a Transfer with the agent's FC key, bypassing the policy engine. */
export async function bypassAttack(ks: KeyStore, to: string, amountNear = '0.01') {
  const rpc = new NearRpc();
  await rpc.assertTestnet();
  const cfg = ks.readConfig();
  const [contract, pub] = Object.entries(cfg.agentKeys)[0] ?? [];
  if (!pub) throw new Error('no agent key provisioned; run setup first');
  assertTestnetAccount(to);
  const key = ks.loadKey(pub);
  const ak = await rpc.viewAccessKey(cfg.accountId, pub);
  const blockHash = await rpc.latestBlockHash();
  const signed = signTransaction(
    {
      signerId: cfg.accountId,
      publicKey: pub,
      nonce: ak.nonce + 1n,
      receiverId: to,
      blockHash,
      actions: [{ type: 'Transfer', deposit: parseNear(amountNear) }],
    },
    key,
  );
  try {
    const out = await rpc.sendTransaction(signed.bytes);
    return { rejected: !out.success, contract, detail: out.success ? 'UNEXPECTED: chain accepted' : JSON.stringify(out.failure) };
  } catch (e) {
    return { rejected: true, contract, detail: (e as Error).message };
  }
}
