# near-agent-guard

**A policy-and-limits wallet for AI agents on NEAR.** The agent never holds a full-access key. It holds NEAR **function-call access keys** that only reach one contract, a few methods, and a fixed gas allowance. Every action also passes through a **policy engine** before anything is signed. The engine checks per-tx and daily limits, contract, method and recipient allowlists, and a human-approval threshold. Every decision goes into a **hash-chained JSONL audit log**.

Tracks: **AI Security & Defense** + **Agents**. Runs on **NEAR testnet only**. No mainnet, no paid APIs, **zero runtime dependencies** (Node ≥ 22.18 runs the TypeScript directly).

```
"转 0.25 NEAR 给 bob.x.testnet"  →  planner  →  intent  →  POLICY ENGINE  →  approve?  →  sign  →  testnet
                                                                │                         │
                                                                └──── audit.jsonl ◄────────┘  (hash chain)
```

## Quick start: run X → see Y

All commands run from this folder. There is nothing to install for runtime. `npm install` only adds the optional type checker.

| Run | You should see |
|---|---|
| `node --version` | `v22.18` or newer. Native TypeScript stripping is needed. |
| `npm test` | `# pass 35`, `# fail 0`, `# skipped 2`. The 2 skipped tests are the opt-in live testnet checks. |
| `NEAR_LIVE=1 node --test test/live.test.ts` | `# pass 2`: the testnet RPC reports `chain_id=testnet`, and a mainnet RPC is **refused**. |
| `npm run demo:mock` | An offline walkthrough in about 2 s. 3 tasks are **EXECUTED**, 3 are **DENIED** (`RECIPIENT_ALLOWLIST…`, `FORBIDDEN_ACTION`, `CONTRACT_ALLOWLIST`). One is **PENDING APPROVAL**, then **EXECUTED** after approval. Ends with `✓ audit chain intact`. |
| `npm run setup` | Creates a fresh `agent-guard-xxxx.testnet` account through NEAR's free testnet helper (10 test NEAR). Adds one function-call key per allowlisted contract and creates the demo recipient `bob.<account>`. You get the explorer links. |
| `npm run cli -- status` | The account balance and its keys **as read from chain**: one `FullAccess` (owner vault) key, plus `FunctionCall → hello.near-examples.testnet [set_greeting] allowance 0.25 NEAR` and the same for the guestbook. |
| `npm run demo` | The same walkthrough as the mock demo, but every EXECUTED line carries a real `https://testnet.nearblocks.io/txns/…` link. Step 8 signs a transfer with the agent key and **skips the policy engine**. You see `✓ testnet REJECTED it … InvalidAccessKeyError: RequiresFullAccess`. |
| `npm run cli -- task "set greeting to hello"` | The check list (`✓ CONTRACT_ALLOWLIST`, `✓ METHOD_ALLOWLIST`, …), then `EXECUTED signed by agent_fc_key <tx link>`. |
| `npm run cli -- task "send 1 NEAR to attacker.testnet"` | `DENIED RECIPIENT_ALLOWLIST, PER_TX_LIMIT, DAILY_LIMIT`. Nothing is signed. |
| `npm run cli -- task "send 0.3 NEAR to bob.<account>"` | `PENDING APPROVAL`. Then `npm run cli -- approve <id>` gives `EXECUTED signed by owner_vault`. `reject <id>` cancels it. |
| `npm run cli -- audit --verify` | `✓ audit chain intact (N records)`. Edit any line in `.guard/audit.jsonl` and run it again: `✗ audit chain BROKEN at seq N`. |
| `npm run serve` (or `npm run serve -- --mock`) | `http://127.0.0.1:8787`: a small web console plus a JSON API (see below). |

Add `--mock` to any `task`, `pending`, `approve`, `audit` or `serve` command to run fully offline. Add `--dry-run` to evaluate without signing.

A real testnet run of `npm run demo`, with its tx links, is in [`docs/demo-output-testnet.txt`](docs/demo-output-testnet.txt).

## What the agent can say

The default planner is a deterministic rule parser for English and 中文. It needs no API key:

- `set greeting to <text>` / `把问候语设为 <text>` → `hello.near-examples.testnet.set_greeting`
- `post "<text>" to the guestbook` / `在留言板留言：<text>` → `guestbook.near-examples.testnet.add_message`
- `send 0.1 NEAR to x.testnet` / `转 0.1 NEAR 给 x.testnet` / `给 x.testnet 转账 0.1 NEAR` → transfer
- `call <method> on <contract> [with {json}] [deposit N NEAR] [gas N tgas]` → generic call
- Tasks that ask to add or delete keys, deploy, or delete the account are parsed into explicit intents so the policy can **deny** them. They are never silently dropped.

**Pluggable LLM:** set `PLANNER=llm LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen2.5` to use any OpenAI-compatible endpoint, such as a local Ollama with no key. LLM output is treated as untrusted. It is validated against a schema and then goes through the same policy, so a prompt-injected model can only *propose* intents.

## Policy

`policy.example.json` is the default. Copy it to `policy.json` to customise. `${ACCOUNT}` is replaced with the guarded account.

```json
{
  "version": 1, "network": "testnet",
  "limits": { "maxPerTxNear": "0.5", "dailyLimitNear": "1", "approvalThresholdNear": "0.2",
              "maxTxPerDay": 20, "maxGasTgas": 50, "maxArgsBytes": 1024 },
  "windowHours": 24,
  "contracts": { "hello.near-examples.testnet": { "methods": ["set_greeting"] },
                 "guestbook.near-examples.testnet": { "methods": ["add_message"] } },
  "transferAllowlist": ["bob.${ACCOUNT}"]
}
```

| Rule | Denies when |
|---|---|
| `UNPARSEABLE_TASK` | the planner could not map the task |
| `FORBIDDEN_ACTION` | add or delete key, deploy, delete account. Always denied for agents. |
| `TESTNET_ONLY` | the receiver is not `*.testnet` |
| `CONTRACT_ALLOWLIST` / `METHOD_ALLOWLIST` | the contract or method is not listed |
| `DEPOSIT_LIMIT` | the attached deposit is above the contract's `maxDepositNear` (default 0) |
| `GAS_LIMIT` / `ARGS_SIZE` | the call is too heavy or its args too large |
| `RECIPIENT_ALLOWLIST` / `NONZERO_AMOUNT` | the transfer recipient is not listed, or the amount is 0 |
| `PER_TX_LIMIT` | value > `maxPerTxNear` |
| `DAILY_LIMIT` | value moved in the rolling window + this one > `dailyLimitNear`. This blocks "salami" attacks. |
| `RATE_LIMIT` | executed txs in the window ≥ `maxTxPerDay` |
| `APPROVAL_REQUIRED` | value ≥ `approvalThresholdNear`. The request goes to a human queue. Approval **never** overrides a hard limit and is re-checked against current usage. |

## HTTP API

`node src/cli.ts serve [--mock] [--port 8787]` binds to 127.0.0.1.

- `POST /task` `{"task":"set greeting to gm"}` → `{status: executed|denied|pending_approval|failed, decision, txHash, explorerUrl}`
- `GET /approvals` · `POST /approvals/:id/approve` · `POST /approvals/:id/reject`
- `GET /audit` → `{verify:{ok,records}, records:[…]}` · `GET /policy` · `GET /` web console

## Safety guarantees in this prototype

- **Testnet only, enforced in code.** Before any write, the RPC must report `chain_id: "testnet"`. Account ids must end in `.testnet`, and policies with non-testnet contracts or recipients fail to load.
- **No spending.** The account is created free through `helper.testnet.near.org`, which funds it with 10 test NEAR. Demo transfers go to `bob.<account>`, a sub-account you own.
- Keys live in `.guard/keys/*.key` (chmod 600, git-ignored). The agent-facing path loads only the function-call key for the target contract. The owner key is loaded only for policy-approved value transfers.

## Layout

```
src/near/        zero-dep NEAR layer: base58, borsh, ed25519 keys, tx serialization, JSON-RPC
src/intent/      Intent types + validation, rule-based planner (default), OpenAI-compatible planner (optional)
src/policy/      pure policy engine
src/audit/       hash-chained JSONL audit log + rolling usage
src/executor.ts  TestnetExecutor (real) / MockExecutor (emulates protocol FC-key rules)
src/guard.ts     orchestration + approval queue
src/setup.ts     free testnet account + FC key provisioning, bypass-attack demo
src/cli.ts, src/server.ts
test/            node:test suites (35 tests + 2 opt-in live)
scripts/demo.sh  demo script (--mock or testnet)
docs/ARCHITECTURE.md
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the threat model and design.

## License

MIT, see [LICENSE](LICENSE).
