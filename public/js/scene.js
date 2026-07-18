// scene.js — clean 2D node-link renderer (HTML canvas).
//
// A flat, dashboard-style graph laid out left→right: You → Claude (orchestrator)
// → subagents, with tool/skill/mcp calls shown as small chips beside the agent
// that made them. Messages glide as pulses along the links. Static, legible,
// analyzable — no rotation, no occlusion. Public API matches the old 3D scene so
// the rest of the app is unchanged (setAutoRotate is a no-op here).

const COLORS = {
  user: '#35e0ff', orchestrator: '#ffc04a', subagent: '#a98bff',
  active: '#5affc0', done: '#5aa886', idle: '#7b84a8', error: '#ff5a72',
  tool: '#6fa8ff', skill: '#4fd6a0', mcp: '#c78bff',
};
const KIND_ICON = { tool: '⚙', skill: '◆', mcp: '⬡' };
const RESPONSE = '#5affc0';
// shown (cycling) on an agent that is active but between tool calls — i.e. the
// model is generating/thinking, which has no hook event, so the node would
// otherwise look idle. Mirrors the words Claude Code shows in the console.
const THINK_WORDS = ['Generating', 'Thinking', 'Pondering', 'Reasoning', 'Working', 'Puzzling', 'Cooking', 'Synthesizing', 'Analyzing', 'Planning'];

const DX = 300;          // world horizontal spacing between depth columns
const DY = 110;          // world vertical spacing between sibling rows
const TOOL_DX = 220;     // tool chip offset to the right of its owner
const TOOL_DY = 62;      // vertical spacing between an owner's tool chips

export function initScene(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0;

  const nodes = new Map();     // id -> agent node
  const edges = [];            // {from, to}
  const toolNodes = new Map(); // callId -> tool chip
  const flows = [];            // travelling message pulses
  let subColorIdx = 0;
  let toolCallsTotal = 0;

  // view transform (world → screen): screen = world*scale + offset
  const view = { scale: 1, ox: 0, oy: 0 };
  const target = { scale: 1, ox: 0, oy: 0 };
  let userView = false; // true once the user pans/zooms; disables auto-fit

  const SUB_PALETTE = ['#a98bff', '#ff8bd1', '#8bd0ff', '#ffd08b', '#8bffb0', '#c78bff', '#ff9f8b'];

  // ---------- sizing ----------
  function resize() {
    W = canvas.clientWidth || canvas.parentElement.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- helpers ----------
  function measure(text, font) { ctx.font = font; return ctx.measureText(text).width; }
  const AGENT_FONT = '600 13px Inter, system-ui, sans-serif';
  const SUB_FONT = '11px Inter, system-ui, sans-serif';
  const TOOL_FONT = '600 11px Inter, system-ui, sans-serif';
  const DET_FONT = '10px "SF Mono", ui-monospace, Menlo, Consolas, monospace';
  const ACT_FONT = '600 10.5px Inter, system-ui, sans-serif';
  const BADGE_FONT = '600 9.5px Inter, system-ui, sans-serif';

  function agentColor(a) {
    if (a.type === 'user') return COLORS.user;
    if (a.type === 'orchestrator') return COLORS.orchestrator;
    if (a.type === 'skill') return COLORS.skill;
    const rec = nodes.get(a.id);
    if (rec && rec.paletteColor) return rec.paletteColor;
    return SUB_PALETTE[subColorIdx++ % SUB_PALETTE.length];
  }

  // ---------- graph in ----------
  function createNode(agent) {
    const color = agentColor(agent);
    return {
      id: agent.id, agent, color,
      paletteColor: agent.type === 'subagent' ? color : null,
      wx: 0, wy: 0, tx: 0, ty: 0, glow: 0, born: false,
      status: agent.status || 'idle',
    };
  }

  function setGraph(graph) {
    if (!graph || !graph.agents) return;
    for (const id in graph.agents) {
      const agent = graph.agents[id];
      let rec = nodes.get(id);
      if (!rec) { rec = createNode(agent); nodes.set(id, rec); }
      rec.agent = agent; rec.status = agent.status || 'idle';
    }
    for (const [id, rec] of nodes) { if (!graph.agents[id]) { rec.dead = true; } }
    edges.length = 0;
    (graph.edges || []).forEach((e) => edges.push({ from: e.from, to: e.to }));
    layout();
  }

  // ---------- tidy left→right layout over agents ----------
  function layout() {
    const live = [...nodes.values()].filter((n) => !n.dead);
    if (!live.length) return;
    const byId = new Map(live.map((n) => [n.id, n]));
    const children = new Map();
    for (const n of live) {
      const p = n.agent.parentId;
      if (p && byId.has(p)) { if (!children.has(p)) children.set(p, []); children.get(p).push(n.id); }
    }
    const depth = (id) => {
      let d = 0, cur = byId.get(id);
      const seen = new Set();
      while (cur && cur.agent.parentId && byId.has(cur.agent.parentId) && !seen.has(cur.id)) {
        seen.add(cur.id); d++; cur = byId.get(cur.agent.parentId);
      }
      return d;
    };
    const roots = live.filter((n) => !n.agent.parentId || !byId.has(n.agent.parentId)).map((n) => n.id);

    let leaf = 0;
    const rowOf = new Map();
    const assign = (id, seen) => {
      if (seen.has(id)) return;
      seen.add(id);
      const kids = children.get(id) || [];
      if (!kids.length) { rowOf.set(id, leaf++); return; }
      kids.forEach((k) => assign(k, seen));
      const rows = kids.map((k) => rowOf.get(k)).filter((r) => r != null);
      rowOf.set(id, rows.reduce((a, b) => a + b, 0) / rows.length);
    };
    const seen = new Set();
    roots.forEach((r) => assign(r, seen));

    const maxRow = Math.max(0, ...[...rowOf.values()]);
    for (const n of live) {
      n.tx = depth(n.id) * DX;
      n.ty = ((rowOf.get(n.id) ?? 0) - maxRow / 2) * DY;
      if (!n.born) { n.wx = n.tx; n.wy = n.ty; n.born = true; } // pop in place first time
    }
    refit();
  }

  // ---------- auto-fit ----------
  function contentBounds() {
    const pts = [];
    for (const n of nodes.values()) if (!n.dead) pts.push([n.tx, n.ty]);
    // tool chips extend to the right of their center — reserve room so the fit
    // keeps their (wide, two-line) body fully on-screen, clear of the log panel.
    for (const t of toolNodes.values()) { pts.push([t.tx, t.ty]); pts.push([t.tx + 150, t.ty]); }
    if (!pts.length) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
  }

  function refit() {
    if (userView) return;
    const b = contentBounds();
    if (!b) return;
    // Reserve room for the sessions panel (left) and interaction log (right) so
    // the graph — including tool chips that extend to the right of agents — stays
    // in the clear center gap. Collapse the reservations on narrow screens.
    const wide = W > 900;
    const padL = wide ? 300 : 40;
    const padR = wide ? 410 : 40;
    const padY = 120;
    const availW = Math.max(140, W - padL - padR);
    const availH = Math.max(140, H - padY * 2);
    let s = Math.min(b.w ? availW / b.w : 2, b.h ? availH / b.h : 2);
    s = Math.max(0.4, Math.min(1.12, s || 1));
    target.scale = s;
    target.ox = padL + availW / 2 - b.cx * s;
    target.oy = H / 2 - b.cy * s;
  }

  function fit() { userView = false; refit(); }

  const sx = (wx) => wx * view.scale + view.ox;
  const sy = (wy) => wy * view.scale + view.oy;

  // ---------- messages / flows ----------
  function nodeScreen(id) {
    const n = nodes.get(id); if (n) return { x: sx(n.wx), y: sy(n.wy), node: n };
    const t = toolNodes.get(id); if (t) return { x: sx(t.wx), y: sy(t.wy), tool: t };
    return null;
  }

  function beam(fromId, toId, type, color) {
    const c = color || flowColor(type);
    if (fromId === toId || !nodeScreen(fromId) || !nodeScreen(toId)) { pulse(toId || fromId); return; }
    flows.push({ from: fromId, to: toId, t: 0, dur: 780, color: c, onArrive: () => pulse(toId) });
  }

  function flowColor(type) {
    if (type === 'agent_spawn') return COLORS.subagent;
    if (type === 'message') return COLORS.user;
    if (type === 'agent_error') return COLORS.error;
    if (type === 'agent_done' || type === 'tool_result') return RESPONSE;
    return COLORS.tool;
  }

  function pulse(id) {
    const n = nodes.get(id); if (n) { n.glow = 1; return; }
    const t = toolNodes.get(id); if (t) t.glow = 1;
  }

  // ---------- tool / skill / mcp chips ----------
  function toolCall(ownerId, callId, kind, label, detail) {
    if (toolNodes.has(callId)) return;
    const owner = nodes.get(ownerId);
    if (!owner) return;
    toolCallsTotal++;
    let slot = 0;
    for (const t of toolNodes.values()) if (t.ownerId === ownerId && t.status === 'active') slot++;
    const t = {
      callId, ownerId, kind: kind || 'tool', label: label || kind || 'tool', detail: detail || '',
      slot, status: 'active', glow: 1, scale: 0, expireAt: 0,
      wx: owner.wx + TOOL_DX, wy: owner.wy + slot * TOOL_DY, tx: 0, ty: 0,
    };
    toolNodes.set(callId, t);
    // live activity line on the calling agent — "▸ Bash · npm test"
    owner.activity = { label: t.label, detail: t.detail, kind: t.kind, done: false, at: performance.now() };
    flows.push({ from: ownerId, to: callId, t: 0, dur: 620, color: COLORS[t.kind] || COLORS.tool, onArrive: () => { t.glow = 1; } });
    refit();
  }

  function toolReturn(callId, ownerId, result, error) {
    const t = toolNodes.get(callId);
    const owner = nodes.get(ownerId);
    if (owner) {
      // "✓ Bash → 42 passing" (or "✗ …" on failure) — keep it visible so the agent never looks idle
      owner.activity = {
        label: t ? t.label : (owner.activity && owner.activity.label) || 'tool',
        detail: result || '', kind: t ? t.kind : 'tool', done: true, error: !!error, at: performance.now(),
      };
    }
    if (!t) { pulse(ownerId); return; }
    if (result) t.result = result;
    t.error = !!error;
    flows.push({ from: callId, to: ownerId, t: 0, dur: 620, color: error ? COLORS.error : RESPONSE, onArrive: () => pulse(ownerId) });
    t.status = 'done';
    t.expireAt = performance.now() + (error ? 4200 : 2600); // failures linger longer to read
  }

  // ---------- interaction: pan / zoom / hover ----------
  let dragging = false, lastX = 0, lastY = 0, moved = 0;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', (e) => { dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ } });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 3) { userView = true; view.ox += dx; view.oy += dy; target.ox = view.ox; target.oy = view.oy; target.scale = view.scale; }
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    userView = true;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const ns = Math.max(0.25, Math.min(2.4, view.scale * factor));
    // zoom around cursor
    view.ox = mx - (mx - view.ox) * (ns / view.scale);
    view.oy = my - (my - view.oy) * (ns / view.scale);
    view.scale = ns;
    target.scale = view.scale; target.ox = view.ox; target.oy = view.oy;
  }, { passive: false });

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    for (const n of nodes.values()) {
      if (n.dead) continue;
      const m = n._metrics; if (!m) continue;
      if (px >= m.x && px <= m.x + m.w && py >= m.y && py <= m.y + m.h) return n.agent;
    }
    return null;
  }

  // ---------- drawing ----------
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function curve(a, b) {
    // horizontal S-curve control points
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5) * Math.sign(b.x - a.x || 1);
    return { p0: a, c1: { x: a.x + dx, y: a.y }, c2: { x: b.x - dx, y: b.y }, p1: b };
  }
  function bez(c, t) {
    const u = 1 - t;
    return {
      x: u * u * u * c.p0.x + 3 * u * u * t * c.c1.x + 3 * u * t * t * c.c2.x + t * t * t * c.p1.x,
      y: u * u * u * c.p0.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t * t * t * c.p1.y,
    };
  }

  function drawEdge(a, b, flash) {
    const c = curve(a, b);
    ctx.beginPath();
    ctx.moveTo(c.p0.x, c.p0.y);
    ctx.bezierCurveTo(c.c1.x, c.c1.y, c.c2.x, c.c2.y, c.p1.x, c.p1.y);
    ctx.strokeStyle = flash ? 'rgba(150,175,255,0.55)' : 'rgba(90,105,160,0.30)';
    ctx.lineWidth = flash ? 2 : 1.25;
    ctx.stroke();
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;

    // ease view
    view.scale += (target.scale - view.scale) * Math.min(1, dt * 6);
    view.ox += (target.ox - view.ox) * Math.min(1, dt * 6);
    view.oy += (target.oy - view.oy) * Math.min(1, dt * 6);

    // ease node positions
    for (const [id, n] of nodes) {
      if (n.dead) { n.glow *= 0.9; if (n.glow < 0.02) nodes.delete(id); continue; }
      n.wx += (n.tx - n.wx) * Math.min(1, dt * 7);
      n.wy += (n.ty - n.wy) * Math.min(1, dt * 7);
      n.glow = Math.max(n.status === 'active' ? 0.35 : 0, n.glow - dt * 1.6);
    }
    // tool chip positions follow owner
    for (const [callId, t] of toolNodes) {
      const owner = nodes.get(t.ownerId);
      if (!owner) { toolNodes.delete(callId); continue; }
      t.tx = owner.wx + TOOL_DX; t.ty = owner.wy + t.slot * TOOL_DY;
      t.wx += (t.tx - t.wx) * Math.min(1, dt * 7);
      t.wy += (t.ty - t.wy) * Math.min(1, dt * 7);
      const expiring = t.status === 'done' && performance.now() > t.expireAt;
      t.scale += ((expiring ? 0 : 1) - t.scale) * Math.min(1, dt * 6);
      t.glow = Math.max(0, t.glow - dt * 1.6);
      if (expiring && t.scale < 0.04) toolNodes.delete(callId);
    }

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#05060c';
    ctx.fillRect(0, 0, W, H);
    drawGrid();

    // which edges are "flowing" right now (for subtle flash)
    const flowing = new Set(flows.map((f) => `${f.from}|${f.to}`));

    // edges: agent → agent
    for (const e of edges) {
      const a = nodeScreen(e.from), b = nodeScreen(e.to);
      if (a && b) drawEdge(edgeAnchor(a, b, 'from'), edgeAnchor(a, b, 'to'), flowing.has(`${e.from}|${e.to}`) || flowing.has(`${e.to}|${e.from}`));
    }
    // edges: owner → active tool
    for (const t of toolNodes.values()) {
      const a = nodeScreen(t.ownerId), b = nodeScreen(t.callId);
      if (a && b) {
        ctx.globalAlpha = Math.max(0.15, t.scale);
        drawEdge(edgeAnchor(a, b, 'from'), edgeAnchor(a, b, 'to'), flowing.has(`${t.ownerId}|${t.callId}`) || flowing.has(`${t.callId}|${t.ownerId}`));
        ctx.globalAlpha = 1;
      }
    }

    // flows
    for (let i = flows.length - 1; i >= 0; i--) {
      const f = flows[i];
      f.t += dt * 1000 / f.dur;
      const a = nodeScreen(f.from), b = nodeScreen(f.to);
      if (!a || !b) { flows.splice(i, 1); continue; }
      if (f.t >= 1) { flows.splice(i, 1); if (f.onArrive) f.onArrive(); continue; }
      const c = curve(edgeAnchor(a, b, 'from'), edgeAnchor(a, b, 'to'));
      drawFlow(c, f);
    }

    // nodes on top
    for (const t of toolNodes.values()) drawToolChip(t);
    for (const n of nodes.values()) if (!n.dead) drawAgent(n);

    raf = requestAnimationFrame(frame);
  }

  function edgeAnchor(a, b, which) {
    const self = which === 'from' ? a : b;
    const other = which === 'from' ? b : a;
    const m = self.node ? self.node._metrics : (self.tool ? self.tool._metrics : null);
    const cx = self.x, cy = self.y;
    if (!m) return { x: cx, y: cy };
    const halfW = m.w / 2;
    // exit from the horizontal side facing the other node
    const dir = Math.sign(other.x - self.x) || 1;
    return { x: cx + dir * halfW, y: cy };
  }

  function drawGrid() {
    ctx.save();
    ctx.strokeStyle = 'rgba(120,140,200,0.05)';
    ctx.lineWidth = 1;
    const step = 44 * view.scale;
    if (step > 14) {
      const ox = view.ox % step, oy = view.oy % step;
      ctx.beginPath();
      for (let x = ox; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let y = oy; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFlow(c, f) {
    // short comet with a soft trail
    for (let k = 0; k < 6; k++) {
      const tt = Math.max(0, f.t - k * 0.045);
      const p = bez(c, tt);
      const alpha = (1 - k / 6) * (0.9 - Math.abs(0.5 - f.t) * 0.3);
      const r = 4.5 - k * 0.5;
      ctx.beginPath();
      ctx.fillStyle = hexA(f.color, alpha * 0.9);
      ctx.arc(p.x, p.y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    }
    const head = bez(c, f.t);
    ctx.beginPath();
    ctx.fillStyle = hexA(f.color, 0.28);
    ctx.arc(head.x, head.y, 9, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawAgent(n) {
    const x = sx(n.wx), y = sy(n.wy);
    const rawName = n.agent.name || n.id;
    // skills read as skills: a ◆ marker prefixes the label (dot/border already
    // render in the skill color via agentColor).
    const name = n.agent.type === 'skill' ? `◆ ${rawName}` : rawName;
    const isBig = n.agent.type === 'orchestrator';
    ctx.font = AGENT_FONT;
    const tw = measure(name, AGENT_FONT);
    const w = Math.min(230, Math.max(96, tw + 46));
    const h = isBig ? 46 : 40;
    const rx = x - w / 2, ry = y - h / 2;
    n._metrics = { x: rx, y: ry, w, h };

    // active glow
    if (n.glow > 0.02) {
      ctx.save();
      ctx.shadowColor = hexA(n.color, 0.9);
      ctx.shadowBlur = 22 * n.glow;
      roundRect(rx, ry, w, h, 11); ctx.fillStyle = 'rgba(0,0,0,0.01)'; ctx.fill();
      ctx.restore();
    }
    // chip
    roundRect(rx, ry, w, h, 11);
    const g = ctx.createLinearGradient(rx, ry, rx, ry + h);
    g.addColorStop(0, 'rgba(24,30,50,0.96)'); g.addColorStop(1, 'rgba(14,18,32,0.96)');
    ctx.fillStyle = g; ctx.fill();
    const borderCol = n.status === 'error' ? COLORS.error : n.color;
    ctx.lineWidth = n.status === 'error' ? 2 : 1.5;
    ctx.strokeStyle = hexA(borderCol, n.status === 'active' || n.status === 'error' ? 0.9 : 0.5); ctx.stroke();

    // status/type dot
    ctx.beginPath(); ctx.fillStyle = n.status === 'error' ? COLORS.error : n.color; ctx.arc(rx + 15, y, 5.5, 0, Math.PI * 2); ctx.fill();
    if (n.status === 'active') { ctx.beginPath(); ctx.strokeStyle = hexA(COLORS.active, 0.9); ctx.lineWidth = 1.5; ctx.arc(rx + 15, y, 8.5, 0, Math.PI * 2); ctx.stroke(); }

    // label
    ctx.fillStyle = '#eef1ff'; ctx.font = AGENT_FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(clip(name, w - 40, AGENT_FONT), rx + 27, y + 0.5);

    // tool-count badge (top-right of chip)
    const tc = n.agent.toolCount || 0;
    if (tc > 0) {
      const bt = `${tc}⚙`;
      ctx.font = BADGE_FONT;
      const bw = measure(bt, BADGE_FONT) + 10;
      const bx = rx + w - bw + 2, by = ry - 7;
      roundRect(bx, by, bw, 15, 7); ctx.fillStyle = 'rgba(111,168,255,0.18)'; ctx.fill();
      ctx.strokeStyle = 'rgba(111,168,255,0.4)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#9fc2ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(bt, bx + bw / 2, by + 8);
    }

    // ---- activity line under the chip: what this agent is doing right now ----
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const act = n.activity;
    // active but not mid-tool → the model is generating/thinking (no hook fires
    // for that), so show a live cycling status instead of looking idle.
    const thinking = n.status === 'active' && (!act || (act.done && !act.error));
    if (thinking) {
      const word = THINK_WORDS[Math.floor(performance.now() / 1400) % THINK_WORDS.length];
      ctx.font = ACT_FONT; ctx.fillStyle = hexA(COLORS.active, 0.6 + 0.4 * Math.abs(Math.sin(performance.now() / 500)));
      ctx.fillText(`◇ ${word}…`, x, ry + h + 12);
    } else if (act) {
      const icon = act.error ? '✗' : (act.done ? '✓' : '▸');
      const col = act.error ? COLORS.error : (act.done ? '#7fd6b0' : COLORS.active);
      const detail = act.detail ? '  ' + act.detail : '';
      const line = clip(`${icon} ${act.label}${detail}`, 240, ACT_FONT);
      ctx.font = ACT_FONT; ctx.fillStyle = hexA(col, act.done && !act.error ? 0.85 : 1);
      ctx.fillText(line, x, ry + h + 12);
    } else {
      ctx.font = SUB_FONT; ctx.fillStyle = hexA('#9aa3c8', 0.9);
      ctx.fillText(n.agent.type === 'subagent' ? n.status : n.agent.type, x, ry + h + 11);
    }
  }

  function drawToolChip(t) {
    if (t.scale < 0.02) return;
    const x = sx(t.wx), y = sy(t.wy);
    const col = t.error ? COLORS.error : (COLORS[t.kind] || COLORS.tool);
    const name = `${t.error ? '✗' : (KIND_ICON[t.kind] || '⚙')} ${t.label}`;
    // second line: while running show the call detail; after return show the result
    const detailRaw = t.status === 'done' && t.result ? `→ ${t.result}` : t.detail;
    const nameW = measure(name, TOOL_FONT);
    const detailShown = detailRaw ? clip(detailRaw, 210, DET_FONT) : '';
    const detW = detailShown ? measure(detailShown, DET_FONT) : 0;
    const w = Math.min(240, Math.max(64, Math.max(nameW, detW) + 20));
    const h = detailShown ? 38 : 24;
    const rx = x - w / 2, ry = y - h / 2;
    t._metrics = { x: rx, y: ry, w, h };

    ctx.globalAlpha = Math.min(1, t.scale + 0.1);
    if (t.glow > 0.02) { ctx.save(); ctx.shadowColor = hexA(col, 0.9); ctx.shadowBlur = 16 * t.glow; roundRect(rx, ry, w, h, 8); ctx.fillStyle = 'rgba(0,0,0,0.01)'; ctx.fill(); ctx.restore(); }
    roundRect(rx, ry, w, h, 8);
    ctx.fillStyle = 'rgba(16,20,34,0.96)'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = hexA(col, t.status === 'active' ? 0.85 : 0.4); ctx.stroke();

    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    if (detailShown) {
      ctx.font = TOOL_FONT; ctx.fillStyle = hexA(col, 0.95);
      ctx.fillText(name, rx + 10, ry + 12);
      const detCol = t.error ? COLORS.error : (t.status === 'done' ? '#7fd6b0' : '#c3cbe8');
      ctx.font = DET_FONT; ctx.fillStyle = hexA(detCol, 0.92);
      ctx.fillText(detailShown, rx + 10, ry + 27);
    } else {
      ctx.font = TOOL_FONT; ctx.fillStyle = hexA('#dfe6ff', 0.96); ctx.textAlign = 'center';
      ctx.fillText(name, x, y + 0.5);
    }
    ctx.globalAlpha = 1;
  }

  function clip(text, maxW, font) {
    if (measure(text, font) <= maxW) return text;
    let s = text;
    while (s.length > 1 && measure(s + '…', font) > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  // ---------- lifecycle ----------
  function reset() {
    nodes.clear(); edges.length = 0; toolNodes.clear(); flows.length = 0;
    subColorIdx = 0; userView = false;
    view.scale = target.scale = 1; view.ox = target.ox = W / 2; view.oy = target.oy = H / 2;
  }

  let raf = requestAnimationFrame(frame);

  return {
    setGraph, beam, pulse, toolCall, toolReturn, reset, pick, fit,
    setAutoRotate() { /* no-op in 2D */ },
    get nodeCount() { return [...nodes.values()].filter((n) => !n.dead).length; },
    get toolCount() { return toolCallsTotal; },
    dispose() { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); },
  };
}

// #rrggbb + alpha → rgba()
function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}
