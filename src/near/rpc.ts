// Tiny NEAR JSON-RPC client. Hard-refuses anything that is not testnet.
import { base58Decode } from './encoding.ts';
import type { AccessKeyPermission } from './transaction.ts';

export const TESTNET_RPC = 'https://rpc.testnet.near.org';

export class TestnetOnlyError extends Error {}

export function assertTestnetAccount(accountId: string): void {
  if (!/^[a-z0-9._-]+\.testnet$/.test(accountId) && accountId !== 'testnet') {
    throw new TestnetOnlyError(`refusing non-testnet account id: ${accountId}`);
  }
}

export interface AccessKeyView {
  nonce: bigint;
  permission: AccessKeyPermission;
}

function parsePermission(p: unknown): AccessKeyPermission {
  if (p === 'FullAccess') return { type: 'FullAccess' };
  const fc = (p as { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } })
    .FunctionCall;
  return {
    type: 'FunctionCall',
    allowance: fc.allowance === null ? null : BigInt(fc.allowance),
    receiverId: fc.receiver_id,
    methodNames: fc.method_names,
  };
}

export class NearRpc {
  readonly url: string;
  private verified = false;
  private id = 0;

  constructor(url: string = process.env.NEAR_RPC_URL || TESTNET_RPC) {
    this.url = url;
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json()) as { result?: T; error?: unknown };
    if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
    if (json.result && typeof json.result === 'object' && 'error' in (json.result as object)) {
      throw new Error(`RPC ${method} error: ${JSON.stringify((json.result as unknown as { error: unknown }).error)}`);
    }
    return json.result as T;
  }

  /** Called before any write: the RPC must report chain_id "testnet". */
  async assertTestnet(): Promise<void> {
    if (this.verified) return;
    const status = await this.call<{ chain_id: string }>('status', []);
    if (status.chain_id !== 'testnet') {
      throw new TestnetOnlyError(`RPC ${this.url} is chain "${status.chain_id}", not testnet. Refusing.`);
    }
    this.verified = true;
  }

  async viewAccount(accountId: string): Promise<{ amount: bigint; storageUsage: number }> {
    const r = await this.call<{ amount: string; storage_usage: number }>('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return { amount: BigInt(r.amount), storageUsage: r.storage_usage };
  }

  async viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyView> {
    const r = await this.call<{ nonce: number | string; permission: unknown }>('query', {
      request_type: 'view_access_key',
      finality: 'optimistic',
      account_id: accountId,
      public_key: publicKey,
    });
    return { nonce: BigInt(r.nonce), permission: parsePermission(r.permission) };
  }

  async viewAccessKeyList(accountId: string): Promise<{ publicKey: string; permission: AccessKeyPermission }[]> {
    const r = await this.call<{ keys: { public_key: string; access_key: { permission: unknown } }[] }>('query', {
      request_type: 'view_access_key_list',
      finality: 'final',
      account_id: accountId,
    });
    return r.keys.map((k) => ({ publicKey: k.public_key, permission: parsePermission(k.access_key.permission) }));
  }

  async viewFunction(contractId: string, method: string, args: object = {}): Promise<unknown> {
    const r = await this.call<{ result: number[] }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    const text = Buffer.from(r.result).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async latestBlockHash(): Promise<string> {
    const r = await this.call<{ header: { hash: string } }>('block', { finality: 'final' });
    if (base58Decode(r.header.hash).length !== 32) throw new Error('bad block hash');
    return r.header.hash;
  }

  async sendTransaction(signedBytes: Uint8Array): Promise<TxOutcome> {
    await this.assertTestnet();
    const r = await this.call<RawOutcome>('send_tx', {
      signed_tx_base64: Buffer.from(signedBytes).toString('base64'),
      wait_until: 'EXECUTED_OPTIMISTIC',
    });
    return summarizeOutcome(r);
  }
}

interface RawOutcome {
  status: Record<string, unknown>;
  transaction: { hash: string };
  transaction_outcome: { outcome: { status: Record<string, unknown> } };
  receipts_outcome: { outcome: { status: Record<string, unknown>; logs: string[] } }[];
}

export interface TxOutcome {
  txHash: string;
  success: boolean;
  failure?: unknown;
  logs: string[];
  explorerUrl: string;
}

export function summarizeOutcome(r: RawOutcome): TxOutcome {
  const failure =
    'Failure' in r.status
      ? r.status.Failure
      : r.receipts_outcome.map((x) => x.outcome.status).find((s) => 'Failure' in s)?.Failure;
  return {
    txHash: r.transaction.hash,
    success: failure === undefined,
    failure,
    logs: r.receipts_outcome.flatMap((x) => x.outcome.logs),
    explorerUrl: `https://testnet.nearblocks.io/txns/${r.transaction.hash}`,
  };
}
