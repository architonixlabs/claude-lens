// ws.js — resilient WebSocket client. Reconnects with backoff, reports
// connection state, and can send control messages (e.g. subscribe to a session).
// Sends are queued until the socket is open. This is still read-only w.r.t. Claude
// — "subscribe" only selects which session view we receive.

export function connect({ onMessage, onState }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  let ws = null;
  let backoff = 500;
  let closedByUs = false;
  let queue = [];

  function flush() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      for (const m of queue) ws.send(JSON.stringify(m));
      queue = [];
    }
  }

  function open() {
    onState('connecting');
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      backoff = 500;
      onState('live');
      flush();
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    });
    ws.addEventListener('close', () => {
      if (closedByUs) return;
      onState('closed');
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 1.7, 8000);
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch { /* */ } });
  }

  open();
  return {
    send(msg) { queue.push(msg); flush(); },
    close() { closedByUs = true; if (ws) ws.close(); },
  };
}
