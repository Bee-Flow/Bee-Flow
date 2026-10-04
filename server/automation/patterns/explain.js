// @typecheck
'use strict';
/**
 * Explain: the ONE model call of a pattern scan. The miner decided what
 * repeats; the model only puts it into words: a title, one sentence on why,
 * and the build prompt the builder receives.
 *
 * What the model sees is the evidence cards (evidenceCard.js), nothing else:
 * templates with placeholders, app ids, counts and a draft. The messages go
 * through the Privacy Shield first (the caller's `guard`, guardAiInput on the
 * messages array); a guard that blocks or fails means no call, and every
 * pattern gets its deterministic name instead.
 *
 * What comes back is untrusted:
 *   - zod-validated item by item, so one malformed entry costs only itself;
 *   - Shield tokens ([person_1], [REDACTED:…]) become plain nouns (stripTokens);
 *   - a sentence with an address or a link is dropped;
 *   - a number the card does not hold is the model inventing a measurement:
 *     its sentence is dropped (the title falls back whole), because the page
 *     shows the server's numbers and two sets would contradict each other.
 * Whatever does not survive falls back to fallbackName / fallbackExplanation,
 * which never call anything.
 *
 * Call parameters: maxTokens 4096 and reasoningEffort 'none'. A self-hosted
 * Qwen3 otherwise thinks by template default, spends the whole budget on
 * reasoning and returns no tool call at all.
 */

const { z } = require('zod');
const log = require('../../telemetry/log');
const { toEvidenceCard } = require('./evidenceCard');
const { normaliseApp, humaniseTool } = require('./builderMapping');
const { stripTokens } = require('../suggestions');
const { TOOL_REGISTRY } = require('../toolRegistry');

const MAX_TITLE = 80;
const MAX_WHY = 200;
const MAX_PROMPT = 1200;
// Refs are letters, so the prompt itself adds no digits a model could echo.
const MAX_CARDS = 26;
const NAMING_OPTIONS = Object.freeze({ maxTokens: 4096, temperature: 0.2, reasoningEffort: 'none' });

const NAME_PATTERNS_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'name_patterns',
        description: 'Name and explain each repeating-work pattern card.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['patterns'],
            properties: {
                patterns: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['ref', 'title', 'why', 'buildPrompt'],
                        properties: {
                            ref: { type: 'string', description: 'The ref of the card you are naming, e.g. "A".' },
                            title: { type: 'string', description: 'A short, plain name for the automation that takes this work over. At most 8 words, no numbers.' },
                            why: { type: 'string', description: 'One sentence on what repeats and why automating it helps. No numbers.' },
                            buildPrompt: { type: 'string', description: 'A complete instruction for the automation builder: the trigger, each step in order and what flows between them.' },
                        },
                    },
                },
            },
        },
    },
});

const SYSTEM_PROMPT = [
    'You name repeating work that a deterministic analysis found in one person\'s own activity.',
    'Each card describes one pattern: what kind it is, the apps and actions involved, how often and how regularly it happened, and a draft automation (trigger and steps).',
    'Placeholders such as <n>, <date>, <id>, <name>, <org>, <email>, <url>, <domain>, <*> and <domain:A> stand for values that vary or were hidden. Never guess what they stand for.',
    '',
    'Call name_patterns exactly once, with one entry per card:',
    '- ref: the card\'s ref.',
    '- title: a short, plain name for the automation that would take this work over (at most 8 words, no numbers, no placeholders).',
    '- why: one sentence for a non-technical reader on what repeats and why automating it helps. No numbers: the page shows the measured numbers itself.',
    '- buildPrompt: a complete, self-contained instruction for an automation builder: the trigger, each step in order and what flows between the steps, based only on the card. You may quote the template with its placeholders.',
    '',
    'Rules: write in English. Use only what the cards say. Never invent people, companies, addresses, links, amounts or numbers. Never compute new numbers from the card.',
].join('\n');

// ── App names ────────────────────────────────────────────────────────────────

/** @type {Map<string, string>} */
const APP_LABELS = new Map([
    ...TOOL_REGISTRY.map((e) => /** @type {[string, string]} */ ([e.app, e.label])),
    ['teams', 'Microsoft Teams'],
    ['gmeet', 'Google Meet'],
    ['meetings', 'Meeting notes'],
    ['beeflow', 'Bee Flow'],
    ['chat', 'Bee Flow chat'],
    ['documents', 'the knowledge base'],
]);

/** "google_sheets" → "Google Sheets": the registry's label, else the id in words. */
function appLabel(id) {
    const app = normaliseApp(id);
    if (APP_LABELS.has(app)) return /** @type {string} */ (APP_LABELS.get(app));
    const words = app.split('-').filter(Boolean);
    return words.length ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : 'your apps';
}

// ── Deterministic names ──────────────────────────────────────────────────────

/**
 * A title that never needs a model: from the pattern's kind, apps and actions.
 * @param {any} c candidate
 * @returns {string}
 */
function fallbackName(c) {
    const apps = Array.isArray(c?.apps) ? c.apps : [];
    const app = appLabel(apps[0]);
    const verbs = Array.isArray(c?.verbs) ? c.verbs : [];
    const verbApps = Array.isArray(c?.verbApps) && c.verbApps.length === verbs.length ? c.verbApps : verbs.map(() => apps[0]);
    let title;
    switch (c?.kind) {
        case 'mail_template':
            title = c.direction === 'out' ? `Send the recurring ${app} email` : `Handle recurring ${app} emails`;
            break;
        case 'file_drop':
            title = verbs[0] === 'doc.uploaded' ? 'Add the recurring document to the knowledge base' : `Save the recurring file in ${app}`;
            break;
        case 'meeting_followup':
            title = `Follow up after the recurring ${app} meeting`;
            break;
        default: {
            const first = verbs[0] ? `${humaniseTool(verbs[0], normaliseApp(verbApps[0] || ''))} in ${appLabel(verbApps[0])}` : '';
            const last = verbs.length > 1
                ? `${humaniseTool(verbs[verbs.length - 1], normaliseApp(verbApps[verbs.length - 1] || '')).toLowerCase()} in ${appLabel(verbApps[verbs.length - 1])}`
                : '';
            title = first && last ? `${first}, then ${last}` : (first || 'Repeat the same steps');
        }
    }
    return clamp(title, MAX_TITLE);
}

const WHY_BY_KIND = {
    mail_template_in: 'These emails keep arriving and you handle each one the same way, so an automation can do it as soon as one lands.',
    mail_template_out: 'You write this email yourself on a regular rhythm, so an automation can draft it for you.',
    file_drop: 'You save a file like this in the same place on a regular rhythm, so an automation can prepare it for you.',
    meeting_followup: 'After this recurring meeting you do the same follow-up work, so an automation can start it when the notes are ready.',
    sequence: 'You run these same steps in the same order again and again, so an automation can run them for you.',
};

/** "Every week on Monday" style, from the cadence kind alone (no numbers). */
const CADENCE_WORDS = {
    daily: 'every day', weekdays: 'every weekday', weekly: 'every week', biweekly: 'every two weeks', monthly: 'every month',
};

/**
 * The deterministic sentence and build prompt for a candidate, from its card
 * (the same sanitised view the model gets).
 * @param {any} c candidate
 * @param {Record<string, any>} [card]
 * @returns {{ why: string, buildPrompt: string }}
 */
function fallbackExplanation(c, card = toEvidenceCard(c)) {
    const key = c?.kind === 'mail_template' ? `mail_template_${c.direction === 'out' ? 'out' : 'in'}` : c?.kind;
    const why = WHY_BY_KIND[key] || WHY_BY_KIND.sequence;
    const lines = ['Build an automation that takes over this repeating work.'];
    const draft = card?.draft;
    if (draft) {
        lines.push(`Trigger: ${draft.trigger.label || 'run by hand'}.`);
        if (draft.steps.length) {
            lines.push('Steps:');
            draft.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.label}${s.app ? ` (${appLabel(s.app)})` : ''}`));
        }
    } else if (card?.apps?.length) {
        lines.push(`It uses ${card.apps.map(appLabel).join(' and ')}.`);
    }
    const rhythm = CADENCE_WORDS[card?.cadence?.kind];
    if (rhythm) lines.push(`It happens about ${rhythm}.`);
    if (card?.template) lines.push(`The items look like: "${card.template}".`);
    return { why, buildPrompt: clamp(lines.join('\n'), MAX_PROMPT) };
}

// ── Sanitising the model's words ─────────────────────────────────────────────

// In the model's text "1,5" is a number; in the card's JSON a comma separates.
const NUMBER_RE = /\d+(?:[.,]\d+)?/g;
const JSON_NUMBER_RE = /\d+(?:\.\d+)?/g;
const UNSAFE_RE = /@|https?:\/\/|www\./i;
const PLACEHOLDER_WORDS = {
    name: 'someone', org: 'an organisation', email: 'an email address', url: 'a link', domain: 'a website',
};

/** Collapse runs of spaces (line breaks survive) and cut at `max`. */
function clamp(text, max) {
    const s = String(text ?? '').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();
    return s.length > max ? s.slice(0, max).trim() : s;
}

/** "09" and "9", "1,5" and "1.5" are one number. */
function numberKey(raw) {
    const n = Number(String(raw).replace(',', '.'));
    return Number.isFinite(n) ? String(n) : String(raw);
}

/**
 * Every number a card holds, with the roundings a sentence may fairly use,
 * plus the window the scan covered.
 * @param {Record<string, any>} card
 * @param {number[]} [extra]
 * @returns {Set<string>}
 */
function allowedNumbers(card, extra = []) {
    const out = new Set();
    const add = (n) => {
        if (!Number.isFinite(n)) return;
        for (const v of [n, Math.round(n), Math.floor(n), Math.ceil(n)]) out.add(String(v));
    };
    for (const m of JSON.stringify(card ?? {}).match(JSON_NUMBER_RE) || []) add(Number(m));
    for (const n of extra) add(Number(n));
    return out;
}

/** @param {string} text @param {Set<string>} allowed */
function foreignNumber(text, allowed) {
    return (text.match(NUMBER_RE) || []).some((m) => !allowed.has(numberKey(m)));
}

/** Placeholders read as words in a title or a sentence meant for a person. */
function placeholdersToWords(text) {
    return text
        .replace(/<domain:([A-Za-z0-9_-]{1,24})>/g, 'domain $1')
        .replace(/<(name|org|email|url|domain)>/g, (_, k) => PLACEHOLDER_WORDS[k])
        .replace(/<[^<>\s]{1,24}>/g, '')
        .replace(/\s+([,.;:!?])/g, '$1');
}

// "1. ", "2) ", "- ": the numbering of a list is not a measurement.
const LIST_MARKER_RE = /^(?:\d{1,2}[.)]|[-*•])\s+/;

/**
 * Keep the sentences that hold no address, no link and no invented number.
 * Sentences end at a line break, or at . ! ? after a word (so "1. Search"
 * stays one line of a list).
 * @param {unknown} raw
 * @param {Set<string>} allowed
 * @param {{ max: number, words: boolean }} opts
 */
function cleanSentences(raw, allowed, { max, words }) {
    let text = stripTokens(typeof raw === 'string' ? raw : '');
    if (words) text = placeholdersToWords(text);
    const kept = text
        .split(/(?<=[^\d\s][.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter((s) => s && !UNSAFE_RE.test(s) && !foreignNumber(s.replace(LIST_MARKER_RE, ''), allowed));
    return clamp(kept.join(words ? ' ' : '\n'), max);
}

/** A title is one phrase: any address, link or invented number rejects it whole. */
function cleanTitle(raw, allowed) {
    const text = clamp(placeholdersToWords(stripTokens(typeof raw === 'string' ? raw : '')).replace(/\s+/g, ' '), MAX_TITLE)
        .replace(/^["'“”]+|["'“”.]+$/g, '').trim();
    if (!text || UNSAFE_RE.test(text) || foreignNumber(text, allowed)) return '';
    return text;
}

// ── Parsing the tool call ────────────────────────────────────────────────────

const NamedPattern = z.object({
    ref: z.string().trim().min(1).max(8),
    title: z.string().max(1000),
    why: z.string().max(4000).optional(),
    buildPrompt: z.string().max(20_000).optional(),
});

/**
 * @param {any} structured
 * @returns {Map<string, { title: string, why?: string, buildPrompt?: string }>}
 */
function parseNaming(structured) {
    /** @type {Map<string, { title: string, why?: string, buildPrompt?: string }>} */
    const out = new Map();
    const list = Array.isArray(structured?.patterns) ? structured.patterns.slice(0, MAX_CARDS * 2) : [];
    for (const item of list) {
        const parsed = NamedPattern.safeParse(item);
        if (!parsed.success) continue;
        const ref = parsed.data.ref.toUpperCase();
        if (!out.has(ref)) out.set(ref, /** @type {any} */ (parsed.data));
    }
    return out;
}

const refOf = (i) => String.fromCharCode(65 + i);

/**
 * The messages the model gets: the static rules and the cards, nothing else.
 * @param {Array<Record<string, any>>} cards
 */
function buildNamingMessages(cards) {
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ patterns: cards.map((card, i) => ({ ref: refOf(i), ...card })) }) },
    ];
}

/**
 * @typedef {{ title: string, why: string, buildPrompt: string, source: 'llm'|'fallback' }} PatternName
 */

/**
 * Name the scan's patterns, in order.
 *
 * @param {any[]} candidates scored, mapped candidates (templates already name-masked)
 * @param {{
 *   modelId?: string|null,
 *   llmClient?: { chatForcedTool: (modelId: string, messages: any[], tool: any, opts?: any) => Promise<any> }|null,
 *   guard?: ((messages: Array<{ role: string, content: string }>) => Promise<{ blocked?: boolean, categories?: string[] }|null|undefined>)|null,
 *   signal?: AbortSignal,
 *   windowDays?: number,
 * }} [opts]
 * @returns {Promise<{ names: PatternName[], categories: string[], usage: any, blocked: boolean, called: boolean }>}
 */
async function namePatterns(candidates, opts = {}) {
    const list = (Array.isArray(candidates) ? candidates : []).slice(0, MAX_CARDS);
    const cards = list.map((c) => toEvidenceCard(c));
    const fallbacks = list.map((c, i) => ({ title: fallbackName(c), ...fallbackExplanation(c, cards[i]) }));
    const allFallback = () => fallbacks.map((f) => ({ ...f, source: /** @type {const} */ ('fallback') }));
    /** @type {string[]} */
    let categories = [];
    if (!list.length) return { names: [], categories, usage: null, blocked: false, called: false };
    if (!opts.modelId || typeof opts.llmClient?.chatForcedTool !== 'function') {
        return { names: allFallback(), categories, usage: null, blocked: false, called: false };
    }

    const messages = buildNamingMessages(cards);
    if (typeof opts.guard === 'function') {
        try {
            const g = await opts.guard(messages);
            categories = Array.isArray(g?.categories) ? g.categories.map(String) : [];
            if (g?.blocked) return { names: allFallback(), categories, usage: null, blocked: true, called: false };
        } catch (err) {
            // Fail closed: an unchecked card never reaches a model.
            log.warn('[RepeatingWork] naming guard failed, using deterministic names:', /** @type {any} */ (err)?.message);
            return { names: allFallback(), categories, usage: null, blocked: true, called: false };
        }
    }

    let structured = null;
    let usage = null;
    try {
        const callOpts = opts.signal ? { ...NAMING_OPTIONS, signal: opts.signal } : { ...NAMING_OPTIONS };
        const res = await opts.llmClient.chatForcedTool(opts.modelId, messages, NAME_PATTERNS_TOOL, callOpts);
        structured = res?.structured || null;
        usage = res?.usage || null;
    } catch (err) {
        if (!opts.signal?.aborted) log.warn('[RepeatingWork] naming call failed, using deterministic names:', /** @type {any} */ (err)?.message);
    }

    const named = parseNaming(structured);
    const names = list.map((_, i) => {
        const fb = fallbacks[i];
        const raw = named.get(refOf(i));
        if (!raw) return { ...fb, source: /** @type {const} */ ('fallback') };
        const allowed = allowedNumbers(cards[i], [opts.windowDays ?? 90]);
        return {
            title: cleanTitle(raw.title, allowed) || fb.title,
            why: cleanSentences(raw.why, allowed, { max: MAX_WHY, words: true }) || fb.why,
            buildPrompt: cleanSentences(raw.buildPrompt, allowed, { max: MAX_PROMPT, words: false }) || fb.buildPrompt,
            source: /** @type {const} */ ('llm'),
        };
    });
    return { names, categories, usage, blocked: false, called: true };
}

module.exports = {
    NAME_PATTERNS_TOOL,
    NAMING_OPTIONS,
    namePatterns,
    fallbackName,
    fallbackExplanation,
    buildNamingMessages,
    allowedNumbers,
    cleanSentences,
    cleanTitle,
    appLabel,
};
