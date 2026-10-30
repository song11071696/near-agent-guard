// Policy engine: pure function from (policy, intent, recent usage) -> decision.
// Runs BEFORE any key is loaded or any signature is produced.
import type { Intent } from '../intent/types.ts';
import { GAS_PER_TGAS, formatNear, parseNear } from '../near/encoding.ts';

export interface ContractRule {
  methods: string[];
  maxDepositNear?: string; // default "0": deposit-free calls only
}

export interface Policy {
  version: 1;
  network: 'testnet';
  limits: {
    maxPerTxNear: string; // hard cap per transaction (value = transfer amount or attached deposit)
    dailyLimitNear: string; // rolling-window cap on total value moved
    approvalThresholdNear: string; // value >= this needs a human approval
    maxTxPerDay: number; // rolling-window cap on executed transactions
    maxGasTgas: number;
    maxArgsBytes: number;
  };
  windowHours: number;
  contracts: Record<string, ContractRule>;
  transferAllowlist: string[];
}

export type Route = 'agent_fc_key' | 'owner_vault';
export type Verdict = 'allow' | 'deny' | 'needs_approval';

export interface Check {
  rule: string;
  ok: boolean;
  detail: string;
}

export interface Decision {
  verdict: Verdict;
  reasons: string[]; // codes of failed rules (or APPROVAL_REQUIRED)
  checks: Check[];
  valueNear: string;
  route: Route | null;
}

export interface UsageContext {
  spentYocto: bigint; // value already executed inside the window
  txCount: number; // txs already executed inside the window
  approved?: boolean; // a human approved this exact request
}

const FORBIDDEN = new Set(['add_key', 'delete_key', 'deploy_contract', 'delete_account']);

export function intentValueYocto(intent: Intent): bigint {
  if (intent.kind === 'transfer') return parseNear(intent.amountNear);
  if (intent.kind === 'function_call') return parseNear(intent.depositNear);
  return 0n;
}

export function validatePolicy(p: Policy): Policy {
  if (p.version !== 1) throw new Error('unsupported policy version');
  if (p.network !== 'testnet') throw new Error('policy.network must be "testnet" — mainnet is not supported');
  for (const k of ['maxPerTxNear', 'dailyLimitNear', 'approvalThresholdNear'] as const) parseNear(p.limits[k]);
  for (const c of Object.keys(p.contracts)) if (!c.endsWith('.testnet')) throw new Error(`non-testnet contract: ${c}`);
  for (const a of p.transferAllowlist) if (!a.endsWith('.testnet')) throw new Error(`non-testnet recipient: ${a}`);
  return p;
}

export function evaluate(policy: Policy, intent: Intent, usage: UsageContext): Decision {
  const checks: Check[] = [];
  const add = (rule: string, ok: boolean, detail: string) => checks.push({ rule, ok, detail });
  const deny = (): Decision => ({
    verdict: 'deny',
    reasons: checks.filter((c) => !c.ok).map((c) => c.rule),
    checks,
    valueNear: '0',
    route: null,
  });

  if (intent.kind === 'unknown') {
    add('UNPARSEABLE_TASK', false, intent.reason);
    return deny();
  }
  if (FORBIDDEN.has(intent.kind)) {
    add('FORBIDDEN_ACTION', false, `agents may never ${intent.kind.replace('_', ' ')}`);
    return deny();
  }
  if (intent.kind !== 'function_call' && intent.kind !== 'transfer') return deny();

  add('TESTNET_ONLY', intent.receiverId.endsWith('.testnet'), `receiver ${intent.receiverId}`);

  const value = intentValueYocto(intent);
  const L = policy.limits;

  if (intent.kind === 'function_call') {
    const rule = policy.contracts[intent.receiverId];
    add('CONTRACT_ALLOWLIST', !!rule, rule ? `${intent.receiverId} is allowlisted` : `${intent.receiverId} not in allowlist`);
    if (rule) {
      add(
        'METHOD_ALLOWLIST',
        rule.methods.includes(intent.methodName),
        `${intent.methodName} ${rule.methods.includes(intent.methodName) ? 'in' : 'not in'} [${rule.methods.join(', ')}]`,
      );
      const maxDep = parseNear(rule.maxDepositNear ?? '0');
      add('DEPOSIT_LIMIT', value <= maxDep, `deposit ${formatNear(value)} <= ${formatNear(maxDep)} NEAR`);
    }
    add('GAS_LIMIT', intent.gasTgas <= L.maxGasTgas, `${intent.gasTgas} <= ${L.maxGasTgas} TGas`);
    const argBytes = Buffer.byteLength(JSON.stringify(intent.args));
    add('ARGS_SIZE', argBytes <= L.maxArgsBytes, `${argBytes} <= ${L.maxArgsBytes} bytes`);
  } else {
    const ok = policy.transferAllowlist.includes(intent.receiverId);
    add('RECIPIENT_ALLOWLIST', ok, `${intent.receiverId} ${ok ? 'in' : 'not in'} transfer allowlist`);
    add('NONZERO_AMOUNT', value > 0n, `amount ${formatNear(value)} NEAR`);
  }

  const perTx = parseNear(L.maxPerTxNear);
  add('PER_TX_LIMIT', value <= perTx, `${formatNear(value)} <= ${L.maxPerTxNear} NEAR`);
  const daily = parseNear(L.dailyLimitNear);
  add(
    'DAILY_LIMIT',
    usage.spentYocto + value <= daily,
    `${formatNear(usage.spentYocto)} spent + ${formatNear(value)} <= ${L.dailyLimitNear} NEAR / ${policy.windowHours}h`,
  );
  add('RATE_LIMIT', usage.txCount < L.maxTxPerDay, `${usage.txCount} < ${L.maxTxPerDay} tx / ${policy.windowHours}h`);

  if (checks.some((c) => !c.ok)) return deny();

  const route: Route = intent.kind === 'function_call' && value === 0n ? 'agent_fc_key' : 'owner_vault';
  const threshold = parseNear(L.approvalThresholdNear);
  if (value > 0n && value >= threshold && !usage.approved) {
    checks.push({ rule: 'APPROVAL_REQUIRED', ok: false, detail: `${formatNear(value)} >= ${L.approvalThresholdNear} NEAR` });
    return { verdict: 'needs_approval', reasons: ['APPROVAL_REQUIRED'], checks, valueNear: formatNear(value), route };
  }
  return { verdict: 'allow', reasons: [], checks, valueNear: formatNear(value), route };
}

export { GAS_PER_TGAS };
