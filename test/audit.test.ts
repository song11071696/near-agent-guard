import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AuditLog } from '../src/audit/log.ts';
import { tmpDir } from './helpers.ts';

test('hash chain verifies and detects tampering', () => {
  const log = new AuditLog(path.join(tmpDir(), 'a.jsonl'));
  log.append('decision', 'r1', { verdict: 'allow', valueNear: '0' });
  log.append('executed', 'r1', { txHash: 'abc', valueNear: '0.1' });
  log.append('decision', 'r2', { verdict: 'deny' });
  assert.deepEqual(log.verify(), { ok: true, records: 3 });

  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[1]);
  rec.valueNear = '0.0001'; // hide a spend
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(log.file, lines.join('\n') + '\n');
  const v = log.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
});

test('deleting a line breaks the chain', () => {
  const log = new AuditLog(path.join(tmpDir(), 'a.jsonl'));
  for (let i = 0; i < 3; i++) log.append('decision', `r${i}`);
  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n');
  fs.writeFileSync(log.file, [lines[0], lines[2]].join('\n') + '\n');
  assert.equal(log.verify().ok, false);
});

test('usage counts only successful executions inside the rolling window', () => {
  let now = new Date('2026-11-01T00:00:00Z');
  const log = new AuditLog(path.join(tmpDir(), 'a.jsonl'), () => now);
  log.append('executed', 'old', { valueNear: '0.5' });
  now = new Date('2026-11-02T01:00:00Z'); // 25h later
  log.append('executed', 'a', { valueNear: '0.1' });
  log.append('execution_failed', 'b', { valueNear: '0.4' });
  log.append('executed', 'c', { valueNear: '0' });
  const u = log.usage(24);
  assert.equal(u.spentYocto, 10n ** 23n);
  assert.equal(u.txCount, 2);
});

test('timestamps are RFC 3339 UTC', async () => {
  const { isoUtc } = await import('../src/time.ts');
  assert.equal(isoUtc(new Date(Date.UTC(2026, 10, 1, 0, 0, 0, 5))), '2026-11-01T00:00:00.005Z');
  const log = new AuditLog(path.join(tmpDir(), 'a.jsonl'));
  assert.match(log.append('decision', 'r').ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});
