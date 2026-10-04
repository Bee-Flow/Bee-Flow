// @typecheck
'use strict';
/**
 * Evidence card: the ONLY view of a candidate the naming LLM gets to see.
 *
 * Built field by field from an explicit allow-list, never by copying the
 * candidate and deleting what looks sensitive: a field the miner gains next
 * year must not ride along to a model. Strings are re-checked on the way out
 * (no address, no URL, bounded length), and sender domains appear only as
 * "domain A", "domain B", lettered per card.
 *
 * Pure: no I/O.
 */

const CADENCE_KINDS = new Set(['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'irregular']);
const KINDS = new Set(['sequence', 'mail_template', 'file_drop', 'meeting_followup']);
const TRIGGER_KINDS = new Set(['schedule', 'app', 'manual']);
const STEP_FAMILIES = new Set(['app', 'ai', 'data', 'branch']);
const CONFIDENCE = new Set(['early', 'normal', 'high']);

// An address, or a link of any scheme (templating masks both; this is the
// last check before a model).
const UNSAFE_RE = /@|[a-z][a-z0-9+.-]*:\/\/|www\./i;
const ID_RE = /^[\p{L}\p{N}_.:-]{1,80}$/u;

/** A string that is safe to show a model, or null. */
function safeText(s, max = 160) {
    if (typeof s !== 'string') return null;
    const t = s.replace(/\s+/g, ' ').trim();
    if (!t || UNSAFE_RE.test(t)) return null;
    return t.slice(0, max);
}

const safeId = (s) => (typeof s === 'string' && ID_RE.test(s) ? s : null);
const num = (x, digits = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** digits) / 10 ** digits : 0);
const int = (x) => (Number.isFinite(x) ? Math.round(x) : 0);
const ids = (list, max = 8) => (Array.isArray(list) ? list.map(safeId).filter(Boolean).slice(0, max) : []);

function cardDraft(d) {
    if (!d || typeof d !== 'object' || !d.trigger) return null;
    const tk = TRIGGER_KINDS.has(d.trigger.kind) ? d.trigger.kind : 'manual';
    /** @type {{ kind: string, app?: string, label: string }} */
    const trigger = { kind: tk, label: safeText(d.trigger.label, 60) || '' };
    const tApp = safeId(d.trigger.app);
    if (tApp) trigger.app = tApp;
    const steps = (Array.isArray(d.steps) ? d.steps : []).slice(0, 6).map((s) => {
        /** @type {{ family: string, app?: string, label: string }} */
        const step = { family: STEP_FAMILIES.has(s?.family) ? s.family : 'app', label: safeText(s?.label, 60) || '' };
        const app = safeId(s?.app);
        if (app) step.app = app;
        return step;
    });
    return { trigger, steps };
}

/**
 * Replace each real or pseudonymised domain with a letter, in order of first
 * appearance: "domain A", "domain B" in the list, <domain:A> in the template
 * (the placeholder form the client highlights). Both use one map, so the
 * template's <domain:A> is the list's "domain A".
 */
function letterDomains(domains, template) {
    /** @type {Map<string, string>} */
    const map = new Map();
    const letter = (d) => {
        if (!map.has(d)) map.set(d, String.fromCharCode(65 + (map.size % 26)));
        return map.get(d);
    };
    const pseudo = [...new Set((Array.isArray(domains) ? domains : []).filter((d) => typeof d === 'string' && d))].slice(0, 8);
    const list = pseudo.map((d) => `domain ${letter(d)}`);
    let tpl = template;
    if (typeof tpl === 'string') tpl = tpl.replace(/<domain:([^>]+)>/g, (_, d) => `<domain:${letter(d)}>`);
    return { domains: list, template: tpl };
}

/**
 * @param {any} c a scored, mapped candidate
 * @returns {Record<string, any>}
 */
function toEvidenceCard(c) {
    const cad = c?.cadence || {};
    const { domains, template } = letterDomains(c?.domains, c?.template);
    /** @type {{ kind: string, weekday?: number, hourBand?: [number, number] }} */
    const cadence = { kind: CADENCE_KINDS.has(cad.kind) ? cad.kind : 'irregular' };
    if (Number.isInteger(cad.weekday) && cad.weekday >= 0 && cad.weekday <= 6) cadence.weekday = cad.weekday;
    if (Array.isArray(cad.hourBand) && cad.hourBand.length === 2) cadence.hourBand = [int(cad.hourBand[0]), int(cad.hourBand[1])];
    const hist = Array.isArray(cad.weekdayHistogram) && cad.weekdayHistogram.length === 7
        ? cad.weekdayHistogram.map(int) : [0, 0, 0, 0, 0, 0, 0];
    const range = Array.isArray(c?.minutes?.range) ? [int(c.minutes.range[0]), int(c.minutes.range[1])] : null;

    return {
        kind: KINDS.has(c?.kind) ? c.kind : 'sequence',
        template: safeText(template),
        apps: ids(c?.apps),
        verbs: ids(c?.verbs),
        domains,
        occurrences: int(c?.occurrences),
        distinctDays: int(c?.distinctDays),
        perMonth: num(cad.perMonth),
        cadence,
        weeksPresent: int(cad.weeksPresent),
        weeksWindow: int(cad.weeksWindow),
        weekdayHistogram: hist,
        minutes: range ? { range, basis: c.minutes.basis === 'measured' ? 'measured' : 'heuristic' } : null,
        draft: cardDraft(c?.draft),
        confidence: CONFIDENCE.has(c?.confidence) ? c.confidence : 'normal',
    };
}

/** Every key a card may carry, for tests and for the naming prompt's schema. */
const CARD_KEYS = Object.freeze([
    'kind', 'template', 'apps', 'verbs', 'domains', 'occurrences', 'distinctDays', 'perMonth', 'cadence',
    'weeksPresent', 'weeksWindow', 'weekdayHistogram', 'minutes', 'draft', 'confidence',
]);

module.exports = { toEvidenceCard, CARD_KEYS, safeText };
