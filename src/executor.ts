// Executors turn an ALLOWED intent into a signed transaction.
//  - TestnetExecutor: real NEAR testnet via JSON-RPC.
//  - MockExecutor: offline; emulates the protocol's function-call-key rules so tests and
//    the offline demo still show the on-chain layer of defense.
import crypto from 'node:crypto';
import type { Intent } from './intent/types.ts';
import type { KeyStore } from './keystore.ts';
import { GAS_PER_TGAS, base58Encode, parseNear } from './near/encoding.ts';
import type { NearRpc, TxOutcome } from './near/rpc.ts';
import { assertTestnetAccount } from './near/rpc.ts';
import type { Action, AccessKeyPermission } from './near/transaction.ts';
import { signTransaction } from './near/transaction.ts';
import type { Route } from './policy/engine.ts';

export interface Executor {
  readonly name: string;
  execute(intent: Intent, route: Route): Promise<TxOutcome & { signerKey: string }>;
}

export function intentToActions(intent: Intent): { receiverId: string; actions: Action[] } {
  if (intent.kind === 'function_call') {
    return {
      receiverId: intent.receiverId,
      actions: [
        {
          type: 'FunctionCall',
          methodName: intent.methodName,
          args: new TextEncoder().encode(JSON.stringify(intent.args)),
          gas: BigInt(Math.floor(intent.gasTgas)) * GAS_PER_TGAS,
          deposit: parseNear(intent.depositNear),
        },
      ],
    };
  }
  if (intent.kind === 'transfer') {
    return { receiverId: intent.receiverId, actions: [{ type: 'Transfer', deposit: parseNear(intent.amountNear) }] };
  }
  throw new Error(`intent kind ${intent.kind} is not executable`);
}

/** Same rule the NEAR protocol applies to a function-call access key. */
export function fcKeyPermits(perm: AccessKeyPermission, receiverId: string, actions: Action[]): string | null {
  if (perm.type === 'FullAccess') return null;
  if (receiverId !== perm.receiverId) return `InvalidAccessKeyError: ReceiverMismatch (${receiverId} != ${perm.receiverId})`;
  if (actions.length !== 1 || actions[0].type !== 'FunctionCall')
    return 'InvalidAccessKeyError: RequiresFullAccess (only a single FunctionCall is allowed)';
  const a = actions[0];
  if (a.deposit !== 0n) return 'InvalidAccessKeyError: DepositWithFunctionCall';
  if (perm.methodNames.length && !perm.methodNames.includes(a.methodName))
    return `InvalidAccessKeyError: MethodNameMismatch (${a.methodName})`;
  return null;
}

export class TestnetExecutor implements Executor {
  readonly name = 'testnet';
  private readonly rpc: NearRpc;
  private readonly ks: KeyStore;

  constructor(rpc: NearRpc, ks: KeyStore) {
    this.rpc = rpc;
    this.ks = ks;
  }

  async execute(intent: Intent, route: Route) {
    const cfg = this.ks.readConfig();
    assertTestnetAccount(cfg.accountId);
    const { receiverId, actions } = intentToActions(intent);
    assertTestnetAccount(receiverId);
    await this.rpc.assertTestnet();

    const publicKey = route === 'agent_fc_key' ? cfg.agentKeys[receiverId] : cfg.ownerPublicKey;
    if (!publicKey) throw new Error(`no agent function-call key provisioned for ${receiverId}`);
    const key = this.ks.loadKey(publicKey);
    const ak = await this.rpc.viewAccessKey(cfg.accountId, publicKey);
    const blockHash = await this.rpc.latestBlockHash();
    const signed = signTransaction(
      { signerId: cfg.accountId, publicKey, nonce: ak.nonce + 1n, receiverId, blockHash, actions },
      key,
    );
    const out = await this.rpc.sendTransaction(signed.bytes);
    return { ...out, signerKey: route };
  }
}

export interface MockAccount {
  accountId: string;
  keys: Record<string, AccessKeyPermission>; // route -> permission
}

export class MockExecutor implements Executor {
  readonly name = 'mock';
  readonly sent: { receiverId: string; actions: Action[]; route: Route }[] = [];
  private readonly account: MockAccount;

  constructor(account: MockAccount) {
    this.account = account;
  }

  /** Build a mock account whose agent keys mirror the policy's contract allowlist. */
  static fromContracts(accountId: string, contracts: Record<string, { methods: string[] }>): MockExecutor {
    const keys: Record<string, AccessKeyPermission> = { owner_vault: { type: 'FullAccess' } };
    for (const [c, r] of Object.entries(contracts)) {
      keys[`agent_fc_key:${c}`] = { type: 'FunctionCall', allowance: parseNear('0.25'), receiverId: c, methodNames: [...r.methods] };
    }
    return new MockExecutor({ accountId, keys });
  }

  async execute(intent: Intent, route: Route) {
    const { receiverId, actions } = intentToActions(intent);
    const perm =
      route === 'owner_vault' ? this.account.keys.owner_vault : this.account.keys[`agent_fc_key:${receiverId}`];
    if (!perm) throw new Error(`no agent function-call key provisioned for ${receiverId}`);
    const err = fcKeyPermits(perm, receiverId, actions);
    if (err) throw new Error(err);
    this.sent.push({ receiverId, actions, route });
    const txHash = base58Encode(new Uint8Array(crypto.randomBytes(32)));
    return { txHash, success: true, logs: ['mock execution'], explorerUrl: `mock://tx/${txHash}`, signerKey: route };
  }
}
