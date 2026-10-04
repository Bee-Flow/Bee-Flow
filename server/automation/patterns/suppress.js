// @typecheck
'use strict';
/**
 * Suppress: keep the user from seeing a pattern they have already dealt with.
 *
 * patternSignature(c) is the stable key feedback is stored under:
 * sha256(kind | sorted normalised apps | sorted templateIds | cadence kind),
 * plus the verb list for a sequence (which has no template). It depends only
 * on what the miner found, never on the LLM's wording, so "Not now" sticks
 * across scans that name the pattern differently.
 *
 * suppressCandidates hides a candidate when:
 *   - every tool it uses already runs inside an automation (ledger rows with
 *     an automation_id: strong and cheap)
 *   - one of the user's automations covers its apps with a compatible trigger
 *   - feedback on its signature says built, dismissed, do_myself,
 *     already_automated, privacy, or an unexpired snooze
 * and halves the score on wrong_grouping (the grouping was off, the work may
 * still be real).
 *
 * Pure: no I/O.
 */

const crypto = require('crypto');
const { normaliseApp } = require('./builderMapping');

const SUPPRESSING_REASONS = new Set(['do_myself', 'already_automated', 'privacy']);
const WRONG_GROUPING_FACTOR = 0.5;

/**
 * @param {{ kind: string, apps?: string[], templateIds?: string[], verbs?: string[], cadence?: { kind?: string } }} c
 * @returns {string} 32 hex characters
 */
function patternSignature(c) {
    const parts = [
        c.kind,
        // Either spelling of an app id gives the same signature.
        [...new Set((c.apps || []).map(normaliseApp))].sort().join(','),
        [...(c.templateIds || [])].sort().join(','),
        c.cadence?.kind || '',
    ];
    if (c.kind === 'sequence') parts.push((c.verbs || []).join('>'));
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/** Tool verbs are tool names; event verbs (mail.received, …) carry a dot. */
const toolVerbs = (c) => (c.verbs || []).filter((v) => !v.includes('.'));

/** The automation trigger kinds a draft trigger kind can be served by. */
const TRIGGER_COMPAT = {
    schedule: new Set(['schedule']),
    app: new Set(['app_event', 'webhook']),
    manual: new Set(['manual', 'schedule', 'app_event', 'webhook']),
};

function coveredByAutomation(c, automations) {
    // Ledger ids (google_drive) and catalogue ids (google-drive) are one app.
    const apps = (c.apps || []).map(normaliseApp);
    if (!apps.length) return false;
    const draftKind = c.draft?.trigger?.kind || null;
    return (automations || []).some((a) => {
        const aApps = new Set((a?.apps || []).map(normaliseApp));
        if (!aApps.size || !apps.every((x) => aApps.has(x))) return false;
        if (!draftKind || !a.triggerKind) return true;
        return TRIGGER_COMPAT[draftKind]?.has(a.triggerKind) ?? true;
    });
}

/**
 * @param {{
 *   candidates: any[],
 *   automatedToolNames?: Set<string>,
 *   automations?: Array<{ title?: string, triggerKind?: string, apps?: string[] }>,
 *   feedback?: Array<{ signature?: string, action: string, reasonCode?: string|null, snoozeUntil?: number|string|null }>,
 *   now?: number,
 * }} input
 * @returns {{ kept: any[], suppressed: Array<{ signature: string, reason: string }> }}
 */
function suppressCandidates(input) {
    const now = input.now ?? Date.now();
    const automated = input.automatedToolNames || new Set();
    /** @type {Map<string, Array<any>>} */
    const fb = new Map();
    for (const f of input.feedback || []) {
        if (!f?.signature) continue;
        const list = fb.get(f.signature) || [];
        list.push(f);
        fb.set(f.signature, list);
    }

    const kept = [];
    const suppressed = [];
    for (const raw of input.candidates || []) {
        const signature = raw.signature || patternSignature(raw);
        const c = { ...raw, signature };
        const tools = toolVerbs(c);
        if (tools.length && tools.every((t) => automated.has(t))) {
            suppressed.push({ signature, reason: 'automated_tools' });
            continue;
        }
        if (coveredByAutomation(c, input.automations)) {
            suppressed.push({ signature, reason: 'existing_automation' });
            continue;
        }
        let reason = null;
        let downWeight = false;
        for (const f of fb.get(signature) || []) {
            if (f.action === 'built') reason = 'built';
            else if (f.action === 'snoozed') {
                const until = f.snoozeUntil == null ? null : new Date(f.snoozeUntil).getTime();
                if (until == null || !Number.isFinite(until) || until > now) reason = reason || 'snoozed';
            } else if (f.action === 'dismissed') {
                if (f.reasonCode === 'wrong_grouping') downWeight = true;
                else reason = reason || (SUPPRESSING_REASONS.has(f.reasonCode) ? f.reasonCode : 'dismissed');
            }
        }
        if (reason) {
            suppressed.push({ signature, reason });
            continue;
        }
        if (downWeight && typeof c.score === 'number') c.score = Math.round(c.score * WRONG_GROUPING_FACTOR * 1000) / 1000;
        if (downWeight) c.downWeighted = true;
        kept.push(c);
    }
    return { kept, suppressed };
}

module.exports = { patternSignature, suppressCandidates, WRONG_GROUPING_FACTOR };
