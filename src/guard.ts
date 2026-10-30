// Orchestrator: task -> planner -> intent -> policy -> (approval) -> executor -> audit.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AuditLog } from './audit/log.ts';
import type { Executor } from './executor.ts';
import type { Intent, PlannedIntent, Planner } from './intent/types.ts';
import type { Decision, Policy } from './policy/engine.ts';
import { evaluate } from './policy/engine.ts';
import { isoUtc } from './time.ts';

export interface PendingApproval {
  id: string;
  createdAt: string;
  task: string;
  planner: string;
  intent: Intent;
  decision: Decision;
}

export interface GuardResult {
  requestId: string;
  status: 'executed' | 'denied' | 'pending_approval' | 'failed' | 'rejected';
  planned?: PlannedIntent;
  decision?: Decision;
  txHash?: string;
  explorerUrl?: string;
  signerKey?: string;
  error?: string;
}

export interface GuardDeps {
  policy: Policy;
  planner: Planner;
  audit: AuditLog;
  executor: Executor;
  approvalsFile: string;
  dryRun?: boolean;
}

export class Guard {
  private readonly d: GuardDeps;

  constructor(deps: GuardDeps) {
    this.d = deps;
    fs.mkdirSync(path.dirname(deps.approvalsFile), { recursive: true });
  }

  get policy(): Policy {
    return this.d.policy;
  }

  pending(): PendingApproval[] {
    if (!fs.existsSync(this.d.approvalsFile)) return [];
    return JSON.parse(fs.readFileSync(this.d.approvalsFile, 'utf8')) as PendingApproval[];
  }

  private savePending(list: PendingApproval[]): void {
    fs.writeFileSync(this.d.approvalsFile, JSON.stringify(list, null, 2), { mode: 0o600 });
  }

  async handleTask(task: string): Promise<GuardResult> {
    const requestId = crypto.randomUUID();
    const planned = await this.d.planner.plan(task);
    return this.decideAndRun(requestId, planned, false);
  }

  private async decideAndRun(requestId: string, planned: PlannedIntent, approved: boolean): Promise<GuardResult> {
    const usage = this.d.audit.usage(this.d.policy.windowHours);
    const decision = evaluate(this.d.policy, planned.intent, { ...usage, approved });
    this.d.audit.append('decision', requestId, {
      task: planned.task,
      planner: planned.planner,
      intent: planned.intent,
      verdict: decision.verdict,
      reasons: decision.reasons,
      checks: decision.checks,
      valueNear: decision.valueNear,
      route: decision.route,
      approved,
    });

    if (decision.verdict === 'deny') return { requestId, status: 'denied', planned, decision };

    if (decision.verdict === 'needs_approval') {
      const p: PendingApproval = {
        id: requestId,
        createdAt: isoUtc(),
        task: planned.task,
        planner: planned.planner,
        intent: planned.intent,
        decision,
      };
      this.savePending([...this.pending().filter((x) => x.id !== requestId), p]);
      this.d.audit.append('approval_requested', requestId, { valueNear: decision.valueNear });
      return { requestId, status: 'pending_approval', planned, decision };
    }

    if (this.d.dryRun) return { requestId, status: 'executed', planned, decision, txHash: 'dry-run' };

    try {
      const out = await this.d.executor.execute(planned.intent, decision.route!);
      if (!out.success) {
        this.d.audit.append('execution_failed', requestId, {
          executor: this.d.executor.name,
          txHash: out.txHash,
          error: out.failure,
          valueNear: decision.valueNear,
        });
        return { requestId, status: 'failed', planned, decision, txHash: out.txHash, explorerUrl: out.explorerUrl, error: JSON.stringify(out.failure) };
      }
      this.d.audit.append('executed', requestId, {
        executor: this.d.executor.name,
        txHash: out.txHash,
        explorerUrl: out.explorerUrl,
        signerKey: out.signerKey,
        valueNear: decision.valueNear,
      });
      return { requestId, status: 'executed', planned, decision, txHash: out.txHash, explorerUrl: out.explorerUrl, signerKey: out.signerKey };
    } catch (e) {
      const error = (e as Error).message;
      this.d.audit.append('execution_failed', requestId, { executor: this.d.executor.name, error, valueNear: decision.valueNear });
      return { requestId, status: 'failed', planned, decision, error };
    }
  }

  /** Human approves a pending request; policy is re-evaluated against CURRENT usage. */
  async approve(id: string, approver = 'human'): Promise<GuardResult> {
    const p = this.pending().find((x) => x.id === id);
    if (!p) return { requestId: id, status: 'failed', error: 'no such pending approval' };
    this.savePending(this.pending().filter((x) => x.id !== id));
    this.d.audit.append('approval_granted', id, { approver });
    return this.decideAndRun(id, { task: p.task, planner: p.planner, intent: p.intent }, true);
  }

  reject(id: string, approver = 'human'): GuardResult {
    const p = this.pending().find((x) => x.id === id);
    if (!p) return { requestId: id, status: 'failed', error: 'no such pending approval' };
    this.savePending(this.pending().filter((x) => x.id !== id));
    this.d.audit.append('approval_rejected', id, { approver });
    return { requestId: id, status: 'rejected' };
  }
}
