import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../src/audit/log.ts';
import { MockExecutor } from '../src/executor.ts';
import { Guard } from '../src/guard.ts';
import { RuleBasedPlanner } from '../src/intent/rule-planner.ts';
import type { Policy } from '../src/policy/engine.ts';

export const ACCOUNT = 'agent.testnet';

export function testPolicy(over: Partial<Policy['limits']> = {}): Policy {
  return {
    version: 1,
    network: 'testnet',
    limits: {
      maxPerTxNear: '0.5',
      dailyLimitNear: '1',
      approvalThresholdNear: '0.2',
      maxTxPerDay: 20,
      maxGasTgas: 50,
      maxArgsBytes: 1024,
      ...over,
    },
    windowHours: 24,
    contracts: {
      'hello.near-examples.testnet': { methods: ['set_greeting'] },
      'guestbook.near-examples.testnet': { methods: ['add_message'] },
    },
    transferAllowlist: [`bob.${ACCOUNT}`],
  };
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nag-'));
}

export function mockGuard(policy: Policy = testPolicy(), now?: () => Date) {
  const dir = tmpDir();
  const audit = new AuditLog(path.join(dir, 'audit.jsonl'), now);
  const executor = MockExecutor.fromContracts(ACCOUNT, policy.contracts);
  const guard = new Guard({
    policy,
    planner: new RuleBasedPlanner(),
    audit,
    executor,
    approvalsFile: path.join(dir, 'approvals.json'),
  });
  return { guard, audit, executor, dir };
}
