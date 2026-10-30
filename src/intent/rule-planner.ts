// Default planner: deterministic regex rules, English + 中文. No network, no API key.
import type { Intent, PlannedIntent, Planner } from './types.ts';
import { validateIntent } from './types.ts';

export interface RulePlannerOptions {
  greetingContract?: string;
  guestbookContract?: string;
}

const AMOUNT = '(\\d+(?:\\.\\d+)?)';
const ACCOUNT = '([a-z0-9][a-z0-9._-]*[a-z0-9])';

export class RuleBasedPlanner implements Planner {
  readonly name = 'rule-based';
  private readonly greeting: string;
  private readonly guestbook: string;

  constructor(opts: RulePlannerOptions = {}) {
    this.greeting = opts.greetingContract ?? 'hello.near-examples.testnet';
    this.guestbook = opts.guestbookContract ?? 'guestbook.near-examples.testnet';
  }

  async plan(task: string): Promise<PlannedIntent> {
    return { task, planner: this.name, intent: validateIntent(this.parse(task.trim())) };
  }

  private parse(t: string): Intent {
    const lower = t.toLowerCase();
    let m: RegExpMatchArray | null;

    // Dangerous intents first, so "...and then add a full access key" is never silently dropped.
    if (/(add|create)\s+(a\s+)?(full[- ]access\s+)?(access\s+)?key|添加.*(密钥|key)|新增.*(密钥|key)/i.test(t))
      return { kind: 'add_key', receiverId: 'self', detail: t };
    if (/(delete|remove)\s+(the\s+)?(access\s+)?key|删除.*(密钥|key)/i.test(t))
      return { kind: 'delete_key', receiverId: 'self', detail: t };
    if (/delete\s+(the\s+|my\s+)?account|删除.*账户|注销.*账户/i.test(t))
      return { kind: 'delete_account', receiverId: 'self', detail: t };
    if (/deploy\s+(a\s+)?(contract|wasm)|部署.*合约/i.test(t))
      return { kind: 'deploy_contract', receiverId: 'self', detail: t };

    // Transfers: "send 0.1 NEAR to bob.testnet", "transfer 2 near to x", "转 0.1 NEAR 给 bob.testnet"
    if ((m = lower.match(new RegExp(`(?:send|transfer|pay)\\s+${AMOUNT}\\s*near\\s+to\\s+${ACCOUNT}`))))
      return { kind: 'transfer', receiverId: m[2], amountNear: m[1] };
    if ((m = lower.match(new RegExp(`(?:转账?|发送|支付|打)\\s*${AMOUNT}\\s*near\\s*(?:给|到|至)\\s*${ACCOUNT}`))))
      return { kind: 'transfer', receiverId: m[2], amountNear: m[1] };
    if ((m = lower.match(new RegExp(`(?:给|向)\\s*${ACCOUNT}\\s*(?:转账?|发送|支付|打)\\s*${AMOUNT}\\s*near`))))
      return { kind: 'transfer', receiverId: m[1], amountNear: m[2] };

    // Greeting contract: "set greeting to hello", "set the greeting to 'gm'", "把问候语设为 你好"
    if ((m = t.match(/set\s+(?:the\s+)?greeting\s+(?:to|as)\s+["'“]?(.+?)["'”]?\s*$/i)))
      return this.fc(this.greeting, 'set_greeting', { greeting: m[1] });
    if ((m = t.match(/(?:把)?问候语?(?:设为|设置为|改成|改为)\s*["'“]?(.+?)["'”]?\s*$/)))
      return this.fc(this.greeting, 'set_greeting', { greeting: m[1] });

    // Guestbook: "post 'hi' to the guestbook", "sign the guestbook with hi", "在留言板留言 你好"
    if ((m = t.match(/(?:post|write|leave)\s+["'“]?(.+?)["'”]?\s+(?:to|on|in)\s+(?:the\s+)?guest\s?book/i)))
      return this.fc(this.guestbook, 'add_message', { text: m[1] });
    if ((m = t.match(/sign\s+(?:the\s+)?guest\s?book\s+with\s+["'“]?(.+?)["'”]?\s*$/i)))
      return this.fc(this.guestbook, 'add_message', { text: m[1] });
    if ((m = t.match(/(?:在)?留言板?(?:上)?留言[:：]?\s*["'“]?(.+?)["'”]?\s*$/)))
      return this.fc(this.guestbook, 'add_message', { text: m[1] });

    // Generic: "call <method> on <contract> [with {json}] [deposit X NEAR] [gas N tgas]"
    if ((m = t.match(/call\s+([A-Za-z_][A-Za-z0-9_]*)\s+on\s+([a-z0-9][a-z0-9._-]*[a-z0-9])(.*)$/i))) {
      const rest = m[3];
      let args: Record<string, unknown> = {};
      const j = rest.match(/with\s+(\{.*\})/i);
      if (j) {
        try {
          args = JSON.parse(j[1]);
        } catch {
          return { kind: 'unknown', reason: 'args JSON could not be parsed' };
        }
      }
      const dep = rest.match(new RegExp(`deposit\\s+${AMOUNT}\\s*near`, 'i'));
      const gas = rest.match(/gas\s+(\d+)\s*tgas/i);
      return {
        kind: 'function_call',
        receiverId: m[2].toLowerCase(),
        methodName: m[1],
        args,
        gasTgas: gas ? Number(gas[1]) : 30,
        depositNear: dep ? dep[1] : '0',
      };
    }

    return { kind: 'unknown', reason: 'no rule matched this task' };
  }

  private fc(receiverId: string, methodName: string, args: Record<string, unknown>): Intent {
    return { kind: 'function_call', receiverId, methodName, args, gasTgas: 30, depositNear: '0' };
  }
}
