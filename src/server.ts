// Minimal HTTP API (node:http, no framework) + a one-file HTML console for demos.
import http from 'node:http';
import type { AuditLog } from './audit/log.ts';
import type { Guard } from './guard.ts';

const PAGE = `<!doctype html><meta charset="utf-8"><title>near-agent-guard</title>
<style>body{font:14px system-ui;max-width:860px;margin:2em auto;padding:0 1em}pre{background:#f4f4f4;padding:1em;overflow:auto;white-space:pre-wrap}input{width:70%;padding:.5em}button{padding:.5em 1em}</style>
<h1>near-agent-guard</h1><p>Policy-limited wallet for AI agents — NEAR <b>testnet</b> only.</p>
<form id=f><input id=t value="set greeting to gm from a guarded agent"><button>Run task</button></form>
<h3>Result</h3><pre id=r>—</pre><h3>Pending approvals</h3><pre id=p>—</pre><h3>Audit log (latest 10)</h3><pre id=a>—</pre>
<script>
const j=(u,o)=>fetch(u,o).then(r=>r.json());
async function refresh(){p.textContent=JSON.stringify(await j('/approvals'),null,2);const a_=await j('/audit');a.textContent=a_.records.slice(-10).map(x=>x.seq+' '+x.event+' '+(x.verdict||x.txHash||x.error||'')).join('\\n')+'\\nchain verify: '+JSON.stringify(a_.verify)}
f.onsubmit=async e=>{e.preventDefault();r.textContent='…';r.textContent=JSON.stringify(await j('/task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:t.value})}),null,2);refresh()};
refresh();
</script>`;

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 16_384) throw new Error('body too large');
  }
  return data ? (JSON.parse(data) as Record<string, unknown>) : {};
}

export function createServer(guard: Guard, audit: AuditLog): http.Server {
  return http.createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj, null, 2));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const m = url.pathname.match(/^\/approvals\/([\w-]+)\/(approve|reject)$/);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      if (req.method === 'GET' && url.pathname === '/policy') return send(200, guard.policy);
      if (req.method === 'GET' && url.pathname === '/approvals') return send(200, guard.pending());
      if (req.method === 'GET' && url.pathname === '/audit') return send(200, { verify: audit.verify(), records: audit.read() });
      if (req.method === 'POST' && url.pathname === '/task') {
        const b = await body(req);
        if (typeof b.task !== 'string' || !b.task.trim()) return send(400, { error: 'body must be {"task": "..."}' });
        return send(200, await guard.handleTask(b.task));
      }
      if (req.method === 'POST' && m) {
        return send(200, m[2] === 'approve' ? await guard.approve(m[1], 'http') : guard.reject(m[1], 'http'));
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });
}
