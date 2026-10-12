/**
 * Author-placed privacy steps (extracted verbatim from engine.js): guard
 * ("does this contain personal data"), tokenize ("hide it, reversibly") and
 * untokenize ("put the real values back"), with their policy-narrowing
 * helpers.
 */

/**
 * GUARD — "does this contain personal data, and what should happen if it does".
 *
 * The Privacy Shield already scans everything an automation SENDS, but that runs
 * underneath the author: org-wide, invisible, and only ever about egress. This
 * is the same detector placed where the author can see it and react — the
 * headline case being a document landing in Drive that turns out to hold
 * personal data, and an alert going out about it.
 *
 * It scans through safety.scanTextForPii, which is the shield's own pipeline
 * (GLiNER → org allowlist → org custom terms). Anything else would let a step
 * an author placed disagree with the policy running beneath it, and then
 * neither answer is worth having.
 *
 * ── THE RULE THAT MATTERS ───────────────────────────────────────────
 * "Nothing found" and "we could not look" are different answers. A missing or
 * unreachable detector produces `degraded`, and the ORG's failure mode decides
 * which branch that takes — never a quiet `clean`. A guard that reports safe
 * because it never ran is worse than no guard at all.
 *
 * ── TIGHTEN, NEVER LOOSEN ───────────────────────────────────────────
 * `step.categories` may narrow the org's category list and `step.confidence`
 * may only raise its threshold. Same rule `definition.safety` already follows:
 * an automation may hold itself to a higher standard than the org, never a lower one.
 */
async function execGuard(step, ctx, runState, mode) {
    const safety = require('./safety');
    const bind = require('../../automation/bind');

    const sourceRef = typeof step.sourceRef === 'string' ? step.sourceRef.trim() : '';
    // An unbound guard must FAIL, never pass. Saving one is allowed (the
    // builder warns), but a run that reached it would otherwise scan the empty
    // string, find nothing, and route "clean" — a green tick meaning nobody
    // looked, which is the exact outcome this step exists to prevent.
    if (!sourceRef) {
        const err = new Error('Guard has nothing to scan — pick a value from an earlier step.');
        err.errorClass = 'guard_no_source';
        throw err;
    }
    const raw = bind.walkPath(sourceRef, runState);
    // Whole objects are scanned as their JSON. A guard pointed at a record
    // should see the values inside it, not refuse because it is not a string.
    const text = raw == null ? '' : (typeof raw === 'string' ? raw : safeJson(raw));

    const policy = await safety.resolveAutomationPolicy(ctx);
    const scanPolicy = narrowPolicy(policy, step);

    // No policy to scan under is not a silent pass: the step says so, and the
    // failure mode still decides the branch. The three reasons are genuinely
    // different problems and only one of them is a setting anyone chose:
    //
    //   no_organisation — this automation belongs to no organisation, so there is
    //       no org Privacy Shield to resolve AT ALL. Not something the author
    //       turned off, and not something they can fix from this panel — which
    //       is exactly why it must not be reported as "disabled".
    //   shield_disabled — the org excluded automations from the shield.
    //   pii_detection_off — the org has no PII detection enabled.
    const noPolicyReason = !scanPolicy.orgId ? 'no_organisation'
        : scanPolicy.disabledForAutomations ? 'shield_disabled'
            : !scanPolicy.piiEnabled ? 'pii_detection_off'
                : null;
    const det = noPolicyReason
        ? { entities: [], degraded: true, degradedReason: noPolicyReason, overflow: false }
        : await safety.scanTextForPii(text, scanPolicy);

    const summary = safety.buildPiiSummary(det.entities, { source: 'guard', degraded: det.degraded });
    const found = det.entities.length > 0;
    // fail_closed treats "could not look" as "assume the worst" — which for a
    // guard means taking the found branch, so the alert still fires.
    const failClosed = scanPolicy.failureMode === 'fail_closed';
    const treatAsFound = found || (det.degraded && failClosed);

    const output = {
        branch: treatAsFound ? 'then' : 'else',
        hasPii: found,
        count: det.entities.length,
        categories: summary ? summary.categories : {},
        groups: summary ? summary.groups : {},
        scanned: text.length,
        ...(det.degraded ? { degraded: true, degradedReason: det.degradedReason || 'unknown' } : {}),
        ...(det.overflow ? { overflow: true } : {}),
    };

    const onFound = isPlainObj(step.onFound) ? step.onFound : {};

    // A masked copy for the steps downstream: tokenize, then drop the counter,
    // so `[person]` cannot be re-linked across occurrences. Same meaning as the
    // shield's 'redact' action — irreversible, not a reversible placeholder.
    if (onFound.mask && found) {
        try {
            const { tokenizeText } = require('../privacy/piiDetection');
            const { tokenizedText } = tokenizeText(text, det.entities);
            output.masked = safety.maskTokens(tokenizedText);
        } catch (e) {
            // Handing back the ORIGINAL here would be the worst possible
            // failure: a field the author believes is masked, isn't.
            output.masked = null;
            output.maskError = e.message;
            output.degraded = true;
            output.degradedReason = output.degradedReason || 'mask_failed';
        }
    }

    // BFSF-355 "Check + Hide": one node that scans AND hides what it finds.
    // Reversible, unlike `mask` above — the placeholders are minted into the
    // run vault, so a later "Show real values again" genuinely puts the
    // originals back. It reuses the entities this guard already detected
    // rather than calling tokenizeIntoVault, which would run a second GLiNER
    // scan over the same text.
    if (onFound.tokenize && treatAsFound) {
        if (det.degraded) {
            // Nothing was scanned, so nothing was hidden. Handing back `text`
            // here would be the one failure this mode may never have: a value
            // the author believes is tokenized, carrying real personal data
            // into the next step. Same stance as execTokenize's degraded path.
            output.text = null;
            output.hideError = 'the detector could not scan, so nothing was hidden';
            output.degraded = true;
            output.degradedReason = output.degradedReason || 'hide_skipped_degraded';
        } else {
            try {
                output.text = await safety.mintTokensFor(text, det.entities, ctx);
                output.vaultSize = ctx?.tokenVault?.size ?? null;
            } catch (e) {
                output.text = null;
                output.hideError = e.message;
                output.degraded = true;
                output.degradedReason = output.degradedReason || 'hide_failed';
            }
        }
    }

    if (onFound.stop && treatAsFound) {
        // Dry-run reports rather than fails, so the builder preview can show
        // "would stop here" — the convention safety.js already documents for
        // guard blocks.
        if (mode === 'dry_run') return { output: { ...output, wouldStop: true } };
        const label = summary ? Object.keys(summary.categories).join(', ') : (det.degradedReason || 'unknown');
        const err = new Error(found
            ? `Guard stopped the run — personal data found (${label})`
            : `Guard stopped the run — the detector could not scan (${label}) and this organisation fails closed`);
        err.errorClass = 'guard_pii_found';
        throw err;
    }

    return { output };
}

/**
 * TOKENIZE — "hide the personal data, and put it back automatically later".
 *
 * The same thing chat does before a message reaches a model: every detected
 * value is replaced by a REVERSIBLE placeholder (`[email_1]`), and the mapping
 * is minted into the run's token vault.
 *
 * ── WHY THERE IS NO "RESTORE" NODE ──────────────────────────────────
 * There is nothing to wire. The vault is run-scoped, and the runner ALREADY
 * restores from the whole vault at every point where a value comes back into
 * the automation — `restoreForRunState` on an AI reply and on every tool result,
 * `prepareForEgress` on the way out. So the round trip is the chat one:
 *
 *     Tokenize → AI step        the model sees [email_1]
 *     AI reply → run state      the real address is back, automatically
 *
 * Adding a restore step would mean a second place that decides, and an automation
 * where someone forgot to add it would leak placeholders into a document.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────
 * Not the guard's `mask`. That one strips the counter on purpose (`[person]`)
 * so occurrences cannot be re-linked and the original is gone for good. This is
 * the opposite: reversible by design.
 */
async function execTokenize(step, ctx, runState, mode) {
    const safety = require('./safety');
    const bind = require('../../automation/bind');

    const sourceRef = typeof step.sourceRef === 'string' ? step.sourceRef.trim() : '';
    // Same rule as the guard: an unbound step must fail rather than hand the
    // next one an empty string it will treat as "nothing to hide".
    if (!sourceRef) {
        const err = new Error('Nothing to hide personal data in — pick a value from an earlier step.');
        err.errorClass = 'tokenize_no_source';
        throw err;
    }
    const raw = bind.walkPath(sourceRef, runState);
    const isText = raw == null || typeof raw === 'string';
    const text = raw == null ? '' : (isText ? raw : safeJson(raw));

    const policy = await safety.resolveAutomationPolicy(ctx);
    const scanPolicy = narrowPolicy(policy, step);
    const noPolicyReason = !scanPolicy.orgId ? 'no_organisation'
        : scanPolicy.disabledForAutomations ? 'shield_disabled'
            : !scanPolicy.piiEnabled ? 'pii_detection_off'
                : null;

    if (noPolicyReason) {
        // Handing back the ORIGINAL and calling it tokenized is the failure this
        // step must never have — the next node would send real personal data
        // believing it was hidden. Fail instead.
        const err = new Error(`Cannot hide personal data — ${noPolicyReason === 'no_organisation'
            ? 'this automation belongs to no organisation, so there is no Privacy Shield to read'
            : noPolicyReason === 'shield_disabled'
                ? 'this organisation excluded automations from the Privacy Shield'
                : 'this organisation has PII detection switched off'}.`);
        err.errorClass = 'tokenize_no_policy';
        throw err;
    }

    const res = await safety.tokenizeIntoVault(text, scanPolicy, ctx);
    if (res.degraded) {
        // Same reasoning: a scan that could not run has hidden nothing.
        const err = new Error(`Could not scan for personal data (${res.degradedReason || 'unknown'}) — nothing was hidden.`);
        err.errorClass = 'tokenize_degraded';
        throw err;
    }

    const summary = safety.buildPiiSummary(res.entities, { source: 'tokenize' });
    return {
        output: {
            // The value as the next step should see it. Non-string sources were
            // scanned as JSON, so they come back as JSON text — the type change
            // is visible rather than silently re-parsed into a shape whose
            // placeholders would be spread across fields.
            text: res.text,
            count: res.entities.length,
            categories: summary ? summary.categories : {},
            groups: summary ? summary.groups : {},
            // How many placeholders the run can currently resolve. The honest
            // answer to "will this come back?" — an evicted token cannot.
            vaultSize: ctx?.tokenVault?.size ?? null,
            ...(mode === 'dry_run' ? { dryRun: true } : {}),
        },
    };
}

/**
 * UNTOKENIZE — put the real values back, here, on purpose.
 *
 * The runner already restores automatically wherever a value comes BACK into
 * the automation — an AI reply, a tool result, an HTTP response all pass through
 * `restoreForRunState`. That covers the round trip, and most automations need
 * nothing else.
 *
 * It does not cover the rest: a tokenized value carried forward by a `set`
 * step, written to a table, or read straight off `steps.<tokenize>.output.text`
 * stays tokenized, because nothing brought it back through a boundary. This
 * step is that boundary, named and placed by the author.
 *
 * ── THE ONLY INTERESTING FAILURE ────────────────────────────────────
 * A placeholder the vault cannot resolve. It happens for real — the vault
 * evicts at its 5000-token ceiling, and a value from another run was never in
 * this one — and the result reads as ordinary text: `[person_5]` in a document,
 * looking deliberate. So what is left over is COUNTED and reported rather than
 * left for someone to find later.
 */
async function execUntokenize(step, ctx, runState) {
    const safety = require('./safety');
    const bind = require('../../automation/bind');

    const sourceRef = typeof step.sourceRef === 'string' ? step.sourceRef.trim() : '';
    if (!sourceRef) {
        const err = new Error('Nothing to restore — pick the value that holds the placeholders.');
        err.errorClass = 'untokenize_no_source';
        throw err;
    }
    const raw = bind.walkPath(sourceRef, runState);
    const restored = safety.restoreForRunState(raw, ctx);

    // What is still a placeholder AFTER the restore — the tokens this run
    // cannot account for.
    const leftover = unresolvedTokens(restored);
    const before = unresolvedTokens(raw);
    return {
        output: {
            text: typeof restored === 'string' ? restored : safeJson(restored),
            value: restored,
            restored: Math.max(0, before.size - leftover.size),
            ...(leftover.size ? {
                unresolved: leftover.size,
                unresolvedTokens: [...leftover].slice(0, 20),
            } : {}),
            vaultSize: ctx?.tokenVault?.size ?? null,
        },
    };
}

// Placeholders of the shape the tokenizer mints (`[email_1]`). Mirrors
// safety.js's _TOKEN_RE: a category key may itself contain underscores.
const _PLACEHOLDER_RE = /\[([a-z0-9_]+)_(\d+)\]/g;

function unresolvedTokens(value) {
    const found = new Set();
    let json;
    try { json = typeof value === 'string' ? value : JSON.stringify(value); } catch { return found; }
    if (typeof json !== 'string') return found;
    _PLACEHOLDER_RE.lastIndex = 0;
    let m;
    while ((m = _PLACEHOLDER_RE.exec(json))) found.add(m[0]);
    return found;
}

/**
 * The org policy as this step may see it: categories can only be narrowed,
 * the confidence threshold only raised.
 */
function narrowPolicy(policy, step) {
    const next = { ...policy };
    const wanted = Array.isArray(step.categories) ? step.categories.filter(c => typeof c === 'string' && c) : null;
    if (wanted && wanted.length) {
        // `policy.categories === null` means "every category the org allows",
        // so an intersection with null is just the step's own list.
        next.categories = policy.categories ? wanted.filter(c => policy.categories.includes(c)) : wanted;
        // An intersection that empties out would scan for NOTHING and report
        // clean. Fall back to the org's list rather than pretend.
        if (!next.categories.length) next.categories = policy.categories;
    }
    const conf = Number(step.confidence);
    if (Number.isFinite(conf) && conf > (policy.confidence ?? 0)) next.confidence = conf;
    return next;
}

function safeJson(v) {
    try { return JSON.stringify(v); } catch { return String(v); }
}

function isPlainObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

module.exports = { execGuard, execTokenize, execUntokenize };
