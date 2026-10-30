// Wiring: builds a Guard from env/flags. Shared by CLI and HTTP server.
import fs from 'node:fs';
import path from 'node:path';
import { AuditLog } from './audit/log.ts';
import type { Executor } from './executor.ts';
import { MockExecutor, TestnetExecutor } from './executor.ts';
import { Guard } from './guard.ts';
import { OpenAICompatiblePlanner } from './intent/llm-planner.ts';
import { RuleBasedPlanner } from './intent/rule-planner.ts';
import type { Planner } from './intent/types.ts';
import { KeyStore } from './keystore.ts';
import { NearRpc } from './near/rpc.ts';
import type { Policy } from './policy/engine.ts';
import { validatePolicy } from './policy/engine.ts';

export const MOCK_ACCOUNT = 'mock-agent.testnet';

export interface AppOptions {
  mock?: boolean;
  dryRun?: boolean;
  home?: string;
  policyFile?: string;
}

export function guardHome(opts: AppOptions = {}): string {
  return path.resolve(opts.home ?? process.env.GUARD_HOME ?? '.guard');
}

export function defaultPolicyFile(): string {
  if (process.env.GUARD_POLICY) return process.env.GUARD_POLICY;
  return fs.existsSync('policy.json') ? 'policy.json' : path.join(import.meta.dirname, '..', 'policy.example.json');
}

/** Loads policy JSON, substituting ${ACCOUNT} with the guarded account id. */
export function loadPolicy(file: string, accountId: string): Policy {
  const text = fs.readFileSync(file, 'utf8').replaceAll('${ACCOUNT}', accountId);
  return validatePolicy(JSON.parse(text) as Policy);
}

export function makePlanner(): Planner {
  if ((process.env.PLANNER ?? 'rule') === 'llm') {
    if (!process.env.LLM_BASE_URL || !process.env.LLM_MODEL) {
      throw new Error('PLANNER=llm needs LLM_BASE_URL and LLM_MODEL (e.g. a local Ollama: http://localhost:11434/v1)');
    }
    return new OpenAICompatiblePlanner({
      baseUrl: process.env.LLM_BASE_URL,
      model: process.env.LLM_MODEL,
      apiKey: process.env.LLM_API_KEY,
    });
  }
  return new RuleBasedPlanner();
}

export function buildGuard(opts: AppOptions = {}): { guard: Guard; audit: AuditLog; accountId: string; executor: Executor } {
  const home = guardHome(opts);
  const policyFile = opts.policyFile ?? defaultPolicyFile();
  let accountId: string;
  let executor: Executor;
  let dataDir: string;
  if (opts.mock) {
    accountId = MOCK_ACCOUNT;
    dataDir = path.join(home, 'mock');
    const policy = loadPolicy(policyFile, accountId);
    executor = MockExecutor.fromContracts(accountId, policy.contracts);
  } else {
    const ks = new KeyStore(home);
    if (!ks.hasConfig()) throw new Error(`no testnet account set up in ${home}. Run: npm run setup  (or use --mock)`);
    accountId = ks.readConfig().accountId;
    dataDir = home;
    executor = new TestnetExecutor(new NearRpc(), ks);
  }
  const policy = loadPolicy(policyFile, accountId);
  const audit = new AuditLog(path.join(dataDir, 'audit.jsonl'));
  const guard = new Guard({
    policy,
    planner: makePlanner(),
    audit,
    executor,
    approvalsFile: path.join(dataDir, 'approvals.json'),
    dryRun: opts.dryRun,
  });
  return { guard, audit, accountId, executor };
}
