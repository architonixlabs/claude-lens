// log.js — the read-only interaction log. Appends normalized events, supports a
// text filter and auto-scroll, and caps DOM size for long-running sessions.

const MAX_ROWS = 600;

export function initLog(root) {
  const listEl = root.querySelector('#log');
  const filterEl = root.querySelector('#log-filter');
  const autoBtn = root.querySelector('#log-autoscroll');
  const countEl = root.querySelector('#log-count');
  const statEvents = document.getElementById('stat-events');

  let filter = '';
  let autoscroll = true;
  let total = 0;

  filterEl.addEventListener('input', () => {
    filter = filterEl.value.trim().toLowerCase();
    for (const li of listEl.children) applyFilter(li);
  });
  autoBtn.addEventListener('click', () => {
    autoscroll = !autoscroll;
    autoBtn.classList.toggle('on', autoscroll);
    autoBtn.setAttribute('aria-pressed', String(autoscroll));
    if (autoscroll) listEl.scrollTop = listEl.scrollHeight;
  });

  function applyFilter(li) {
    if (!filter) { li.style.display = ''; return; }
    li.style.display = li.dataset.search.includes(filter) ? '' : 'none';
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, 2);
  }

  function add(ev) {
    const li = document.createElement('li');
    li.className = `type-${ev.type}` + (ev.error ? ' err' : '');
    const dur = ev.durationMs ? fmtDur(ev.durationMs) : '';
    const detail = (ev.detail || '') + (dur ? `  ·  ${dur}` : '');
    // retry marker is static markup (no user data) — safe to inline
    const retry = ev.retry ? ' <span class="retry-badge" title="repeated call">↻ retry</span>' : '';
    li.dataset.search = `${ev.title} ${detail} ${ev.agentName} ${ev.type}${ev.retry ? ' retry' : ''}`.toLowerCase();
    li.innerHTML = `
      <span class="log-bar"></span>
      <div class="log-body">
        <div class="log-title"><span><span class="type-tag">${short(ev.type)}</span> ${esc(ev.title)}${retry}</span><span class="t">${fmtTime(ev.ts)}</span></div>
        <div class="log-agent">${esc(ev.agentName || '')}</div>
        <div class="log-detail ${detail ? '' : 'empty'}">${esc(detail)}</div>
      </div>`;
    applyFilter(li);
    listEl.appendChild(li);
    while (listEl.children.length > MAX_ROWS) listEl.removeChild(listEl.firstChild);
    if (autoscroll) listEl.scrollTop = listEl.scrollHeight;
    total++;
    countEl.textContent = total;
    if (statEvents) statEvents.textContent = total;
  }

  function reset() {
    listEl.innerHTML = '';
    total = 0; countEl.textContent = '0';
    if (statEvents) statEvents.textContent = '0';
  }

  return { add, reset };
}

function fmtDur(ms) {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}
function short(type) { return String(type).replace(/_/g, ' '); }
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
