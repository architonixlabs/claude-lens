// redact.js — mask credentials before they are stored or exported.
//
// Hook payloads carry real command lines and tool output, which routinely
// contain API keys ("export SONAR_TOKEN=..."), bearer tokens, and private keys.
// Those were previously written to data/*.jsonl and included in /api/export in
// plaintext. We scrub at the ingest boundary so secrets never reach disk.
//
// This is defence-in-depth, not a guarantee — pattern matching cannot catch
// every secret shape. Treat data/ as sensitive regardless.
//
// Disable with AGENTVIZ_NO_REDACT=1 (e.g. when debugging the tool itself).

const MASK = '«redacted»';

// Ordered most-specific first. Each entry replaces the *secret* portion only,
// keeping surrounding context readable in the UI.
const PATTERNS = [
  // PEM private key blocks (multi-line) — collapse the whole body.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY-----${MASK}-----END PRIVATE KEY-----`],
  // Vendor-prefixed keys (Anthropic, OpenAI, GitHub, Slack, Stripe, ArxMail…).
  [/\b(sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|arx_sk_|arx_pk_|AIza|SG\.|rk_live_|sk_live_|pk_live_)[A-Za-z0-9_-]{8,}/g, (m) => m.slice(0, m.startsWith('github_pat_') ? 11 : 6) + MASK],
  // AWS access key ids.
  [/\bAKIA[0-9A-Z]{16}\b/g, `AKIA${MASK}`],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, `eyJ${MASK}`],
  // Authorization headers / bearer tokens.
  [/\b(bearer|authorization:\s*bearer)\s+[A-Za-z0-9._\-+/=]{12,}/gi, (m) => m.slice(0, m.toLowerCase().indexOf('bearer') + 6) + ' ' + MASK],
  // KEY=VALUE / KEY: VALUE where the key name looks secret. Keeps the name.
  [/\b([A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"'&;|]{4,})\3/gi,
    (_m, key, sep, q) => `${key}${sep}${q}${MASK}${q}`],
  // URLs carrying inline credentials: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s:/@]+)@/gi, (_m, scheme, user) => `${scheme}${user}:${MASK}@`],
];

export function redactString(s) {
  if (typeof s !== 'string' || s.length < 8) return s;
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

const MAX_DEPTH = 12;

// Deep-copy a payload with every string value scrubbed. Returns the input
// unchanged when redaction is off, so the hot path stays cheap.
export function redactPayload(value, depth = 0) {
  if (process.env.AGENTVIZ_NO_REDACT === '1') return value;
  return walk(value, depth);
}

function walk(value, depth) {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, depth + 1);
    return out;
  }
  return value; // numbers, booleans, null, undefined
}
