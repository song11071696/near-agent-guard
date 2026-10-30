// Optional planner for any OpenAI-compatible chat endpoint (local Ollama, vLLM, etc).
// Off by default. Its output is treated as UNTRUSTED: validated structurally, then the
// policy engine decides. A compromised or prompt-injected model can only produce intents.
import type { PlannedIntent, Planner } from './types.ts';
import { validateIntent } from './types.ts';

export interface LlmPlannerOptions {
  baseUrl: string; // e.g. http://localhost:11434/v1
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

const SYSTEM = `You convert a user's task into ONE NEAR testnet transaction intent.
Reply with JSON only, one of:
{"kind":"function_call","receiverId":"<contract>.testnet","methodName":"...","args":{...},"gasTgas":30,"depositNear":"0"}
{"kind":"transfer","receiverId":"<account>.testnet","amountNear":"0.1"}
{"kind":"unknown","reason":"..."}
Never invent accounts. Never add keys, deploy, or delete accounts.`;

export class OpenAICompatiblePlanner implements Planner {
  readonly name = 'llm';
  private readonly opts: LlmPlannerOptions;

  constructor(opts: LlmPlannerOptions) {
    this.opts = opts;
  }

  async plan(task: string): Promise<PlannedIntent> {
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const res = await f(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.opts.model,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: task },
          ],
        }),
      });
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content ?? '';
      const raw = content.match(/\{[\s\S]*\}/)?.[0];
      if (!raw) return { task, planner: this.name, intent: { kind: 'unknown', reason: 'LLM returned no JSON' } };
      return { task, planner: this.name, intent: validateIntent(JSON.parse(raw)) };
    } catch (e) {
      return { task, planner: this.name, intent: { kind: 'unknown', reason: `LLM planner failed: ${(e as Error).message}` } };
    }
  }
}
