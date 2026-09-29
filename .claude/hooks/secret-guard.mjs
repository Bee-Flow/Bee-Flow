#!/usr/bin/env node
// PreToolUse guard — blocks reading/editing/writing secret files and shell reads
// of them (cat/type/Get-Content ...), across the Read/Edit/Write/Grep/Bash/PowerShell
// tools. Defense-in-depth on top of the deny permission rules. Fails open on parse
// errors so a broken hook never wedges the session.

import { readFileSync } from 'node:fs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

const tool = input.tool_name || '';
const ti = input.tool_input || {};

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// Does this path point at something secret we must never touch?
function isSecretPath(p) {
  if (!p) return false;
  const s = String(p).replace(/\\/g, '/');
  const base = s.split('/').pop() || '';

  // NOTE: `.env*` files are deliberately NOT blocked (owner's choice, 2026-07)
  // so Claude can manage local compose/deploy config. Credentials, keys and
  // deploy manifests below stay protected.

  // credential stores and the wizard's captured env
  if (base.includes('.credentials')) return true;
  if (base === '.install-env.json') return true;

  // private keys — but shipped PUBLIC keys are fine to read
  if (/\.(pem|key|p12|pfx|jks)$/i.test(base) && !/public/i.test(base)) return true;

  // gitignored production deploy tree (Scaleway Kapsule). The manifests under
  // deploy/ are `${VAR}` templates and carry no secrets — deploy.sh renders them
  // with envsubst. What IS secret is the input and the output of that render, so
  // block those two and let the templates through (narrowed 2026-07-27, so the
  // manifests can be maintained here instead of hand-copied).
  if (/(^|\/)deploy\//.test(s)) {
    if (/(^|\/)\.rendered\//.test(s)) return true;   // envsubst output = real values
    if (/^\.env/.test(base)) return true;            // .env.scaleway[.dev]
    if (/kubeconfig/i.test(base)) return true;       // cluster admin tokens
    if (/(^|\/)secrets?\//.test(s)) return true;
    return false;
  }

  return false;
}

const LABEL =
  'Bee Flow secret-guard: this path holds secrets (keys/credentials/deploy) and must not be read or modified. ' +
  'If you genuinely need a value, ask the user for it instead of opening the file.';

if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
  if (isSecretPath(ti.file_path)) deny(LABEL);
}
if (tool === 'NotebookEdit') {
  if (isSecretPath(ti.notebook_path)) deny(LABEL);
}
if (tool === 'Grep') {
  if (isSecretPath(ti.path)) deny(LABEL);
}
if (tool === 'Bash' || tool === 'PowerShell') {
  const cmd = String(ti.command || '');
  const readers =
    /\b(cat|type|less|more|head|tail|xxd|od|strings|nano|vi|vim|bat|gc|Get-Content|Select-String|sls)\b/i;
  if (readers.test(cmd)) {
    const tokens = cmd.split(/[\s"'`=,;|(){}]+/).filter(Boolean);
    for (const t of tokens) {
      if (isSecretPath(t)) deny(`${LABEL} (blocked shell read of ${t})`);
    }
  }
}

process.exit(0);
