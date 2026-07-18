// scenario.js — scripted multi-agent runs expressed as raw Claude Code hook
// payloads. Feeding these through the SAME normalizer the live hooks use means
// the demo is a faithful rehearsal of real sessions, not a separate mock.
//
// Each step: { after: msMsAfterPrevious, payload: <raw hook payload> }

export const SCENARIO = [
  { after: 0,    payload: { hook_event_name: 'SessionStart', source: 'startup', cwd: '/repo/payments-api' } },
  { after: 500,  payload: { hook_event_name: 'UserPromptSubmit', prompt: 'Audit the codebase for security issues and propose fixes across the API, auth, and data layers.' } },

  // Orchestrator does a little work itself first
  { after: 700,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Glob',  tool_input: { pattern: '**/*.{ts,js}' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Glob',  tool_response: { output: '312 files' } } },

  // Invoke a skill. While it's active it dispatches its OWN subagent (a Task) —
  // that subagent and the skill's tool calls nest UNDER the skill node.
  { after: 450,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Skill', tool_input: { skill: 'security-review' } } },
  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Task',  tool_input: { subagent_type: 'cwe-classifier', description: 'Classify findings by CWE' } } },
  { after: 300,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Grep',  tool_input: { pattern: 'eval\\(|exec\\(' } } },
  { after: 450,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Grep',  tool_response: { output: '6 matches' } } },
  { after: 400,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Task',  tool_response: { result: 'Mapped to CWE-94 / CWE-89.' } } },
  { after: 600,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_response: { result: 'OWASP checklist loaded' } } },
  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'mcp__sonarqube__search_sonar_issues', tool_input: { project: 'payments-api' } } },
  { after: 700,  payload: { hook_event_name: 'PostToolUse', tool_name: 'mcp__sonarqube__search_sonar_issues', tool_response: { result: '18 open issues' } } },

  // Context window fills up mid-audit — Claude compacts it (visible, not silent).
  { after: 500,  payload: { hook_event_name: 'PreCompact', trigger: 'auto' } },

  // Fan out to three specialist subagents
  { after: 600,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Task',  tool_input: { subagent_type: 'api-auditor',  description: 'Audit API layer for injection & authz gaps' } } },
  { after: 300,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Grep',  tool_input: { pattern: 'req\\.(query|body|params)' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Grep',  tool_response: { output: '47 matches' } } },
  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Read',  tool_input: { file_path: 'src/api/routes/users.ts' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Read',  tool_response: { output: 'read 210 lines' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Task',  tool_response: { result: 'Found 3 unsanitized query params → SQL injection risk in users & orders routes.' } } },

  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Task',  tool_input: { subagent_type: 'auth-reviewer', description: 'Review authentication & session handling' } } },
  { after: 350,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Read',  tool_input: { file_path: 'src/auth/session.ts' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Read',  tool_response: { output: 'read 88 lines' } } },
  { after: 450,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Grep',  tool_input: { pattern: 'jwt|secret|token' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Grep',  tool_response: { output: '12 matches' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Task',  tool_response: { result: 'JWT secret hardcoded; sessions never expire. High severity.' } } },

  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Task',  tool_input: { subagent_type: 'data-layer-auditor', description: 'Audit DB access & migrations' } } },
  { after: 350,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Bash',  tool_input: { command: 'grep -rn "raw(" src/db' } } },
  { after: 600,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash',  tool_response: { stdout: '4 raw() calls' } } },
  { after: 500,  payload: { hook_event_name: 'SubagentStop' } },

  // Orchestrator synthesizes and dispatches a fixer
  { after: 500,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Task',  tool_input: { subagent_type: 'fix-writer', description: 'Draft patches for the 3 highest-severity findings' } } },
  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Write', tool_input: { file_path: 'src/api/routes/users.ts' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_response: { output: 'wrote 210 lines' } } },
  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Edit',  tool_input: { file_path: 'src/auth/session.ts' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Edit',  tool_response: { output: 'applied 1 edit' } } },
  // a failing tool call — surfaces in red + bumps the error count
  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Bash',  tool_input: { command: 'npm run lint' } } },
  { after: 800,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash',  tool_response: { exit_code: 1, stderr: '3 lint errors' } } },
  // same command re-run with no change → flagged as a retry (thrashing signal)
  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Bash',  tool_input: { command: 'npm run lint' } } },
  { after: 800,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash',  tool_response: { exit_code: 1, stderr: '3 lint errors' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Task',  tool_response: { result: 'Patched SQL injection + JWT expiry. Ready for review.' } } },

  { after: 500,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Bash',  tool_input: { command: 'npm test' } } },
  { after: 900,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash',  tool_response: { stdout: '42 passing' } } },
  { after: 400,  payload: { hook_event_name: 'Notification', message: 'All checks green — audit complete.' } },
  { after: 400,  payload: { hook_event_name: 'Stop' } },
];

// A feature-build session (parallel builder + tester).
export const FEATURE_SCENARIO = [
  { after: 0,    payload: { hook_event_name: 'SessionStart', source: 'startup', cwd: '/repo/web-app' } },
  { after: 500,  payload: { hook_event_name: 'UserPromptSubmit', prompt: 'Add a dark-mode toggle with a persisted preference and tests.' } },
  { after: 600,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Glob',  tool_input: { pattern: 'src/**/*.tsx' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Glob',  tool_response: { output: '84 components' } } },

  { after: 600,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Task',  tool_input: { subagent_type: 'frontend-builder', description: 'Build ThemeToggle + context' } } },
  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Read',  tool_input: { file_path: 'src/components/Header.tsx' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Read',  tool_response: { output: 'read 64 lines' } } },
  { after: 450,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Write', tool_input: { file_path: 'src/components/ThemeToggle.tsx' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_response: { output: 'wrote 72 lines' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Task',  tool_response: { result: 'Toggle + ThemeContext wired, persists to localStorage.' } } },

  { after: 500,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Task',  tool_input: { subagent_type: 'test-writer', description: 'Unit + e2e tests for the toggle' } } },
  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Write', tool_input: { file_path: 'tests/theme.spec.ts' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_response: { output: 'wrote 40 lines' } } },
  { after: 500,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Bash',  tool_input: { command: 'npm test -- theme' } } },
  { after: 900,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash',  tool_response: { stdout: '8 passing' } } },
  { after: 400,  payload: { hook_event_name: 'SubagentStop' } },

  { after: 500,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Bash',  tool_input: { command: 'npm run build' } } },
  { after: 900,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash',  tool_response: { stdout: 'build ok' } } },
  { after: 400,  payload: { hook_event_name: 'Stop' } },
];

// A docs-generation session (single extractor subagent).
export const DOCS_SCENARIO = [
  { after: 0,    payload: { hook_event_name: 'SessionStart', source: 'startup', cwd: '/repo/design-system' } },
  { after: 500,  payload: { hook_event_name: 'UserPromptSubmit', prompt: 'Generate component API docs from source.' } },
  { after: 600,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Grep',  tool_input: { pattern: 'export function' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Grep',  tool_response: { output: '24 exports' } } },
  { after: 600,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Task',  tool_input: { subagent_type: 'doc-extractor', description: 'Extract prop tables for all components' } } },
  { after: 400,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Read',  tool_input: { file_path: 'src/Button.tsx' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Read',  tool_response: { output: 'read 120 lines' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Task',  tool_response: { result: 'Extracted prop tables for 24 components.' } } },
  { after: 500,  payload: { hook_event_name: 'PreToolUse',  tool_name: 'Write', tool_input: { file_path: 'docs/api.md' } } },
  { after: 500,  payload: { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_response: { output: 'wrote 310 lines' } } },
  { after: 400,  payload: { hook_event_name: 'Stop' } },
];

// Demo session roster: distinct session_ids + cwds so the picker is meaningful.
export const DEMO_SESSIONS = [
  { id: 'demo-sec-audit',   cwd: '/repo/payments-api',   scenario: SCENARIO,          speed: 1.0,  startDelay: 0,    model: 'claude-opus-4-8' },
  { id: 'demo-dark-mode',   cwd: '/repo/web-app',        scenario: FEATURE_SCENARIO,  speed: 1.25, startDelay: 1500, model: 'claude-sonnet-5' },
  { id: 'demo-api-docs',    cwd: '/repo/design-system',  scenario: DOCS_SCENARIO,     speed: 0.9,  startDelay: 4000, model: 'claude-haiku-4-5-20251001' },
];
