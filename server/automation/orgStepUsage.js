/**
 * What an organisation's automations are made of, for the builder's "Frequently
 * used" (Studio → Automations handoff 5):
 *
 *   - stepCounts: how often each step kind and each integration action occurs
 *     across the org's automations, as the ribbon's usage keys
 *     ('step:ai_step', 'action:nextcloud_list_files', 'block:<id>');
 *   - valueCounts: for each (tool, input) the literal values the org typed in
 *     (folder paths, board ids), for the chips under a setting in the step
 *     drawer.
 *
 * Read from the saved definitions (the working copies), not from runs: a
 * automation that has not run yet still says what people build here, and a
 * definition holds settings, never run data.
 *
 * Privacy: values are visible to everyone in the org, so a value that looks
 * like personal data (an e-mail address, a phone number, an IBAN, a postcode,
 * an IP address) or like a credential is never counted. Bindings, templates
 * and anything long or multi-line are skipped too: a chip is for a short,
 * reusable setting. Two more rules cover what no pattern can see, a person's
 * name ("/HR/Jan de Vries"):
 *   - settings that hold free text or people (to, subject, body, prompt,
 *     name, title, ...) are never counted at all;
 *   - someone else's value is only offered once at least TWO people in the
 *     organisation use it. A value only one colleague typed stays theirs; the
 *     caller always sees their own.
 *
 * Both aggregates come from ONE pass over the definitions and are cached per
 * scope (organisation, or the user on a personal install) for a few minutes.
 */

'use strict';

const { walkSteps } = require('./automationGraph');

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_SCOPES = 500;
const MAX_AUTOMATIONS = 2000;
const MAX_STEP_ROWS = 60;
const MAX_VALUE_ROWS = 5;
const MAX_VALUE_LENGTH = 120;
// Distinct values remembered per (tool, input); the rest are dropped at load.
const MAX_VALUES_PER_INPUT = 200;

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;
// Settings whose values are free text or name a person: never chips.
const FREE_TEXT_INPUT_RE = /^(to|cc|bcc|recipients?|attendees?|participants?|assignees?|members?|users?|user|owner|from|replyTo|sender|subject|body|message|text|content|html|markdown|prompt|systemPrompt|instructions|question|answer|reply|query|q|search|name|firstName|lastName|fullName|displayName|email|emails|phone|mobile|address|comment|comments|description|note|notes|title|caption|summary|label|labels)$/i;
// A value typed by fewer distinct people than this is not offered to others.
const MIN_SHARED_OWNERS = 2;
// Canvas-only step kinds: a sticky note is not something anyone "uses".
const IGNORED_STEP_TYPES = new Set(['note']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The ribbon's usage key for a step (agent-hub flow/stepUsage.js getUsageKey), or null. */
function usageKeyOf(step) {
    const type = typeof step?.type === 'string' ? step.type : '';
    if (!type || !NAME_RE.test(type) || IGNORED_STEP_TYPES.has(type)) return null;
    if (type === 'integration_action') {
        return typeof step.tool === 'string' && NAME_RE.test(step.tool) ? `action:${step.tool}` : null;
    }
    if (type === 'call_block') {
        const id = step.blockId;
        return (typeof id === 'string' && id && id.length <= 64) ? `block:${id}` : null;
    }
    // A flowlet (call_layer) is local to its automation: counting its key across
    // the org would offer a flowlet that does not exist in the next automation.
    if (type === 'call_layer') return null;
    return `step:${type}`;
}

// ── Personal-data and credential screen ──────────────────────────────────

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/;
const NL_POSTCODE_RE = /\b\d{4}\s?[A-Z]{2}\b/;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i;
// A run of digits with phone-style separators, 9 digits or more.
const PHONE_RUN_RE = /\+?\d[\d\s().-]{7,}\d/g;
// A long run without spaces or slashes: a candidate credential (API key,
// share token, JWT segment). Paths are split on '/' first, so a deep folder
// path is not one long run.
const TOKEN_RUN_RE = /[A-Za-z0-9_\-+=.]{20,}/g;
const charClass = (c) => (/[a-z]/.test(c) ? 1 : /[A-Z]/.test(c) ? 2 : /[0-9]/.test(c) ? 3 : 0);

function looksLikePhone(s) {
    const runs = s.match(PHONE_RUN_RE) || [];
    return runs.some((run) => run.replace(/\D/g, '').length >= 9);
}

/**
 * A credential mixes letters and digits all the way through; a readable name
 * ("Invoices_2026_Q3_archive") changes between them only at word breaks.
 * Long hex (a hash, a key) counts regardless.
 */
function looksLikeToken(s) {
    for (const part of s.split('/')) {
        for (const run of part.match(TOKEN_RUN_RE) || []) {
            if (/^[0-9a-f]{32,}$/i.test(run)) return true;
            if (!/[A-Za-z]/.test(run) || !/\d/.test(run)) continue;
            const chars = run.replace(/[^A-Za-z0-9]/g, '');
            let changes = 0;
            for (let i = 1; i < chars.length; i++) if (charClass(chars[i]) !== charClass(chars[i - 1])) changes++;
            if (chars.length >= 20 && changes / chars.length >= 0.25) return true;
        }
    }
    return false;
}

/**
 * True when a value must not be offered to the rest of the org: personal
 * data, a credential, or something that only makes sense once.
 */
function isUnsafeValue(s) {
    if (EMAIL_RE.test(s)) return true;
    if (IBAN_RE.test(s.replace(/\s+/g, '').toUpperCase())) return true;
    if (NL_POSTCODE_RE.test(s)) return true;
    if (IPV4_RE.test(s) || IPV6_RE.test(s)) return true;
    if (looksLikePhone(s)) return true;
    if (looksLikeToken(s)) return true;
    // A URL with a query string or credentials can carry a token or a name.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /[?#@]/.test(s)) return true;
    return false;
}

/** The literal a setting holds, as a chip would show it, or null. */
function chipValueOf(v) {
    let raw = v;
    if (isObj(v)) {
        if (v.kind !== 'literal') return null;          // ref / template / expr
        raw = v.value;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || s.length > MAX_VALUE_LENGTH || /[\r\n]/.test(s)) return null;
    if (s.includes('{{') || s.startsWith('=')) return null;   // a template or a formula
    if (isUnsafeValue(s)) return null;
    return s;
}

// ── Aggregation ──────────────────────────────────────────────────────────

/** `{ definition, ownerId }` from the loader, or a bare definition (owner unknown). */
function entryOf(e) {
    if (isObj(e) && 'ownerId' in e && isObj(e.definition)) return { def: e.definition, ownerId: e.ownerId ? String(e.ownerId) : null };
    return { def: e, ownerId: null };
}

/**
 * One pass over the definitions.
 * @param {unknown[]} definitions  bare definitions, or `{ definition, ownerId }`
 * @returns {{ steps: Array<{ key: string, count: number }>, values: Map<string, Map<string, Map<string, { count: number, owners: Set<string|null> }>>> }}
 */
function aggregate(definitions) {
    const stepCounts = new Map();
    /** tool → input → value → { count, owners } */
    const values = new Map();
    for (const entry of Array.isArray(definitions) ? definitions : []) {
        const { def, ownerId } = entryOf(entry);
        if (!isObj(def)) continue;
        walkSteps(def, (step) => {
            const key = usageKeyOf(step);
            if (key) stepCounts.set(key, (stepCounts.get(key) || 0) + 1);
            const tool = typeof step.tool === 'string' && NAME_RE.test(step.tool) ? step.tool
                : (typeof step.type === 'string' && NAME_RE.test(step.type) ? step.type : null);
            if (!tool || !isObj(step.inputs)) return;
            for (const [input, v] of Object.entries(step.inputs)) {
                if (!NAME_RE.test(input) || FREE_TEXT_INPUT_RE.test(input)) continue;
                const value = chipValueOf(v);
                if (value == null) continue;
                let byInput = values.get(tool);
                if (!byInput) { byInput = new Map(); values.set(tool, byInput); }
                let byValue = byInput.get(input);
                if (!byValue) { byValue = new Map(); byInput.set(input, byValue); }
                if (byValue.has(value) || byValue.size < MAX_VALUES_PER_INPUT) {
                    const hit = byValue.get(value) || { count: 0, owners: new Set() };
                    hit.count += 1;
                    hit.owners.add(ownerId);
                    byValue.set(value, hit);
                }
            }
        });
    }
    const steps = [...stepCounts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
        .slice(0, MAX_STEP_ROWS);
    return { steps, values };
}

/**
 * The top values for (tool, input) from an aggregate, most used first.
 * With `viewerId`, a value is offered only when the viewer uses it too, or at
 * least MIN_SHARED_OWNERS known people do (see the header).
 */
function topValues(agg, tool, input, limit = MAX_VALUE_ROWS, { viewerId = null } = {}) {
    const byValue = agg?.values?.get(tool)?.get(String(input).replace(/^inputs\./, ''));
    if (!byValue) return [];
    const shareable = (owners) => {
        if (viewerId == null) return true;
        if (owners.has(String(viewerId))) return true;
        let known = 0;
        for (const o of owners) if (o != null) known++;
        return known >= MIN_SHARED_OWNERS;
    };
    return [...byValue.entries()]
        .filter(([, hit]) => shareable(hit.owners))
        .map(([value, hit]) => ({ value, count: hit.count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, limit);
}

// ── Loading + cache ──────────────────────────────────────────────────────

/**
 * The saved definitions of every live (not trashed) automation and Step in the
 * scope. Legacy rows stamped without an organisation count for their owner's.
 */
async function loadDefinitionsFromDb({ orgId, userId }) {
    const { getAll } = require('../db');
    const rows = orgId
        ? await getAll(
            `SELECT a.definition_json, a.user_id FROM automations a
               LEFT JOIN users u ON u.id = a.user_id
              WHERE a.deleted_at IS NULL
                AND COALESCE(a.organization_id, u."organizationId") = $1
              ORDER BY a.updated_at DESC
              LIMIT ${MAX_AUTOMATIONS}`,
            [orgId],
        )
        : await getAll(
            `SELECT a.definition_json, a.user_id FROM automations a
              WHERE a.deleted_at IS NULL AND a.user_id = $1
              ORDER BY a.updated_at DESC
              LIMIT ${MAX_AUTOMATIONS}`,
            [userId],
        );
    return rows.map((r) => {
        let d = r.definition_json;
        if (typeof d === 'string') {
            try { d = JSON.parse(d); } catch { d = null; }
        }
        return { definition: d, ownerId: r.user_id || null };
    });
}

/**
 * @param {{ loadDefinitions?: (scope: { orgId: string|null, userId: string }) => Promise<unknown[]>,
 *           now?: () => number, ttlMs?: number }} [deps]
 */
function makeOrgStepUsage(deps = {}) {
    const loadDefinitions = deps.loadDefinitions || loadDefinitionsFromDb;
    const now = deps.now || Date.now;
    const ttlMs = deps.ttlMs ?? CACHE_TTL_MS;
    /** scopeKey → { at, promise } */
    const cache = new Map();

    function scopeKey({ orgId, userId }) {
        return orgId ? `org:${orgId}` : `user:${userId}`;
    }

    /** The aggregate for a scope, from cache when fresh. Concurrent callers share one load. */
    function aggregateFor(scope) {
        const key = scopeKey(scope);
        const hit = cache.get(key);
        if (hit && now() - hit.at < ttlMs) return hit.promise;
        const promise = Promise.resolve()
            .then(() => loadDefinitions(scope))
            .then(aggregate);
        // A failed load is not cached: the next request tries again.
        promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
        cache.delete(key);
        cache.set(key, { at: now(), promise });
        while (cache.size > CACHE_MAX_SCOPES) cache.delete(cache.keys().next().value);
        return promise;
    }

    return {
        async stepUsage(scope) {
            return (await aggregateFor(scope)).steps;
        },
        async valueUsage(scope, tool, input) {
            // A personal install holds only the caller's own automations.
            const viewerId = scope?.orgId ? scope.userId : null;
            return topValues(await aggregateFor(scope), tool, input, MAX_VALUE_ROWS, { viewerId });
        },
        clear() { cache.clear(); },
    };
}

module.exports = {
    makeOrgStepUsage,
    aggregate,
    topValues,
    usageKeyOf,
    chipValueOf,
    isUnsafeValue,
    FREE_TEXT_INPUT_RE,
    MIN_SHARED_OWNERS,
    CACHE_TTL_MS,
    MAX_VALUE_ROWS,
};
