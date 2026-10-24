const log = require('../../telemetry/log');
const { collectStringLeaves, collectStringLeafKeys, _isIdentifierKey, _isHandleValue, applyStringLeaves, _vaultOf } = require('./safetyLeaves');
const { _scanText, _degradationIsRelevant, _regexHits, _scanFailedMessage } = require('./safetyScan');
const { bestEffort, fallback } = require('../../utils/bestEffort');

class GuardrailBlockError extends Error {
    constructor(message, { violationType = 'pii', categories = [], scope = 'input' } = {}) {
        super(message);
        this.name = 'GuardrailBlockError';
        this.guardrailBlocked = true;
        this.violationType = violationType;
        this.categories = Array.isArray(categories) ? categories : [categories].filter(Boolean);
        this.scope = scope;
    }
}

function _logGuardrail(auditBase, { violation_type, categories, direction, action_taken, isDryRun, dedupeKey, ctx }) {
    try {
        // A step retry re-scans the SAME payload, so one finding used to appear
        // once per attempt in the dashboard ("4 catches" for one email). Dedupe
        // on the content itself, not on the step: a loop iteration carrying
        // different data is a genuinely new finding and must still count.
        if (dedupeKey && ctx) {
            if (!ctx._guardrailSeen) ctx._guardrailSeen = new Set();
            if (ctx._guardrailSeen.has(dedupeKey)) return;
            // Bound the memory of a very long run.
            if (ctx._guardrailSeen.size < 5000) ctx._guardrailSeen.add(dedupeKey);
        }
        const store = require('../../stores/guardrailEventStore');
        store.logGuardrailEvent({
            ...auditBase,
            violation_type,
            violation_categories: (categories || []).join(', ') || null,
            direction: direction || 'input',
            action_taken,
            is_dry_run: !!isDryRun,
        }).catch((e) => bestEffort('core/automationRunner/safetyGuard:_logGuardrail', e));
    } catch (err) { fallback('core/automationRunner/safetyGuard:_logGuardrail#2', err); /* never fail the run on logging */ }
}

function _hash(s) {
    return require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 16); // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_sha1 -- a short non-security fingerprint for a log line, not a password or signature hash
}

/**
 * Guard a structured value (tool inputs OR tool/ai output).
 *
 * Scans every string leaf ONCE, then rewrites: regex hits become an in-place
 * `[REDACTED:<rule>]` marker (a guardrail rule means "this content must not
 * travel", so it is deliberately irreversible), PII is tokenized into the
 * run-scoped vault (reversible — what actually leaves is decided later by
 * prepareForEgress).
 *
 * Mutates nothing. Returns { value, tokenMap, blocked, categories, markers }.
 * Throws GuardrailBlockError on a block action or a fail-closed scan failure
 * (in dry-run it annotates with wouldBlock instead).
 */
async function _guardValue(value, policy, auditBase, { direction, scopeOn, mode, ctx, exemptIdentifiers = false }) {
    const noop = { value, tokenMap: null, blocked: false, categories: [], markers: [] };
    if (!policy.piiEnabled && !policy.regexRules.length) return noop;
    if (scopeOn === false) return noop;

    const isDryRun = mode === 'dry_run';
    const leaves = collectStringLeaves(value);
    if (!leaves.length) return noop;
    // Identifier arguments keep their PII findings out of the redact/block
    // decision (see _isIdentifierKey) — regex rules below are unaffected.
    const leafKeys = exemptIdentifiers ? collectStringLeafKeys(value) : null;
    const isExempt = (i) => !!leafKeys && _isIdentifierKey(leafKeys[i]) && _isHandleValue(leaves[i]);

    // ── pass 1: scan (no transformation yet — a block decision must be made
    // before anything is rewritten) ──
    const perLeaf = [];
    const regexNames = new Set();
    const piiCats = new Set();
    const markers = new Set();
    let degraded = false;
    let degradedReason = null;
    let degradedCategories = null;
    let overflow = false;

    const exemptCats = new Set();
    for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i];
        const rHits = _regexHits(leaf, policy);
        for (const h of rHits) regexNames.add(h.ruleName);
        let scan = null;
        if (policy.piiEnabled) {
            scan = await _scanText(leaf, policy);
            const exempt = isExempt(i);
            for (const e of scan.entities) (exempt ? exemptCats : piiCats).add(e.label || e.category);
            if (exempt) scan = { ...scan, entities: [] };
            if (scan.degraded) {
                degraded = true;
                degradedReason = degradedReason || scan.degradedReason;
                if (scan.degradedCategories) degradedCategories = [...new Set([...(degradedCategories || []), ...scan.degradedCategories])];
            }
            if (scan.overflow) overflow = true;
        }
        perLeaf.push({ leaf, rHits, entities: scan ? scan.entities : [] });
    }

    const contentKey = _hash(leaves.join('\u0000'));
    const dedupeBase = `${auditBase.step_id || '-'}|${direction}`;

    // ── scan failure / degradation policy ──
    // "The detector could not look" is not "there is nothing to find". Honour
    // the org's piiFailureMode, narrowed to the categories it actually asked
    // for (a category the org doesn't scan for degrading is not its problem).
    if (degraded && _degradationIsRelevant(degradedCategories, policy.categories)) {
        markers.add('privacy_protection_unavailable');
        if (policy.failureMode === 'fail_closed') {
            _logGuardrail(auditBase, {
                violation_type: 'scan_failed', categories: ['privacy_protection_unavailable'],
                direction, action_taken: 'scan_failed', isDryRun, ctx,
                dedupeKey: `${dedupeBase}|scan_failed|${contentKey}`,
            });
            if (!isDryRun) {
                // The raw reason belongs in the log; the person looking at a
                // failed step gets what happened and what to do about it.
                log.warn(`[safety] privacy check degraded (${degradedReason || 'unknown'}) on step ${auditBase.step_id || '-'} ${direction} — fail_closed: blocking`);
                throw new GuardrailBlockError(
                    _scanFailedMessage(degradedReason, direction, leaves.length),
                    { violationType: 'scan_failed', categories: ['privacy_protection_unavailable'], scope: direction },
                );
            }
            return { value, tokenMap: null, blocked: true, categories: ['privacy_protection_unavailable'], markers: [...markers], wouldBlock: true };
        }
        // fail_open still has to be VISIBLE: "we let this through unchecked" is
        // the one outcome an admin must be able to find afterwards, and a
        // console line is not an audit trail.
        _logGuardrail(auditBase, {
            violation_type: 'scan_failed', categories: ['privacy_protection_unavailable'],
            direction, action_taken: 'passed_unredacted', isDryRun, ctx,
            dedupeKey: `${dedupeBase}|scan_open|${contentKey}`,
        });
        log.warn(`[safety] privacy check degraded (${degradedReason || 'unknown'}) — fail_open: continuing UNCHECKED`);
    }
    if (overflow) {
        markers.add('scan_overflow');
        if (policy.largeInputPolicy === 'fail_closed') {
            _logGuardrail(auditBase, {
                violation_type: 'scan_failed', categories: ['scan_overflow'],
                direction, action_taken: 'scan_failed', isDryRun, ctx,
                dedupeKey: `${dedupeBase}|scan_overflow|${contentKey}`,
            });
            if (!isDryRun) {
                throw new GuardrailBlockError('Blocked: this content was too large to check completely.', { violationType: 'scan_failed', categories: ['scan_overflow'], scope: direction });
            }
            return { value, tokenMap: null, blocked: true, categories: ['scan_overflow'], markers: [...markers], wouldBlock: true };
        }
    }

    const names = [...regexNames];
    const cats = [...piiCats];

    // Detections we deliberately did not act on because the field is the call's
    // own address (see _isIdentifierKey). Logged BEFORE any block/redact decision
    // so "the shield saw this and let it through" is in the audit trail whatever
    // else this value triggers.
    if (exemptCats.size) {
        markers.add('identifier_passed_unredacted');
        _logGuardrail(auditBase, {
            violation_type: 'pii', categories: [...exemptCats], direction,
            action_taken: 'passed_unredacted', isDryRun, ctx,
            dedupeKey: `${dedupeBase}|pii|identifier|${contentKey}`,
        });
    }

    // ── block action ──
    if (policy.action === 'block' && (names.length || cats.length)) {
        const type = names.length ? 'regex' : 'pii';
        const found = names.length ? names : cats;
        _logGuardrail(auditBase, {
            violation_type: type, categories: found, direction, action_taken: 'blocked', isDryRun, ctx,
            dedupeKey: `${dedupeBase}|${type}|blocked|${contentKey}`,
        });
        if (!isDryRun) {
            throw new GuardrailBlockError(
                names.length
                    ? `Blocked by guardrail rule(s): ${names.join(', ')}`
                    : `Blocked: sensitive data detected (${cats.join(', ')})`,
                { violationType: type, categories: found, scope: direction },
            );
        }
        return { value, tokenMap: null, blocked: true, categories: found, markers: [...markers], wouldBlock: true };
    }

    if (!names.length && !cats.length) {
        return { value, tokenMap: null, blocked: false, categories: [], markers: [...markers] };
    }

    // ── pass 2: rewrite ──
    const { tokenizeText } = require('../privacy/piiDetection');
    const vault = _vaultOf(ctx);
    const tokenMap = {};
    const replacements = [];
    for (const { leaf, rHits, entities } of perLeaf) {
        let out = leaf;
        for (const h of rHits) {
            try {
                const safe = h.pattern.replace(/^\(\?i\)/, '').replace(/^\(\?-[a-z]+\)/, '');
                out = out.replace(new RegExp(safe, 'gi'), `[REDACTED:${h.ruleName}]`);
            } catch (err) { fallback('core/automationRunner/safetyGuard:_guardValue', err); /* skip bad pattern */ }
        }
        if (entities.length) {
            // Regex redaction shifted the offsets, so re-derive the spans on the
            // rewritten text when anything actually changed.
            const spans = out === leaf ? entities : null;
            const src = out;
            const minted = await vault.mint((seed) => tokenizeText(src, spans || _respan(entities, src), seed));
            out = minted.tokenizedText;
            Object.assign(tokenMap, minted.tokenMap);
        }
        replacements.push(out);
    }

    if (names.length) {
        _logGuardrail(auditBase, {
            violation_type: 'regex', categories: names, direction, action_taken: 'redacted', isDryRun, ctx,
            dedupeKey: `${dedupeBase}|regex|redacted|${contentKey}`,
        });
    }
    if (cats.length) {
        _logGuardrail(auditBase, {
            violation_type: 'pii', categories: cats, direction, action_taken: 'redacted', isDryRun, ctx,
            dedupeKey: `${dedupeBase}|pii|redacted|${contentKey}`,
        });
    }

    return {
        value: applyStringLeaves(value, replacements),
        tokenMap: Object.keys(tokenMap).length ? tokenMap : null,
        blocked: false,
        categories: [...names, ...cats],
        markers: [...markers],
    };
}

/**
 * Re-locate entities in a rewritten string (regex redaction moved the offsets).
 * Falls back to a plain indexOf per entity; entities whose text is gone (it WAS
 * the redacted span) are dropped.
 */
function _respan(entities, text) {
    const out = [];
    for (const e of entities) {
        const idx = e.text ? text.indexOf(e.text) : -1;
        if (idx < 0) continue;
        out.push({ ...e, offset: idx, length: e.text.length });
    }
    return out;
}

async function guardToolInput(inputs, policy, auditBase, mode, ctx = null) {
    return _guardValue(inputs, policy, auditBase, {
        direction: 'input', scopeOn: policy.scope.toolInput !== false, mode, ctx,
        // The one scope where a redaction cannot protect anything and can only
        // break the call: the ids this call addresses records BY.
        exemptIdentifiers: true,
    });
}

/**
 * Guard a tool result before it enters runState.
 *
 * Returns its `tokenMap` — dropping it was the single worst bug on this path:
 * the tokenized result was written into runState as a literal `[person_1]` that
 * nothing could restore, and it travelled from there into every downstream node,
 * email and document. The caller merges it into the run vault and restores
 * before writing downstream.
 */
async function guardToolOutput(result, policy, auditBase, mode, ctx = null) {
    const r = await _guardValue(result, policy, auditBase, { direction: 'output', scopeOn: policy.scope.toolOutput !== false, mode, ctx });
    return { result: r.value, tokenMap: r.tokenMap, blocked: r.blocked, categories: r.categories, markers: r.markers, wouldBlock: r.wouldBlock };
}

/**
 * Guard an ai_step's messages before the LLM call. Mutates the guarded messages
 * in place (matching the agent runner) and returns { tokenMap, blocked }.
 *
 * Guards the SYSTEM prompt as well as the user message: an automation's system
 * prompt is `{{…}}`-interpolated from step data, so it routinely carries the
 * very personal data the shield is supposed to catch, and it used to go to the
 * model untouched.
 */
async function guardAiInput(messages, policy, auditBase, mode, ctx = null) {
    if (!policy.piiEnabled && !policy.regexRules.length) return { tokenMap: null, blocked: false };
    if (policy.scope.userInput === false) return { tokenMap: null, blocked: false };

    const targets = (messages || []).filter(m => (m.role === 'user' || m.role === 'system') && typeof m.content === 'string');
    if (!targets.length) return { tokenMap: null, blocked: false };

    const guarded = await _guardValue(targets.map(m => m.content), policy, auditBase, { direction: 'input', scopeOn: true, mode, ctx });
    if (guarded.wouldBlock) return { tokenMap: null, blocked: true, categories: guarded.categories };
    if (Array.isArray(guarded.value)) {
        targets.forEach((m, i) => { if (typeof guarded.value[i] === 'string') m.content = guarded.value[i]; });
    }
    return { tokenMap: guarded.tokenMap, blocked: false, categories: guarded.categories, markers: guarded.markers };
}

/**
 * Guard an ai_step's output. On block (default action) throws; otherwise returns
 * the (possibly redacted) output plus the tokenMap of any PII it tokenized. The
 * caller restores from the run vault before writing the value downstream, so the
 * model saw placeholders and downstream steps see real values.
 *
 * Numbering never collides with the input tokens: both mints go through the same
 * run-scoped vault, which seeds every tokenizeText call.
 */
async function guardAiOutput(content, policy, auditBase, mode, ctx = null) {
    if (!policy.piiEnabled && !policy.regexRules.length) return { content, tokenMap: null, blocked: false };
    if (policy.scope.agentOutput === false) return { content, tokenMap: null, blocked: false };
    const guarded = await _guardValue(content, policy, auditBase, { direction: 'output', scopeOn: true, mode, ctx });
    if (guarded.wouldBlock && mode !== 'dry_run') {
        throw new GuardrailBlockError(`Blocked: AI step output contained sensitive data (${(guarded.categories || []).join(', ')})`, { violationType: 'pii', categories: guarded.categories, scope: 'output' });
    }
    return { content: guarded.value, tokenMap: guarded.tokenMap, blocked: !!guarded.wouldBlock, categories: guarded.categories, markers: guarded.markers };
}

module.exports = { GuardrailBlockError, guardToolInput, guardToolOutput, guardAiInput, guardAiOutput };
