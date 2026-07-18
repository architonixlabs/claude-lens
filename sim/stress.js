// stress.js — hammer the ingest pipeline and report throughput, latency, memory,
// eviction, and search performance.  Run:  npm run stress  [sessions] [eventsPer]
//
// Persistence is disabled here to isolate ingest performance from disk I/O.
import { performance } from 'node:perf_hooks';

process.env.AGENTVIZ_NO_PERSIST = '1';
const { createServer } = await import('../server/index.js');

const SESSIONS = Number(process.argv[2]) || 500;
const EPS = Number(process.argv[3]) || 40;       // tool calls per session (×2 ingests each)
const CONC = 64;                                 // concurrent in-flight requests
const PORT = 4480;

const srv = createServer({ demo: false });
await new Promise((r) => srv.server.listen(PORT, r));
const base = `http://127.0.0.1:${PORT}`;

// build the workload
const jobs = [];
for (let i = 0; i < SESSIONS; i++) {
  const sid = 'stress-' + i;
  jobs.push({ session_id: sid, hook_event_name: 'SessionStart', cwd: '/repo/s' + i });
  jobs.push({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'w' + i } });
  for (let j = 0; j < EPS; j++) {
    const id = `${sid}-${j}`;
    jobs.push({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cmd ' + j }, tool_use_id: id });
    jobs.push({ session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_response: { stdout: 'ok' + j, exit_code: j % 17 === 0 ? 1 : 0 } });
  }
}
const total = jobs.length;
const lat = [];
let idx = 0, ok = 0, fail = 0;

async function worker() {
  while (idx < jobs.length) {
    const body = jobs[idx++];
    const a = performance.now();
    try {
      const r = await fetch(base + '/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) ok++; else fail++;
      await r.arrayBuffer();
    } catch { fail++; }
    lat.push(performance.now() - a);
  }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, worker));
const secs = (performance.now() - t0) / 1000;

lat.sort((a, b) => a - b);
const pct = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] || 0;

const ss0 = performance.now();
const search = await (await fetch(base + '/api/search?q=cmd&limit=50')).json();
const searchMs = performance.now() - ss0;
const health = await (await fetch(base + '/api/health')).json();

console.log(`\n  STRESS — ${SESSIONS} sessions × ${EPS} tool calls  →  ${total} ingests, ${CONC} concurrent`);
console.log(`  throughput : ${Math.round(total / secs)} req/s  over ${secs.toFixed(2)}s   (ok=${ok} fail=${fail})`);
console.log(`  latency ms : p50=${pct(0.5).toFixed(1)}  p95=${pct(0.95).toFixed(1)}  p99=${pct(0.99).toFixed(1)}  max=${lat[lat.length - 1].toFixed(1)}`);
console.log(`  sessions   : ${health.sessions} live (cap 300 enforced: ${health.sessions <= 300 ? 'YES' : 'NO'})`);
console.log(`  memory     : rss=${health.memoryMB}MB  heap=${health.heapMB}MB`);
console.log(`  search     : '${search.q}' → ${search.count} hits in ${searchMs.toFixed(1)}ms\n`);

await srv.close();
process.exit(fail > 0 ? 1 : 0);
