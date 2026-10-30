# Architecture

## Problem

An autonomous agent that holds a full-access private key can lose everything to one bad decision. That decision might come from a hallucination, a prompt injection in a web page it read, or a compromised tool. Off-chain guardrails alone can be bypassed by anyone who gets the key. On-chain key scoping alone cannot express "at most 1 NEAR a day" or "ask a human above 0.2 NEAR".

near-agent-guard combines both layers:

```
            ┌────────────── untrusted ──────────────┐   ┌─────────────── trusted ───────────────────────────┐
 task ───►  │ Planner (rules | LLM)  ──► Intent JSON │──►│ validateIntent ─► Policy engine ─► Approval queue │
            └────────────────────────────────────────┘   │        │                 │               │         │
                                                         │        ▼                 ▼               ▼         │
                                                         │   audit.jsonl ◄── decision / approval / execution │
                                                         │                          │ allow                  │
                                                         │                          ▼                        │
                                                         │   Key router: deposit-free call → agent FC key     │
                                                         │               value transfer    → owner vault key  │
                                                         └──────────────────────────┬────────────────────────┘
                                                                                    ▼
                                                             NEAR testnet (protocol re-checks the key scope)
```

## Layers of defense

1. **Intent boundary.** The planner, which may be an LLM, outputs only a JSON *intent*. `validateIntent` checks the account-id grammar, method-name grammar, gas range and decimal amounts. Anything malformed becomes `unknown` and is denied.
2. **Policy engine** (`src/policy/engine.ts`). This is a pure function of `(policy, intent, usage)`, so it is easy to test and audit. It evaluates *all* rules and reports every failing rule, not just the first. Usage, meaning value moved and tx count in a rolling window, is derived from the audit log itself, so there is one source of truth.
3. **Human approval.** Value at or above the threshold goes to a queue. When a human approves, the engine runs again with `approved=true` against **current** usage, so an approval granted late cannot break the daily cap.
4. **On-chain key scope.** Deposit-free calls are signed with a NEAR function-call access key. Each key is bound by the protocol to one receiver contract, a method list and a gas allowance, and cannot attach deposits or transfer NEAR. This layer holds even if layers 1 to 3 are misconfigured or bypassed. `npm run cli -- attack` proves it on testnet (`InvalidAccessKeyError: RequiresFullAccess`), and `test/guard.test.ts` covers the misconfigured-policy case.
5. **Tamper-evident audit.** Each JSONL record contains `prevHash` and `hash = sha256(canonical(record))`. Editing or deleting any past line breaks `audit --verify`.

## Why two keys

On NEAR, a function-call key cannot attach a deposit, and `ft_transfer` needs 1 yoctoNEAR. So value-moving actions need a full-access key. The guard keeps that key in a local vault and uses it only after the policy engine (and, above the threshold, a human) allows the action. The agent-side path never loads it. In this prototype both paths live in one process. Production would put the vault signer in a separate process, HSM or MPC service behind the same policy API.

## Testnet-only enforcement

- `NearRpc.assertTestnet()` must see `chain_id == "testnet"` before `send_tx`.
- `assertTestnetAccount()` is applied to the signer, receivers and config.
- `validatePolicy()` rejects `network != "testnet"` and any non-`.testnet` contract or recipient.
- A live test confirms that pointing at `rpc.mainnet.near.org` is refused.

## Zero-dependency NEAR layer

`src/near/` implements base58, a Borsh writer, ed25519 through `node:crypto`, Transaction V0 serialization (`CreateAccount`, `DeployContract`, `FunctionCall`, `Transfer`, `AddKey` with FullAccess or FunctionCall permission, `DeleteKey`, `DeleteAccount`), signing (`ed25519(sha256(borsh(tx)))`) and a JSON-RPC client. It is checked against the RFC 8032 test vectors and hand-built Borsh layouts. Real testnet transactions confirmed it end to end (see `docs/demo-output-testnet.txt`).

## Roadmap (not in this prototype)

- An on-chain guard contract, so limits are enforced by the chain itself rather than off-chain, with funds held in the contract.
- Token-aware rules (`ft_transfer` amount caps per token), and simulation before signing.
- Approvals via Telegram, a wallet signature or passkey, with multiple approvers.
- Shade Agents / TEE deployment of the vault signer, and NEAR Intents / chain signatures for cross-chain actions.
- Storing the audit log hash chain head on chain periodically.
