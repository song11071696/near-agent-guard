// A transaction intent: what the agent WANTS to do, before any key touches it.
// Amounts are decimal NEAR strings so intents are JSON-safe and human-readable.

export type Intent =
  | {
      kind: 'function_call';
      receiverId: string;
      methodName: string;
      args: Record<string, unknown>;
      gasTgas: number;
      depositNear: string;
    }
  | { kind: 'transfer'; receiverId: string; amountNear: string }
  // Dangerous account-level actions. Planners may emit them (e.g. from a prompt-injected task);
  // the policy engine always denies them for agents.
  | { kind: 'add_key' | 'delete_key' | 'deploy_contract' | 'delete_account'; receiverId: string; detail?: string }
  | { kind: 'unknown'; reason: string };

export interface PlannedIntent {
  task: string;
  planner: string;
  intent: Intent;
}

export interface Planner {
  readonly name: string;
  plan(task: string): Promise<PlannedIntent>;
}

const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && ACCOUNT_RE.test(id);
}

/** Structural validation for intents coming from untrusted planners (LLMs). */
export function validateIntent(x: unknown): Intent {
  const o = x as Record<string, unknown>;
  if (!o || typeof o !== 'object') return { kind: 'unknown', reason: 'intent is not an object' };
  const bad = (reason: string): Intent => ({ kind: 'unknown', reason });
  switch (o.kind) {
    case 'function_call': {
      if (!isValidAccountId(o.receiverId)) return bad('invalid receiverId');
      if (typeof o.methodName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(o.methodName))
        return bad('invalid methodName');
      const args = o.args ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) return bad('args must be an object');
      const gas = o.gasTgas === undefined ? 30 : Number(o.gasTgas);
      if (!Number.isFinite(gas) || gas <= 0 || gas > 300) return bad('gasTgas out of range');
      const dep = String(o.depositNear ?? '0');
      if (!/^\d+(\.\d{1,24})?$/.test(dep)) return bad('invalid depositNear');
      return {
        kind: 'function_call',
        receiverId: o.receiverId,
        methodName: o.methodName,
        args: args as Record<string, unknown>,
        gasTgas: gas,
        depositNear: dep,
      };
    }
    case 'transfer': {
      if (!isValidAccountId(o.receiverId)) return bad('invalid receiverId');
      const amt = String(o.amountNear ?? '');
      if (!/^\d+(\.\d{1,24})?$/.test(amt)) return bad('invalid amountNear');
      return { kind: 'transfer', receiverId: o.receiverId, amountNear: amt };
    }
    case 'add_key':
    case 'delete_key':
    case 'deploy_contract':
    case 'delete_account':
      return { kind: o.kind, receiverId: String(o.receiverId ?? ''), detail: o.detail ? String(o.detail) : undefined };
    case 'unknown':
      return bad(String(o.reason ?? 'planner could not map task'));
    default:
      return bad(`unsupported intent kind: ${String(o.kind)}`);
  }
}
