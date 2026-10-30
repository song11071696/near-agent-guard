// Append-only, hash-chained JSONL audit log. Every record commits to the previous one,
// so editing or deleting a past line breaks `verify()`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseNear } from '../near/encoding.ts';
import { isoUtc } from '../time.ts';

export type AuditEvent =
  | 'decision'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_rejected'
  | 'executed'
  | 'execution_failed';

export interface AuditRecord {
  seq: number;
  ts: string;
  event: AuditEvent;
  requestId: string;
  [k: string]: unknown;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(o[k]))
      .join(',') +
    '}'
  );
}

function hashRecord(rec: Omit<AuditRecord, 'hash'>): string {
  return crypto.createHash('sha256').update(canonical(rec)).digest('hex');
}

export class AuditLog {
  readonly file: string;
  private now: () => Date;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file;
    this.now = now;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  read(): AuditRecord[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditRecord);
  }

  append(event: AuditEvent, requestId: string, data: Record<string, unknown> = {}): AuditRecord {
    const prev = this.read().at(-1);
    const body = {
      ...JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
      seq: (prev?.seq ?? 0) + 1,
      ts: isoUtc(this.now()),
      event,
      requestId,
      prevHash: prev?.hash ?? GENESIS,
    };
    const rec = { ...body, hash: hashRecord(body) } as AuditRecord;
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    return rec;
  }

  verify(): { ok: boolean; records: number; brokenAt?: number; error?: string } {
    let prevHash = GENESIS;
    const recs = this.read();
    for (const r of recs) {
      const { hash, ...body } = r;
      if (r.prevHash !== prevHash) return { ok: false, records: recs.length, brokenAt: r.seq, error: 'prevHash mismatch' };
      if (hashRecord(body) !== hash) return { ok: false, records: recs.length, brokenAt: r.seq, error: 'hash mismatch' };
      prevHash = hash;
    }
    return { ok: true, records: recs.length };
  }

  /** Value moved and tx count from successful executions inside the rolling window. */
  usage(windowHours: number): { spentYocto: bigint; txCount: number } {
    const since = this.now().getTime() - windowHours * 3600_000;
    let spentYocto = 0n;
    let txCount = 0;
    for (const r of this.read()) {
      if (r.event !== 'executed' || Date.parse(r.ts) < since) continue;
      txCount++;
      spentYocto += parseNear(String(r.valueNear ?? '0'));
    }
    return { spentYocto, txCount };
  }
}
