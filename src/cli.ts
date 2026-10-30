#!/usr/bin/env node
// near-agent-guard CLI. Run `node src/cli.ts help`.
import { buildGuard, defaultPolicyFile, guardHome, loadPolicy } from './app.ts';
import { dim, green, red, renderResult } from './format.ts';
import { KeyStore } from './keystore.ts';
import { formatNear } from './near/encoding.ts';
import { NearRpc } from './near/rpc.ts';
import { createServer } from './server.ts';
import { bypassAttack, setup } from './setup.ts';

const HELP = `near-agent-guard — policy/limit wallet for AI agents (NEAR testnet only)

usage: node src/cli.ts <command> [args] [--mock] [--dry-run]

  setup [--account x.testnet] [--allowance 0.25]   create a free testnet account + agent FC keys
  status                                           account balance + on-chain access keys
  task "<natural language>"                        plan -> policy -> (approve) -> execute
  pending                                          list requests waiting for a human
  approve <id> | reject <id>                       human decision on a pending request
  audit [--verify]                                 print / verify the hash-chained audit log
  attack [--to bob.<account>]                      bypass the policy and sign a transfer with the
                                                   agent FC key -> testnet must reject it
  serve [--port 8787]                              HTTP API + web console
  policy                                           print the effective policy

  --mock     offline: emulated chain (protocol FC-key rules), no network, account ${'mock-agent.testnet'}
  --dry-run  run planner + policy, never sign
env: GUARD_HOME (.guard)  GUARD_POLICY  PLANNER=rule|llm  LLM_BASE_URL  LLM_MODEL  LLM_API_KEY  NEAR_RPC_URL`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const mock = argv.includes('--mock');
  const dryRun = argv.includes('--dry-run');
  const args = argv.filter((a) => a !== '--mock' && a !== '--dry-run');
  const [cmd, ...rest] = args;

  switch (cmd) {
    case 'setup': {
      const ks = new KeyStore(guardHome());
      await setup(ks, (acct) => loadPolicy(defaultPolicyFile(), acct), {
        accountId: flag(rest, '--account'),
        allowanceNear: flag(rest, '--allowance'),
      });
      return;
    }
    case 'status': {
      const ks = new KeyStore(guardHome());
      const cfg = ks.readConfig();
      const rpc = new NearRpc();
      const acct = await rpc.viewAccount(cfg.accountId);
      console.log(`account  ${cfg.accountId}  balance ${formatNear(acct.amount)} NEAR (testnet)`);
      console.log(`explorer https://testnet.nearblocks.io/address/${cfg.accountId}`);
      for (const k of await rpc.viewAccessKeyList(cfg.accountId)) {
        const p = k.permission;
        const label = k.publicKey === cfg.ownerPublicKey ? 'owner vault' : 'agent';
        console.log(
          p.type === 'FullAccess'
            ? `  ${k.publicKey}  FullAccess  ${dim(label)}`
            : `  ${k.publicKey}  FunctionCall → ${p.receiverId} [${p.methodNames.join(',')}] allowance ${p.allowance === null ? '∞' : formatNear(p.allowance)} NEAR  ${dim(label)}`,
        );
      }
      return;
    }
    case 'task': {
      const text = rest.join(' ').trim();
      if (!text) throw new Error('usage: task "<natural language>"');
      const { guard } = buildGuard({ mock, dryRun });
      const r = await guard.handleTask(text);
      console.log(renderResult(r));
      process.exitCode = r.status === 'executed' || r.status === 'pending_approval' ? 0 : 2;
      return;
    }
    case 'pending': {
      const { guard } = buildGuard({ mock });
      const list = guard.pending();
      if (!list.length) console.log('no pending approvals');
      for (const p of list) console.log(`${p.id}  ${p.decision.valueNear} NEAR  ${JSON.stringify(p.intent)}  "${p.task}"`);
      return;
    }
    case 'approve':
    case 'reject': {
      if (!rest[0]) throw new Error(`usage: ${cmd} <request-id>`);
      const { guard } = buildGuard({ mock, dryRun });
      const r = cmd === 'approve' ? await guard.approve(rest[0], 'cli') : guard.reject(rest[0], 'cli');
      console.log(renderResult(r));
      return;
    }
    case 'audit': {
      const { audit } = buildGuard({ mock });
      if (rest.includes('--verify')) {
        const v = audit.verify();
        console.log(v.ok ? green(`✓ audit chain intact (${v.records} records) ${audit.file}`) : red(`✗ audit chain BROKEN at seq ${v.brokenAt}: ${v.error}`));
        process.exitCode = v.ok ? 0 : 3;
        return;
      }
      for (const r of audit.read()) console.log(JSON.stringify(r));
      return;
    }
    case 'attack': {
      const ks = new KeyStore(guardHome());
      const to = flag(rest, '--to') ?? `bob.${ks.readConfig().accountId}`;
      console.log(`signing Transfer 0.01 NEAR → ${to} with the AGENT function-call key, skipping the policy engine…`);
      const r = await bypassAttack(ks, to);
      console.log(r.rejected ? green(`✓ testnet REJECTED it (on-chain key scope holds):`) : red('✗ chain accepted — key scope misconfigured!'));
      console.log(dim(r.detail.slice(0, 400)));
      process.exitCode = r.rejected ? 0 : 4;
      return;
    }
    case 'serve': {
      const { guard, audit, accountId, executor } = buildGuard({ mock, dryRun });
      const port = Number(flag(rest, '--port') ?? process.env.PORT ?? 8787);
      createServer(guard, audit).listen(port, '127.0.0.1', () =>
        console.log(`near-agent-guard on http://127.0.0.1:${port}  account=${accountId} executor=${executor.name}`),
      );
      return;
    }
    case 'policy': {
      const { guard } = buildGuard({ mock });
      console.log(JSON.stringify(guard.policy, null, 2));
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(red(`error: ${(e as Error).message}`));
  process.exitCode = 1;
});
