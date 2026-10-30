// Human-readable rendering of guard results for the CLI.
import type { GuardResult } from './guard.ts';

const C = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code: number, s: string) => (C ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = (s: string) => color(32, s);
export const red = (s: string) => color(31, s);
export const yellow = (s: string) => color(33, s);
export const dim = (s: string) => color(2, s);

export function renderResult(r: GuardResult): string {
  const lines: string[] = [];
  if (r.planned) {
    lines.push(`${dim('task   ')} ${r.planned.task}`);
    lines.push(`${dim('intent ')} ${JSON.stringify(r.planned.intent)}  ${dim(`(planner: ${r.planned.planner})`)}`);
  }
  if (r.decision) {
    for (const c of r.decision.checks) lines.push(`   ${c.ok ? green('✓') : red('✗')} ${c.rule.padEnd(20)} ${dim(c.detail)}`);
  }
  const head = {
    executed: green('EXECUTED'),
    denied: red('DENIED'),
    pending_approval: yellow('PENDING APPROVAL'),
    failed: red('FAILED'),
    rejected: red('REJECTED BY HUMAN'),
  }[r.status];
  let tail = '';
  if (r.status === 'denied') tail = r.decision?.reasons.join(', ') ?? '';
  if (r.status === 'pending_approval') tail = `approve with: npm run cli -- approve ${r.requestId}`;
  if (r.status === 'executed') tail = `${r.signerKey ? `signed by ${r.signerKey}  ` : ''}${r.explorerUrl ?? r.txHash ?? ''}`;
  if (r.status === 'failed') tail = r.error ?? '';
  lines.push(`${dim('result ')} ${head}  ${tail}`);
  lines.push(dim(`request ${r.requestId}`));
  return lines.join('\n');
}
