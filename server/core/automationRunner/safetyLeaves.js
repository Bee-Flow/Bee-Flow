// @typecheck
function _stringify(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

// Collect / re-apply string leaves in a stable order. The guard needs TWO
// passes over the same leaves — scan everything first (so a block decision is
// made before anything is transformed), then rewrite — and scanning twice is
// what the old implementation did: it scanned the whole stringified value AND
// then every leaf again, i.e. two GLiNER rounds per guarded value, with the
// outer pass matching regex rules across JSON field boundaries. Object.keys
// order is insertion-stable, so index N means the same leaf in both walks.
function collectStringLeaves(value, out = []) {
    if (value == null) return out;
    if (typeof value === 'string') { out.push(value); return out; }
    if (Array.isArray(value)) { for (const v of value) collectStringLeaves(v, out); return out; }
    if (typeof value === 'object') { for (const k of Object.keys(value)) collectStringLeaves(value[k], out); return out; }
    return out;
}

/**
 * The FIELD NAME each string leaf sat under, in `collectStringLeaves` order.
 * An array inherits its parent key, so `messageIds: ['a','b']` yields
 * 'messageIds' twice. Index N means the same leaf in both walks.
 */
function collectStringLeafKeys(value, key = null, out = []) {
    if (value == null) return out;
    if (typeof value === 'string') { out.push(key); return out; }
    if (Array.isArray(value)) { for (const v of value) collectStringLeafKeys(v, key, out); return out; }
    if (typeof value === 'object') { for (const k of Object.keys(value)) collectStringLeafKeys(value[k], k, out); return out; }
    return out;
}

// ── identifier arguments ────────────────────────────────────────────────────
//
// A tool input named like an id (`messageId`, `thread_id`, `fileID`, `uuid`)
// holds an ADDRESS: the handle the provider itself issued, being handed straight
// back to that same provider so it knows which record to act on. Redacting one
// protects nothing — the provider already has it, by definition — and guarantees
// the call fails. That is not hypothetical: GLiNER reads a 16-hex-character Gmail
// message id as a phone number (8 of its characters are digits), so an automation
// that read each mail of a search result sent a placeholder to Gmail and died on
// "Invalid id value" for all ten iterations, with the shield reporting a
// successful redaction.
//
// So the PII detector's verdict is not applied to these fields. Deliberately
// NARROW:
//   - the tool-INPUT scope only (an id in an OUTPUT is content the author sees,
//     and nothing downstream is broken by tokenizing it — the vault restores it);
//   - the value must be a single whitespace-free token, so a field called `id`
//     carrying a whole mail body is still scanned like any other text;
//   - REGEX GUARDRAIL RULES still apply in full. A rule is an explicit
//     instruction from the org ("this pattern must not leave"), not a statistical
//     guess, and an org that writes one about its record ids means it.
// Findings are still LOGGED (action 'passed_unredacted'), so the Shield's
// "What happened" shows the detection and what was done with it.
const _ID_KEY_RE = /(?:^|[_\-.])(?:id|ids|uid|uuid|guid|sid)$|[a-z0-9](?:Id|Ids|ID|IDs|Uid|UID|Uuid|UUID|Guid|GUID)$/;

function _isIdentifierKey(key) {
    const k = String(key || '').trim();
    if (!k) return false;
    if (/^(?:id|ids|uid|uuid|guid|sid)$/i.test(k)) return true;
    return _ID_KEY_RE.test(k);
}

/** An addressing handle, not prose: one token, no whitespace, bounded length. */
function _isHandleValue(v) {
    return typeof v === 'string' && v.length > 0 && v.length <= 256 && !/\s/.test(v);
}

function applyStringLeaves(value, replacements, cursor = { i: 0 }) {
    if (value == null) return value;
    if (typeof value === 'string') return replacements[cursor.i++];
    if (Array.isArray(value)) return value.map(v => applyStringLeaves(v, replacements, cursor));
    if (typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) out[k] = applyStringLeaves(value[k], replacements, cursor);
        return out;
    }
    return value;
}

/**
 * The run-scoped token vault, or an ephemeral per-ctx stand-in.
 *
 * Every real run gets one from executeAutomation. The fallback keeps unit tests
 * (and any future caller that builds a bare ctx) correct rather than crashing:
 * they get a vault scoped to that ctx object instead of a run.
 */
function _vaultOf(ctx) {
    if (ctx && ctx.tokenVault) return ctx.tokenVault;
    const { createTokenVault } = require('./tokenVault');
    if (!ctx) return createTokenVault({});
    if (!ctx._ephemeralTokenVault) {
        ctx._ephemeralTokenVault = createTokenVault({});
    }
    return ctx._ephemeralTokenVault;
}

module.exports = { _stringify, collectStringLeaves, collectStringLeafKeys, _isIdentifierKey, _isHandleValue, applyStringLeaves, _vaultOf };
