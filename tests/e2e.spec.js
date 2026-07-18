import { test, expect } from '@playwright/test';

// End-to-end coverage of the whole pipeline:
//   server (demo loop) → WebSocket → normalizer graph → 2D graph + log panel.

test.describe('ClaudeLens', () => {
  test('loads the app shell with a 2D canvas and no page errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await expect(page).toHaveTitle(/ClaudeLens/);
    await expect(page.locator('#topbar h1')).toHaveText('ClaudeLens');

    // 2D canvas context must exist on the scene canvas.
    const has2d = await page.evaluate(() => !!document.getElementById('scene').getContext('2d'));
    expect(has2d).toBe(true);

    // module scripts loaded cleanly
    expect(errors, 'no console/page errors: ' + errors.join(' | ')).toHaveLength(0);
  });

  test('connects live over WebSocket', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'live', { timeout: 10000 });
    await expect(page.locator('#status-text')).toHaveText('live');
  });

  test('demo stream builds the agent graph (nodes appear)', async ({ page }) => {
    await page.goto('/');
    // The scene should acquire several nodes (user + orchestrator + subagents).
    await expect.poll(
      () => page.evaluate(() => window.__agentviz && window.__agentviz.nodes),
      { timeout: 15000, message: 'expected scene to gain agent nodes' }
    ).toBeGreaterThan(2);
  });

  test('interaction log fills with normalized events and stats update', async ({ page }) => {
    await page.goto('/');
    const rows = page.locator('#log li');
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBeGreaterThan(3);

    // stats reflect the same stream
    await expect.poll(
      () => page.locator('#stat-agents').innerText(),
      { timeout: 15000 }
    ).not.toBe('0');
    await expect.poll(() => page.locator('#stat-events').innerText()).not.toBe('0');

    // a subagent dispatch should show up as an "agent spawn" row
    await expect(page.locator('#log li.type-agent_spawn').first()).toBeVisible({ timeout: 15000 });
  });

  test('log filter narrows the visible rows (read-only control)', async ({ page }) => {
    await page.goto('/');
    const rows = page.locator('#log li');
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBeGreaterThan(5);

    const before = await rows.count();
    await page.locator('#log-filter').fill('zzz-no-such-token-zzz');
    // all rows filtered out → none visible
    await expect.poll(() => page.locator('#log li:visible').count(), { timeout: 5000 }).toBe(0);

    await page.locator('#log-filter').fill('');
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(before);
  });

  test('server health endpoint reports demo mode', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.demo).toBe(true);
    expect(body.sessions).toBeGreaterThanOrEqual(0);
  });

  test('tracks multiple concurrent sessions and exposes them via /api/sessions', async ({ request }) => {
    await expect.poll(async () => {
      const res = await request.get('/api/sessions');
      const body = await res.json();
      return body.sessions.length;
    }, { timeout: 15000, message: 'expected several demo sessions' }).toBeGreaterThanOrEqual(2);

    const body = await (await request.get('/api/sessions')).json();
    const s = body.sessions[0];
    expect(s).toHaveProperty('id');
    expect(s).toHaveProperty('label');
    expect(s).toHaveProperty('agents');
    expect(s).toHaveProperty('status');
  });

  test('session picker lists sessions and can switch between them', async ({ page }) => {
    await page.goto('/');
    const cards = page.locator('#sessions .session-card');
    await expect.poll(() => cards.count(), { timeout: 15000 }).toBeGreaterThanOrEqual(2);

    // a session auto-selects on load
    await expect.poll(() => page.evaluate(() => window.__agentviz.session)).not.toBeNull();
    const first = await page.evaluate(() => window.__agentviz.session);

    // switch to a session that is NOT the currently-selected one
    const other = page.locator('#sessions .session-card:not(.selected)').first();
    await other.click();
    await expect.poll(
      () => page.evaluate(() => window.__agentviz.session),
      { timeout: 8000 }
    ).not.toBe(first);

    // exactly one card shows as selected
    await expect.poll(() => page.locator('#sessions .session-card.selected').count()).toBe(1);
  });

  test('tool / skill / mcp calls animate as transient nodes', async ({ page, request }) => {
    // Drive this deterministically rather than waiting for the demo loop to
    // happen to fire a tool call on whichever session auto-selected — that race
    // made this test flaky under load (it depends on demo timing, not the code
    // under test). We ingest a known tool/skill/mcp burst, then view that session.
    const sid = 'tool-anim-e2e';
    const post = (p) => request.post('/ingest', { data: { session_id: sid, ...p } });

    // Create the session first so it can be selected...
    await post({ hook_event_name: 'SessionStart', cwd: '/repo/tool-anim' });

    await page.goto('/');
    await expect.poll(() => page.evaluate(() => window.__agentviz.state), { timeout: 10000 }).toBe('live');
    await page.evaluate((id) => window.__agentviz.selectSession(id), sid);
    await expect.poll(() => page.evaluate(() => window.__agentviz.session), { timeout: 8000 }).toBe(sid);

    // ...then fire the tool calls while the page is watching. Transient nodes are
    // animated from LIVE events arriving over the socket; selecting a session
    // rebuilds from a snapshot and does not re-animate history.
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_use_id: 'a1', tool_input: { pattern: '**/*.ts' } });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_use_id: 'a2', tool_input: { skill: 'code-review' } });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'mcp__sonarqube__show_rule', tool_use_id: 'a3', tool_input: {} });

    // the scene registers the tool calls as transient nodes
    await expect.poll(
      () => page.evaluate(() => window.__agentviz.tools),
      { timeout: 15000, message: 'expected transient tool-call nodes to appear' }
    ).toBeGreaterThan(0);

    // and the log shows tool activity rows
    await expect(page.locator('#log li.type-tool_use').first()).toBeVisible({ timeout: 15000 });
  });

  test('sessions show the model in use and token usage', async ({ page }) => {
    await page.goto('/');
    // a session card should surface a model badge (demo stamps opus/sonnet/haiku)
    await expect.poll(
      () => page.locator('#sessions .model-badge').first().innerText().catch(() => ''),
      { timeout: 15000 }
    ).not.toBe('');

    // the HUD tokens tile should move off zero for the selected session
    await expect.poll(() => page.locator('#stat-tokens').innerText(), { timeout: 15000 }).not.toBe('0');

    // the model pill in the top bar becomes visible
    await expect(page.locator('#model-pill')).toBeVisible({ timeout: 15000 });
  });

  test('session labels use the project folder, not "session <id>"', async ({ request }) => {
    await expect.poll(async () => {
      const body = await (await request.get('/api/sessions')).json();
      return body.sessions.map((s) => s.label);
    }, { timeout: 15000 }).toContain('payments-api');
  });

  test('SDK apps: /ingest/sdk translates Agent SDK messages into a session', async ({ request }) => {
    const sid = 'sdk-e2e-1';
    const send = (message) => request.post('/ingest/sdk', { data: { session_id: sid, label: 'my-sdk-app', cwd: '/srv/my-sdk-app', message } });

    await send({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' });
    await send({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 50000 }, content: [{ type: 'tool_use', id: 'tu_1', name: 'Grep', input: { pattern: 'TODO' } }] } });
    await send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '7 matches' }] } });
    await send({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 1500, output_tokens: 120 }, content: [{ type: 'tool_use', id: 'tu_2', name: 'Task', input: { subagent_type: 'researcher', description: 'dig in' } }] } });
    await send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'done' }] } });

    const body = await (await request.get('/api/sessions')).json();
    const s = body.sessions.find((x) => x.id === sid);
    expect(s, 'SDK session should exist').toBeTruthy();
    expect(s.label).toBe('my-sdk-app');       // custom label
    expect(s.model).toBe('claude-sonnet-5');   // model captured from SDK
    expect(s.agents).toBeGreaterThanOrEqual(2); // orchestrator + researcher subagent
    expect(s.usage.output).toBe(460);          // 340 + 120 accumulated
    expect(s.usage.input).toBe(1500);          // latest context, not clobbered to 0
  });

  test('sessions render into active/inactive/done sections; panels collapse', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.sess-section[data-status="active"]')).toBeVisible({ timeout: 15000 });
    // at least one card lands in a section list
    await expect.poll(() => page.locator('.sess-list .session-card').count(), { timeout: 15000 }).toBeGreaterThan(0);
    // collapse the sessions panel
    await page.locator('.panel-collapse[data-target="sessions"]').click();
    await expect(page.locator('#sessions')).toHaveClass(/collapsed/);
    await expect(page.locator('.sessions-body')).toBeHidden();
  });

  test('clicking a node opens the inspector; clicking empty canvas closes it', async ({ page }) => {
    await page.goto('/');
    // wait for the demo graph to build
    await expect.poll(
      () => page.evaluate(() => window.__agentviz && window.__agentviz.nodes),
      { timeout: 15000, message: 'expected scene to gain agent nodes' }
    ).toBeGreaterThan(2);
    // let the auto-fit view settle so node hit-boxes are stable
    await page.waitForTimeout(600);

    const canvas = page.locator('#scene');
    const box = await canvas.boundingBox();

    // Sweep a grid of points across the central band of the canvas (clear of the
    // sessions/log panels) via REAL mouse clicks until one lands on a node.
    let opened = null;
    outer:
    for (let fy = 0.30; fy <= 0.70; fy += 0.05) {
      for (let fx = 0.34; fx <= 0.70; fx += 0.03) {
        await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
        const got = await page.evaluate(() => window.__agentviz.inspectedAgent);
        if (got) { opened = got; break outer; }
      }
    }
    expect(opened, 'a canvas click should have opened the inspector on a node').toBeTruthy();

    // inspector is visible and shows the selected agent + at least one event row
    await expect(page.locator('#inspector')).toBeVisible();
    await expect(page.locator('#inspector #insp-name')).not.toHaveText('—');
    await expect.poll(
      () => page.locator('#inspector .insp-ev').count(),
      { timeout: 8000, message: 'expected the inspected agent to have event rows' }
    ).toBeGreaterThan(0);

    // clicking empty canvas (very top-center strip — the stats/topbar there are
    // pointer-events:none, and it sits above the task boxes) closes the inspector
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.04);
    await expect.poll(() => page.evaluate(() => window.__agentviz.inspectedAgent)).toBeNull();
    await expect(page.locator('#inspector')).toBeHidden();
  });

  test('inspector opens via the test hook and renders agent details + event rows', async ({ page }) => {
    await page.goto('/');
    await expect.poll(
      () => page.evaluate(() => window.__agentviz && window.__agentviz.nodes),
      { timeout: 15000 }
    ).toBeGreaterThan(2);

    // Find an agent that actually has buffered events, then open it via the hook
    // (the SAME open path a real canvas click uses).
    const target = await page.evaluate(() => {
      const av = window.__agentviz;
      for (const id of av.agentIds) { av.openInspector(id); if (av.inspectedAgent === id) return id; }
      return null;
    });
    expect(target, 'expected to open an agent via the inspector hook').toBeTruthy();

    await expect.poll(() => page.evaluate(() => window.__agentviz.inspectedAgent)).toBe(target);
    await expect(page.locator('#inspector')).toBeVisible();
    // meta grid shows type/status/parent/tools
    await expect(page.locator('#inspector .insp-meta .k')).toHaveCount(4);

    // switching sessions clears the selection and hides the inspector
    const other = page.locator('#sessions .session-card:not(.selected)').first();
    if (await other.count()) {
      await other.click();
      await expect.poll(() => page.evaluate(() => window.__agentviz.inspectedAgent)).toBeNull();
      await expect(page.locator('#inspector')).toBeHidden();
    }
  });

  test('clear removes idle/ended sessions and rejects active', async ({ request }) => {
    // create a session and end it → status 'ended'
    await request.post('/ingest', { data: { session_id: 'clr-1', hook_event_name: 'SessionStart', cwd: '/z' } });
    await request.post('/ingest', { data: { session_id: 'clr-1', hook_event_name: 'SessionEnd' } });
    let body = await (await request.get('/api/sessions')).json();
    expect(body.sessions.some((s) => s.id === 'clr-1' && s.status === 'ended')).toBe(true);
    // active cannot be cleared
    const bad = await request.post('/api/sessions/clear', { data: { status: 'active' } });
    expect(bad.status()).toBe(400);
    // clearing 'ended' removes it
    const ok = await request.post('/api/sessions/clear', { data: { status: 'ended' } });
    expect(ok.ok()).toBeTruthy();
    body = await (await request.get('/api/sessions')).json();
    expect(body.sessions.some((s) => s.id === 'clr-1')).toBe(false);
  });

  test('tool results report durations', async ({ request }) => {
    // Pre→Post timing yields a positive duration on tool_result events (demo is live)
    await expect.poll(async () => {
      const snap = await (await request.get('/api/snapshot')).json();
      return snap.events.filter((e) => e.type === 'tool_result' && typeof e.durationMs === 'number' && e.durationMs > 0).length;
    }, { timeout: 20000, message: 'expected tool results with durations' }).toBeGreaterThan(0);
  });

  test('errors are detected via /ingest (is_error and non-zero exit)', async ({ request }) => {
    const sid = 'err-e2e';
    const post = (p) => request.post('/ingest', { data: { session_id: sid, ...p } });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'e1' });
    await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'e1', tool_response: { exit_code: 2, stderr: 'boom' } });
    const body = await (await request.get('/api/sessions')).json();
    const s = body.sessions.find((x) => x.id === sid);
    expect(s.errors).toBeGreaterThan(0);
  });

  test('skill nesting: a Task spawned while a Skill is active nests under the skill node', async ({ request }) => {
    const sid = 'skl-nest';
    const post = (p) => request.post('/ingest', { data: { session_id: sid, ...p } });
    // Drive the pipeline deterministically (no reliance on live demo timing):
    // SessionStart → Skill → Task (subagent inside the skill) → Task done → Skill done.
    await post({ hook_event_name: 'SessionStart', cwd: '/repo/nest-demo' });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'security-review' } });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'cwe-classifier', description: 'classify findings' } });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'eval\\(' } });
    await post({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_response: { output: '2 matches' } });
    await post({ hook_event_name: 'PostToolUse', tool_name: 'Task', tool_response: { result: 'mapped to CWE-94' } });
    await post({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_response: { result: 'checklist loaded' } });

    const snap = await (await request.get(`/api/snapshot?session=${sid}`)).json();
    const agents = Object.values(snap.graph.agents);

    // 1) the skill is now a graph node
    const skill = agents.find((a) => a.type === 'skill');
    expect(skill, 'expected a skill graph node').toBeTruthy();

    // 2) the subagent it spawned nests UNDER the skill (parentId === skill.id)
    const sub = agents.find((a) => a.type === 'subagent' && a.parentId === skill.id);
    expect(sub, 'expected a subagent whose parentId is the skill node').toBeTruthy();

    // and an edge skill → subagent records the relationship
    expect(snap.graph.edges.some((e) => e.from === skill.id && e.to === sub.id)).toBe(true);
  });

  test('PreCompact surfaces a prominent compact event (memory not silently dropped)', async ({ request }) => {
    const sid = 'compact-e2e';
    const post = (p) => request.post('/ingest', { data: { session_id: sid, ...p } });
    await post({ hook_event_name: 'SessionStart', cwd: '/repo/compact-demo' });
    await post({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: 'keep findings' });

    const snap = await (await request.get(`/api/snapshot?session=${sid}`)).json();
    const compact = snap.events.find((e) => e.type === 'compact');
    expect(compact, 'expected a compact event on the orchestrator').toBeTruthy();
    expect(compact.agentId).toBe('root');
    expect(compact.title.toLowerCase()).toContain('compacted');
    expect(compact.title).toContain('auto');
  });

  test('cacheHitPct is computed from token usage (pure math, no pricing)', async ({ request }) => {
    const sid = 'cache-e2e';
    await request.post('/ingest/sdk', {
      data: {
        session_id: sid, label: 'cache-app', cwd: '/srv/cache-app',
        message: {
          type: 'assistant',
          message: {
            role: 'assistant', model: 'claude-sonnet-5',
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
            content: [{ type: 'text', text: 'thinking' }],
          },
        },
      },
    });
    const body = await (await request.get('/api/sessions')).json();
    const s = body.sessions.find((x) => x.id === sid);
    expect(s, 'SDK session should exist').toBeTruthy();
    expect(typeof s.cacheHitPct).toBe('number');
    // 3000 / (3000 + 1000 + 0) = 75%
    expect(s.cacheHitPct).toBe(75);
  });

  test('toolBreakdown counts each tool by display name', async ({ request }) => {
    const sid = 'breakdown-e2e';
    const post = (p) => request.post('/ingest', { data: { session_id: sid, ...p } });
    await post({ hook_event_name: 'SessionStart', cwd: '/repo/bd' });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' } });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'b.ts' } });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });

    const body = await (await request.get('/api/sessions')).json();
    const s = body.sessions.find((x) => x.id === sid);
    expect(s.toolBreakdown).toBeTruthy();
    expect(s.toolBreakdown.Read).toBe(2);
    expect(s.toolBreakdown.Bash).toBe(1);
  });

  test('retry detection: identical repeated tool call is flagged retry:true', async ({ request }) => {
    const sid = 'retry-e2e';
    const post = (p) => request.post('/ingest', { data: { session_id: sid, ...p } });
    await post({ hook_event_name: 'SessionStart', cwd: '/repo/retry' });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run lint' } });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run lint' } });

    const snap = await (await request.get(`/api/snapshot?session=${sid}`)).json();
    const uses = snap.events.filter((e) => e.type === 'tool_use');
    expect(uses.length).toBe(2);
    expect(uses[0].retry).toBeFalsy();      // first call is not a retry
    expect(uses[1].retry).toBe(true);       // identical repeat is flagged
  });

  test('timeline: scrubbing records history and replays an earlier state; LIVE resumes', async ({ page }) => {
    await page.goto('/');

    // let the demo accumulate a healthy event stream on the selected session
    await expect.poll(
      () => page.evaluate(() => window.__agentviz && window.__agentviz.events),
      { timeout: 20000, message: 'expected the demo to accumulate events' }
    ).toBeGreaterThan(8);

    // the timeline bar should be visible once there are events
    await expect(page.locator('#timeline')).toBeVisible({ timeout: 10000 });

    // snapshot the LIVE (leading-edge) state
    const endNodes = await page.evaluate(() => window.__agentviz.nodes);
    expect(endNodes).toBeGreaterThan(2);

    // scrub back to an early point → enters replay and rebuilds the earlier state
    await page.evaluate(() => window.__agentviz.scrubTo(2));
    await expect.poll(
      () => page.evaluate(() => window.__agentviz.timelineMode),
      { timeout: 8000 }
    ).toBe('replay');

    // the log reflects exactly the events up to the scrub index (index 2 → 3 rows)
    await expect.poll(() => page.locator('#log li').count(), { timeout: 8000 }).toBe(3);

    // and the reconstructed scene has fewer nodes than the full live graph
    await expect.poll(
      () => page.evaluate(() => window.__agentviz.nodes),
      { timeout: 8000, message: 'expected the replayed state to have fewer nodes' }
    ).toBeLessThan(endNodes);
    expect(await page.evaluate(() => window.__agentviz.timelineIndex)).toBe(2);

    // click LIVE → snap back to following the leading edge
    await page.locator('#tl-live').click();
    await expect.poll(
      () => page.evaluate(() => window.__agentviz.timelineMode),
      { timeout: 8000 }
    ).toBe('live');
    // the log is rebuilt to the full buffer (more rows than the replayed slice)
    await expect.poll(() => page.locator('#log li').count(), { timeout: 8000 }).toBeGreaterThan(3);
  });

  test('canvas task boxes group agents by status and navigate on click', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#taskboxes')).toBeVisible();
    await expect.poll(() => page.locator('#tb-completed .tb-item').count(), { timeout: 15000 }).toBeGreaterThan(0);
    await page.locator('#tb-completed .tb-item').first().click();
    await expect.poll(() => page.evaluate(() => window.__agentviz.inspectedAgent)).not.toBeNull();
  });

  test('viewing indicator shows which session is on the canvas', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#viewing-pill')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => page.locator('#viewing-name').innerText()).not.toBe('—');
  });

  test('combined canvas shows all sessions on one graph; a node drills in', async ({ page }) => {
    await page.goto('/');
    // single-session view first
    await expect.poll(() => page.evaluate(() => window.__agentviz.nodes), { timeout: 15000 }).toBeGreaterThan(2);
    const single = await page.evaluate(() => window.__agentviz.nodes);
    // enter combined mode → merged graph spans every session (more nodes than one)
    await page.locator('#overview-toggle').click();
    await expect.poll(() => page.evaluate(() => window.__agentviz.allMode)).toBe(true);
    await expect(page.locator('#timeline')).toBeHidden(); // per-session timeline hidden
    await expect.poll(
      () => page.evaluate(() => window.__agentviz.nodes),
      { timeout: 15000, message: 'merged canvas should have more nodes than one session' }
    ).toBeGreaterThan(single);
    // Escape returns to a single session
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__agentviz.allMode)).toBe(false);
  });

  test('temp/default sessions are hidden from the picker', async ({ page, request }) => {
    await page.goto('/');
    await expect.poll(() => page.locator('#sessions .session-card').count(), { timeout: 15000 }).toBeGreaterThan(0);
    await request.post('/ingest', { data: { session_id: 'default', hook_event_name: 'SessionStart' } });
    await expect.poll(async () => {
      const b = await (await request.get('/api/sessions')).json();
      return b.sessions.some((s) => s.id === 'default');
    }, { timeout: 8000 }).toBe(true); // exists server-side
    await page.waitForTimeout(500);
    const labels = await page.locator('#sessions .session-card .sc-label').allInnerTexts();
    expect(labels.some((l) => l.includes('defaul'))).toBe(false); // but not rendered
  });

  test('token units scale to K / M / B', async ({ page, request }) => {
    await request.post('/ingest/sdk', { data: { session_id: 'big-tok', label: 'big-tokens', message: { type: 'system', subtype: 'init', model: 'claude-opus-4-8' } } });
    await request.post('/ingest/sdk', { data: { session_id: 'big-tok', message: { type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 1200000000, output_tokens: 500000000, cache_read_input_tokens: 800000000 } } } } });
    await page.goto('/');
    // the big-tokens session card should render its total in billions
    const card = page.locator('#sessions .session-card', { hasText: 'big-tokens' });
    await expect.poll(() => card.count(), { timeout: 12000 }).toBeGreaterThan(0);
    await expect(card.first().locator('.sc-tokens')).toContainText(/\dB\b/);
  });

  test('export downloads a session (and all sessions) as JSON', async ({ request }) => {
    const { sessions } = await (await request.get('/api/sessions')).json();
    const id = sessions[0].id;
    const one = await request.get('/api/export?session=' + encodeURIComponent(id));
    expect(one.ok()).toBeTruthy();
    expect(one.headers()['content-disposition']).toContain('attachment');
    const body = await one.json();
    expect(body.sessionId).toBe(id);
    expect(body).toHaveProperty('graph');
    expect(body).toHaveProperty('exportedAt');

    const all = await request.get('/api/export?all=1');
    expect(all.ok()).toBeTruthy();
    const ab = await all.json();
    expect(Array.isArray(ab.sessions)).toBe(true);
    expect(ab.sessions.length).toBeGreaterThan(0);
  });

  test('cross-session search returns matching events (API + overlay)', async ({ page, request }) => {
    await expect.poll(async () => {
      const r = await (await request.get('/api/search?q=grep&limit=20')).json();
      return r.count;
    }, { timeout: 15000, message: 'expected search hits for "grep"' }).toBeGreaterThan(0);

    await page.goto('/');
    await expect.poll(() => page.evaluate(() => window.__agentviz.events), { timeout: 15000 }).toBeGreaterThan(5);
    await page.locator('#search-btn').click();
    await expect(page.locator('#search')).toBeVisible();
    await page.locator('#search-input').fill('grep');
    await expect.poll(() => page.locator('#search-results .search-hit').count(), { timeout: 8000 }).toBeGreaterThan(0);
    await page.locator('#search-results .search-hit').first().click();
    await expect(page.locator('#search')).toBeHidden();
  });

  test('health reports uptime and memory', async ({ request }) => {
    const h = await (await request.get('/api/health')).json();
    expect(h.ok).toBe(true);
    expect(typeof h.uptimeSec).toBe('number');
    expect(h.memoryMB).toBeGreaterThan(0);
  });

  test('ingest endpoint accepts a raw hook payload and normalizes it', async ({ request }) => {
    const res = await request.post('/ingest', {
      data: { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'probe', description: 'e2e probe' } },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.produced).toBeGreaterThan(0);
  });
});
