// @typecheck
/**
 * Skill structure — the parsers, renderers and validators behind the
 * structured skill columns (Bee Flow Builder redesign, Sep 2026, Track S1).
 *
 * A skill used to be four free-text columns (instructions, workflow, rules,
 * examples). The Studio editor now works on STRUCTURE:
 *
 *   steps        [{ id, text, refs: [{ kind: 'automation'|'kb'|'table', id }] }]
 *   rules_v2     [{ id, polarity: 'must'|'never', text }]
 *   examples_v2  [{ id, question, good, rationale, bad?, violatedRuleId?, sourceConversationId? }]
 *   output_schema  { type: 'object', properties: { <key>: { type, title?, format?,
 *                    'x-unit'?, description?, enum?, items? } }, required?: [] } | null
 *
 * …while the runtime (`core/tools/skillInjection.js`) and the GitHub sync
 * still read the TEXT columns. This module is the bridge, and it is pure —
 * no database, no i18n — so both the store and the migration can call it and
 * a test can pin every rule without a Postgres.
 *
 * ── THE PRECEDENCE RULE (plan S1) ─────────────────────────────────────
 * Mobile does full CRUD with the six text fields and never sends structure
 * (mobile/src/features/skills/api.ts). Session-skill promotion creates rows
 * from text. The Studio editor sends structure. So, per FACET
 * (workflow↔steps, rules↔rules_v2, examples↔examples_v2):
 *   - a request that sends the STRUCTURE → the text is regenerated from it;
 *   - a request that sends only the TEXT → the text is parsed and both are
 *     stored (the text is the source);
 *   - a request that sends neither → the facet is left alone. NEVER
 *     regenerate text from the stored structure on a request that did not
 *     send it — that is exactly how a phone edit would be overwritten.
 * `resolveBodyWrite` is that rule as a function.
 *
 * A string in a structured column is never silently accepted (no JSON.parse
 * of request bodies here): `validate*` throws a SkillStructureError with
 * status 400 and the route answers it as such.
 *
 * ── THE PARSERS ARE HEURISTIC ─────────────────────────────────────────
 * They turn "1. Do X\n2. Do Y" into steps, sentences into rules (polarity
 * `never` on niet/geen/nooit/never/don't/do not), and an `Input:/Output:`
 * pattern into an example. They are for the one-time migration and for
 * text-only writers; the original text is never discarded, and the
 * renderers produce the SAME markdown a person would have typed, so a
 * migrated skill renders byte-identically in the prompt (pinned by
 * skillInjection.test.js).
 */

'use strict';

const crypto = require('crypto');

const REF_KINDS = Object.freeze(['automation', 'kb', 'table']);
const RULE_POLARITIES = Object.freeze(['must', 'never']);
const OUTPUT_TYPES = Object.freeze(['string', 'number', 'integer', 'boolean', 'array', 'object']);

const MAX_STEPS = 60;
const MAX_RULES = 60;
const MAX_EXAMPLES = 40;
const MAX_OUTPUT_FIELDS = 40;
const MAX_ENUM_OPTIONS = 50;
const MAX_ID_LIST = 100;
const MAX_TEXT = 4000;

class SkillStructureError extends Error {
    constructor(message, field, code = 'invalid_structure') {
        super(message);
        this.name = 'SkillStructureError';
        this.status = 400;
        this.code = code;
        this.field = field;
    }
}

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function cleanText(v, max = MAX_TEXT) {
    return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
}

// ── Parsers (text → structure) ───────────────────────────────────────

const LIST_MARKER_RE = /^\s*(?:(\d+)[.)]|[-*•]|step\s+\d+[:.]?|stap\s+\d+[:.]?)\s+/i;

/**
 * Split free text into ordered lines: a numbered / bulleted list becomes
 * one entry per marker; a paragraph without markers becomes one entry per
 * non-empty line. Continuation lines (indented, no marker) are folded into
 * the previous entry so a two-line step stays one step.
 */
function splitListLines(text) {
    const src = cleanText(text, Infinity);
    if (!src) return [];
    const out = [];
    const rawLines = src.split('\n');
    const hasMarkers = rawLines.some(l => LIST_MARKER_RE.test(l));
    for (const raw of rawLines) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) continue;
        if (hasMarkers) {
            if (LIST_MARKER_RE.test(line)) {
                out.push(line.replace(LIST_MARKER_RE, '').trim());
            } else if (out.length > 0) {
                out[out.length - 1] += ' ' + line.trim();
            } else {
                out.push(line.trim());
            }
        } else {
            out.push(line.trim());
        }
    }
    return out.filter(Boolean);
}

/** Split a paragraph into sentences (kept simple: . ! ? followed by whitespace + capital/quote/digit). */
function splitSentences(text) {
    const t = cleanText(text, Infinity);
    if (!t) return [];
    return t.split(/(?<=[.!?])\s+(?=[A-Z0-9"'«(\u00C0-\u00DE])/)
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * `workflow` text → steps. Each numbered / bulleted line is a step; a
 * marker-less paragraph becomes one step per line.
 * @param {string} text
 * @param {{ idFactory?: () => string }} [opts]
 */
function parseWorkflowToSteps(text, opts = {}) {
    const idFactory = typeof opts.idFactory === 'function' ? opts.idFactory : () => newId('step');
    return splitListLines(text).slice(0, MAX_STEPS).map(line => ({
        id: idFactory(),
        text: line.slice(0, MAX_TEXT),
        refs: [],
    }));
}

// Words that flip a rule to `never` (plan S1: niet/geen/nooit/never/don't).
const NEVER_RE = /\b(niet|geen|nooit|nimmer|never|don'?t|do not|must not|mustn'?t|shouldn'?t|should not|mag niet|mogen niet|verboden)\b/i;

/**
 * The marker `renderRulesToText` writes in front of a ban whose sentence does
 * not carry one, and reads back off it. Both product languages, because the
 * text column is also what a person edits by hand (and what mobile sends
 * back on every save).
 */
const NEVER_PREFIX_RE = /^\s*(?:never|nooit)\s*[:\u2014-]\s*/i;

function polarityOf(text) {
    return NEVER_RE.test(text) ? 'never' : 'must';
}

/**
 * `rules` text → rules_v2. Bulleted lines are rules; one long paragraph is
 * split into sentences. Polarity from the wording.
 */
function parseRulesToRulesV2(text, opts = {}) {
    const idFactory = typeof opts.idFactory === 'function' ? opts.idFactory : () => newId('rule');
    let lines = splitListLines(text);
    if (lines.length === 1) lines = splitSentences(lines[0]);
    return lines.slice(0, MAX_RULES).map(line => {
        // An explicit marker BEATS the wording: it is the only thing that
        // survives a ban whose sentence is affirmative ("Noem de interne
        // kortingscode" + the ban mark). Without this the round trip
        // structure → text → structure silently turns that ban into an
        // instruction to do it.
        const banned = NEVER_PREFIX_RE.test(line);
        const text = banned ? line.replace(NEVER_PREFIX_RE, '') : line;
        return {
            id: idFactory(),
            polarity: banned ? 'never' : polarityOf(text),
            text: text.slice(0, MAX_TEXT),
        };
    });
}

// Labels that open the parts of a worked example, in the two product languages.
const EX_Q_RE = /^\s*(?:input|question|q|user|vraag|invoer|gebruiker)\s*:\s*/i;
const EX_A_RE = /^\s*(?:output|answer|a|assistant|good|antwoord|uitvoer|goed(?: antwoord)?)\s*:\s*/i;
const EX_WHY_RE = /^\s*(?:why|rationale|reason|waarom|toelichting)\s*:\s*/i;
const EX_BAD_RE = /^\s*(?:bad|not like this|wrong|niet zo|fout|slecht(?: antwoord)?)\s*:\s*/i;

/**
 * `examples` text → examples_v2 via the `Input:/Output:` pattern (also
 * Q:/A:, Vraag:/Antwoord:, User:/Assistant:, + optional Why:/Not like this:).
 * Text without the pattern becomes ONE example whose `good` is the whole
 * text — nothing is dropped.
 */
function parseExamplesToExamplesV2(text, opts = {}) {
    const idFactory = typeof opts.idFactory === 'function' ? opts.idFactory : () => newId('ex');
    const src = cleanText(text, Infinity);
    if (!src) return [];
    const examples = [];
    /** @type {{ id: string, question: string, good: string, rationale: string, bad?: string } | null} */
    let cur = null;
    /** @type {'question' | 'good' | 'rationale' | 'bad' | null} */
    let field = null;
    const flush = () => {
        if (!cur) return;
        for (const k of ['question', 'good', 'rationale', 'bad']) if (typeof cur[k] === 'string') cur[k] = cur[k].trim().slice(0, MAX_TEXT);
        if (cur.question || cur.good) examples.push(cur);
        cur = null; field = null;
    };
    const open = () => { cur = { id: idFactory(), question: '', good: '', rationale: '' }; };
    for (const rawLine of src.split('\n')) {
        const line = rawLine.replace(/\s+$/, '');
        if (EX_Q_RE.test(line)) {
            if (cur && (cur.question || cur.good)) flush();
            if (!cur) open();
            field = 'question';
            cur.question = line.replace(EX_Q_RE, '');
            continue;
        }
        if (cur && EX_A_RE.test(line)) { field = 'good'; cur.good = line.replace(EX_A_RE, ''); continue; }
        if (cur && EX_WHY_RE.test(line)) { field = 'rationale'; cur.rationale = line.replace(EX_WHY_RE, ''); continue; }
        if (cur && EX_BAD_RE.test(line)) { field = 'bad'; cur.bad = line.replace(EX_BAD_RE, ''); continue; }
        if (cur && field) {
            if (!line.trim() && field !== 'good') continue;
            cur[field] = (cur[field] ? cur[field] + '\n' : '') + line;
        }
    }
    flush();
    if (examples.length === 0) {
        examples.push({ id: idFactory(), question: '', good: src.slice(0, MAX_TEXT), rationale: '' });
    }
    return examples.slice(0, MAX_EXAMPLES);
}

// ── Renderers (structure → text) ─────────────────────────────────────

function renderStepsToWorkflow(steps) {
    const list = Array.isArray(steps) ? steps : [];
    return list.map((s, i) => `${i + 1}. ${cleanText(s?.text)}`).join('\n');
}

/**
 * Rules → the text column and, through it, the prompt.
 *
 * A `never` rule whose SENTENCE does not say "never" gets the marker written
 * in front of it. Without it the ban mark stops at the database: the prompt
 * (`core/tools/skillInjection.js` → `Rules: - …`) and the grader
 * (`core/skills/skillTest.js` → "RULES THE ANSWER MUST RESPECT") both read a
 * bare bullet as something to DO, so "Noem de interne kortingscode" + the ban
 * mark instructed the agent to name the code and then graded it as a pass.
 *
 * Only that direction. A `must` rule that happens to contain "niet"/"not"
 * already says what it means in its own words; prefixing it with "Always:"
 * would fight the sentence instead of completing it. So the round trip
 * preserves every ban, and mislabels only the case where the marking already
 * contradicted the text.
 */
function renderRulesToText(rules) {
    const list = Array.isArray(rules) ? rules : [];
    return list.map(r => {
        const text = cleanText(r?.text);
        const marked = r?.polarity === 'never' && text && !NEVER_RE.test(text);
        return `- ${marked ? `Never: ${text}` : text}`;
    }).join('\n');
}

function renderExamplesToText(examples) {
    const list = Array.isArray(examples) ? examples : [];
    return list.map(ex => {
        const parts = [];
        if (isNonEmptyString(ex?.question)) parts.push(`Input: ${cleanText(ex.question)}`);
        if (isNonEmptyString(ex?.good)) parts.push(`Output: ${cleanText(ex.good)}`);
        if (isNonEmptyString(ex?.rationale)) parts.push(`Why: ${cleanText(ex.rationale)}`);
        if (isNonEmptyString(ex?.bad)) parts.push(`Not like this: ${cleanText(ex.bad)}`);
        return parts.join('\n');
    }).filter(Boolean).join('\n\n');
}

// ── Validators (request payload → clean structure, or a 400) ─────────

function requireArray(v, field) {
    if (!Array.isArray(v)) {
        throw new SkillStructureError(
            typeof v === 'string'
                ? `${field} must be an array, not a string`
                : `${field} must be an array`,
            field,
        );
    }
    return v;
}

function validateRefs(refs, field) {
    if (refs === undefined || refs === null) return [];
    requireArray(refs, field);
    const out = [];
    const seen = new Set();
    for (const [i, r] of refs.entries()) {
        if (!isObject(r)) throw new SkillStructureError(`${field}[${i}] must be an object`, field);
        if (!REF_KINDS.includes(r.kind)) throw new SkillStructureError(`${field}[${i}].kind must be one of ${REF_KINDS.join(', ')}`, field);
        if (!isNonEmptyString(r.id)) throw new SkillStructureError(`${field}[${i}].id is required`, field);
        const key = `${r.kind}:${r.id.trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: r.kind, id: r.id.trim() });
    }
    return out;
}

function ensureId(v, prefix, field, i) {
    if (v === undefined || v === null || v === '') return newId(prefix);
    if (!isNonEmptyString(v)) throw new SkillStructureError(`${field}[${i}].id must be a string`, field);
    return v.trim().slice(0, 64);
}

/** @returns {Array<{id:string,text:string,refs:Array<{kind:string,id:string}>}>} */
function validateSteps(v, field = 'steps') {
    requireArray(v, field);
    if (v.length > MAX_STEPS) throw new SkillStructureError(`${field}: at most ${MAX_STEPS} steps`, field);
    const ids = new Set();
    return v.map((s, i) => {
        if (!isObject(s)) throw new SkillStructureError(`${field}[${i}] must be an object`, field);
        if (typeof s.text !== 'string') throw new SkillStructureError(`${field}[${i}].text must be a string`, field);
        const id = ensureId(s.id, 'step', field, i);
        if (ids.has(id)) throw new SkillStructureError(`${field}[${i}].id "${id}" is duplicated`, field);
        ids.add(id);
        return { id, text: cleanText(s.text), refs: validateRefs(s.refs, `${field}[${i}].refs`) };
    });
}

/** @returns {Array<{id:string,polarity:'must'|'never',text:string}>} */
function validateRules(v, field = 'rulesV2') {
    requireArray(v, field);
    if (v.length > MAX_RULES) throw new SkillStructureError(`${field}: at most ${MAX_RULES} rules`, field);
    const ids = new Set();
    return v.map((r, i) => {
        if (!isObject(r)) throw new SkillStructureError(`${field}[${i}] must be an object`, field);
        if (typeof r.text !== 'string') throw new SkillStructureError(`${field}[${i}].text must be a string`, field);
        const polarity = r.polarity === undefined || r.polarity === null ? polarityOf(r.text) : r.polarity;
        if (!RULE_POLARITIES.includes(polarity)) throw new SkillStructureError(`${field}[${i}].polarity must be 'must' or 'never'`, field);
        const id = ensureId(r.id, 'rule', field, i);
        if (ids.has(id)) throw new SkillStructureError(`${field}[${i}].id "${id}" is duplicated`, field);
        ids.add(id);
        return { id, polarity, text: cleanText(r.text) };
    });
}

/** @returns {Array<{id,question,good,rationale,bad?,violatedRuleId?,sourceConversationId?}>} */
function validateExamples(v, field = 'examplesV2') {
    requireArray(v, field);
    if (v.length > MAX_EXAMPLES) throw new SkillStructureError(`${field}: at most ${MAX_EXAMPLES} examples`, field);
    const ids = new Set();
    return v.map((ex, i) => {
        if (!isObject(ex)) throw new SkillStructureError(`${field}[${i}] must be an object`, field);
        for (const k of ['question', 'good', 'rationale', 'bad', 'violatedRuleId', 'sourceConversationId']) {
            if (ex[k] !== undefined && ex[k] !== null && typeof ex[k] !== 'string') {
                throw new SkillStructureError(`${field}[${i}].${k} must be a string`, field);
            }
        }
        const id = ensureId(ex.id, 'ex', field, i);
        if (ids.has(id)) throw new SkillStructureError(`${field}[${i}].id "${id}" is duplicated`, field);
        ids.add(id);
        const out = {
            id,
            question: cleanText(ex.question),
            good: cleanText(ex.good),
            rationale: cleanText(ex.rationale),
        };
        if (isNonEmptyString(ex.bad)) out.bad = cleanText(ex.bad);
        if (isNonEmptyString(ex.violatedRuleId)) out.violatedRuleId = ex.violatedRuleId.trim().slice(0, 64);
        if (isNonEmptyString(ex.sourceConversationId)) out.sourceConversationId = ex.sourceConversationId.trim().slice(0, 128);
        return out;
    });
}

/**
 * `output_schema`: the same JSON-schema shape as `ai_step.outputSchema`
 * (automation/builderTools/schemas.js). `null` means "this skill yields no
 * fields" — the default, and what R2 reads as "keep the step's own schema".
 * @returns {null | {type:'object', properties: Object, required?: string[]}}
 */
function validateOutputSchema(v, field = 'outputSchema') {
    if (v === undefined || v === null) return null;
    if (!isObject(v)) {
        throw new SkillStructureError(
            typeof v === 'string' ? `${field} must be an object, not a string` : `${field} must be an object`,
            field,
        );
    }
    if (v.type !== undefined && v.type !== 'object') throw new SkillStructureError(`${field}.type must be 'object'`, field);
    const props = v.properties === undefined || v.properties === null ? {} : v.properties;
    if (!isObject(props)) throw new SkillStructureError(`${field}.properties must be an object`, field);
    const keys = Object.keys(props);
    if (keys.length === 0) return null;
    if (keys.length > MAX_OUTPUT_FIELDS) throw new SkillStructureError(`${field}: at most ${MAX_OUTPUT_FIELDS} fields`, field);
    const properties = {};
    for (const key of keys) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new SkillStructureError(`${field}.properties: "${key}" is not a valid field key`, field);
        const p = props[key];
        if (!isObject(p)) throw new SkillStructureError(`${field}.properties.${key} must be an object`, field);
        if (!OUTPUT_TYPES.includes(p.type)) throw new SkillStructureError(`${field}.properties.${key}.type must be one of ${OUTPUT_TYPES.join(', ')}`, field);
        const clean = { type: p.type };
        for (const k of ['title', 'format', 'x-unit', 'description']) {
            if (p[k] === undefined || p[k] === null) continue;
            if (typeof p[k] !== 'string') throw new SkillStructureError(`${field}.properties.${key}.${k} must be a string`, field);
            const s = p[k].trim().slice(0, 200);
            if (s) clean[k] = s;
        }
        if (p.type === 'array' && isObject(p.items) && OUTPUT_TYPES.includes(p.items.type)) clean.items = { type: p.items.type };
        // `enum` is kept because it is what makes a field a CHOICE rather than
        // text: `mapping/fieldKinds.expectedKindFor` reads type, format, enum
        // and items.type, and nothing else. Dropping it would turn every
        // dropdown a skill declares into a free-text field downstream.
        if (Array.isArray(p.enum)) {
            const options = p.enum
                .filter(v => typeof v === 'string' || typeof v === 'number')
                .map(v => (typeof v === 'string' ? v.slice(0, 200) : v))
                .slice(0, MAX_ENUM_OPTIONS);
            if (options.length) clean.enum = options;
        }
        properties[key] = clean;
    }
    /** @type {{ type: 'object', properties: any, required?: string[] }} */
    const out = { type: 'object', properties };
    if (Array.isArray(v.required)) {
        const req = v.required.filter(k => typeof k === 'string' && properties[k]);
        if (req.length) out.required = req;
    }
    return out;
}

/** A list of ids (knowledge_base_ids, allowed_automation_ids): strings, trimmed, deduped, capped. */
function validateIdList(v, field) {
    if (v === undefined || v === null) return [];
    requireArray(v, field);
    const seen = new Set();
    const out = [];
    for (const [i, raw] of v.entries()) {
        if (typeof raw !== 'string') throw new SkillStructureError(`${field}[${i}] must be a string`, field);
        const id = raw.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id.slice(0, 128));
        if (out.length >= MAX_ID_LIST) break;
    }
    return out;
}

// ── The precedence rule ───────────────────────────────────────────────

/**
 * Decide, per facet, which columns a create/update writes.
 *
 * @param {{ workflow?, rules?, examples?, steps?, rulesV2?, examplesV2? }} body
 *        raw request fields; `undefined` = not sent.
 * @param {{ idFactory?: () => string }} [opts]
 * @returns {{
 *   workflow?: string, steps?: Array,
 *   rules?: string, rulesV2?: Array,
 *   examples?: string, examplesV2?: Array,
 * }} only the facets the request touched are present.
 */
function resolveBodyWrite(body, opts = {}) {
    const b = body || {};
    const out = {};
    const facets = [
        { text: 'workflow', struct: 'steps', validate: validateSteps, parse: parseWorkflowToSteps, render: renderStepsToWorkflow },
        { text: 'rules', struct: 'rulesV2', validate: validateRules, parse: parseRulesToRulesV2, render: renderRulesToText },
        { text: 'examples', struct: 'examplesV2', validate: validateExamples, parse: parseExamplesToExamplesV2, render: renderExamplesToText },
    ];
    for (const f of facets) {
        const structSent = b[f.struct] !== undefined;
        const textSent = b[f.text] !== undefined;
        if (structSent) {
            // A string in a structured column is a 400, never a silent "parse it for me".
            const clean = f.validate(b[f.struct] === null ? [] : b[f.struct], f.struct);
            out[f.struct] = clean;
            out[f.text] = f.render(clean);
        } else if (textSent) {
            if (b[f.text] !== null && typeof b[f.text] !== 'string') {
                throw new SkillStructureError(`${f.text} must be a string`, f.text);
            }
            const text = b[f.text] == null ? '' : b[f.text];
            out[f.text] = text;
            out[f.struct] = f.parse(text, opts);
        }
    }
    return out;
}

/** Text for the prompt / sync: the stored text, or — if a row has structure but no text — a render of it. */
function textOrRender(text, structure, render) {
    if (typeof text === 'string' && text.trim()) return text;
    if (Array.isArray(structure) && structure.length > 0) return render(structure);
    return '';
}

/** Table refs across all steps: `[{ id, scope:'own', readOnly:true }]` (deduped). */
function tableRefsOf(steps) {
    const out = [];
    const seen = new Set();
    for (const s of Array.isArray(steps) ? steps : []) {
        for (const r of Array.isArray(s?.refs) ? s.refs : []) {
            if (r?.kind !== 'table' || !isNonEmptyString(r.id) || seen.has(r.id)) continue;
            seen.add(r.id);
            out.push({ id: r.id, scope: 'own', readOnly: true });
        }
    }
    return out;
}

/** Ids of one ref kind across all steps (deduped). */
function refIdsOf(steps, kind) {
    const out = [];
    const seen = new Set();
    for (const s of Array.isArray(steps) ? steps : []) {
        for (const r of Array.isArray(s?.refs) ? s.refs : []) {
            if (r?.kind !== kind || !isNonEmptyString(r.id) || seen.has(r.id)) continue;
            seen.add(r.id);
            out.push(r.id);
        }
    }
    return out;
}

module.exports = {
    SkillStructureError,
    REF_KINDS,
    RULE_POLARITIES,
    OUTPUT_TYPES,
    MAX_STEPS,
    MAX_RULES,
    MAX_EXAMPLES,
    parseWorkflowToSteps,
    parseRulesToRulesV2,
    parseExamplesToExamplesV2,
    renderStepsToWorkflow,
    renderRulesToText,
    renderExamplesToText,
    validateSteps,
    validateRules,
    validateExamples,
    validateOutputSchema,
    validateIdList,
    resolveBodyWrite,
    textOrRender,
    tableRefsOf,
    refIdsOf,
    polarityOf,
    // exported for tests
    _splitListLines: splitListLines,
    _splitSentences: splitSentences,
};
