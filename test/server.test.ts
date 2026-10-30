import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createServer } from '../src/server.ts';
import { ACCOUNT, mockGuard } from './helpers.ts';

test('HTTP API: task, approvals, audit', async () => {
  const { guard, audit } = mockGuard();
  const srv = createServer(guard, audit).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (u: string, b?: unknown) =>
    fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
  try {
    assert.equal((await post('/task', { task: 'set greeting to hi' })).status, 'executed');
    const p = await post('/task', { task: `send 0.25 NEAR to bob.${ACCOUNT}` });
    assert.equal(p.status, 'pending_approval');
    assert.equal((await fetch(base + '/approvals').then((r) => r.json())).length, 1);
    assert.equal((await post(`/approvals/${p.requestId}/approve`)).status, 'executed');
    const a = await fetch(base + '/audit').then((r) => r.json());
    assert.equal(a.verify.ok, true);
    assert.equal((await fetch(base + '/task', { method: 'POST', body: '{}' })).status, 400);
    assert.match(await fetch(base + '/').then((r) => r.text()), /near-agent-guard/);
  } finally {
    srv.close();
  }
});
