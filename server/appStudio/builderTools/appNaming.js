/**
 * App Studio builder — a name for an app the model never named.
 *
 * The prompt's NAME IT NOW rule and app_set_meta's description ask for the
 * name in the first call group; this is the net under them. Measured on the
 * demo box (Gemma 4 26B-A4B, 2026-09-17): builds finalize as "Untitled app"
 * whenever the model skips app_set_meta, and every app card, nav title and
 * usage row then says so. `ensureAppName` runs at the top of applyFinalize —
 * the model's own app_finalize AND the route's auto-finalize go through it —
 * and names the draft from what it has: the brief, the data model, the
 * definition. Deterministic, no model call: a second prompt on the box's one
 * slot evicts the builder's own cache entry, and the brief already says what
 * the user calls the thing.
 *
 * Derivation order (first hit wins):
 *   1. an explicit name in the brief — `App name "…"`, `App naam "…"`,
 *      `name the app "…"`, `noem de app "…"` (EN/NL, either quote style);
 *   2. the first `## ` heading of the brief that is not the DESIGN block;
 *   3. the first table's name (linked or own);
 *   4. the first screen not named Home;
 *   5. the brief's first sentence, its leading imperative stripped ("Build a
 *      professional invoice tracker" → "Invoice tracker"), first four words.
 * A greeting or an acknowledgement that opens the brief ("Hi!", "Hoi,",
 * "Thanks.", "Ok build …") is skipped first — measured in review 2026-09-18:
 * a chat-style brief named its app "Hi", which is worse for the owner than
 * the default — and a name made of nothing but such filler is never used.
 * Clamped to MAX_APP_NAME chars at a word boundary; when nothing derivable
 * the draft stays "Untitled app" and nothing is written.
 */

'use strict';

const ops = require('../definitionOps');

const UNTITLED = 'Untitled app';
const MAX_APP_NAME = 40;
const NAME_WORDS = 4;

// `App name "Facturen"` / `App naam: 'Facturen'` / `name the app “Orders”` /
// `noem de app "Klanten"` — the name is whatever sits between the quotes.
const EXPLICIT_NAME_RES = [
    /\bapp\s*(?:name|naam)\s*[:=]?\s*["“'‘]([^"”'’\n]{1,80})["”'’]/i,
    /\b(?:name|call)\s+(?:the\s+|this\s+|it\s+)?app\s*[:=]?\s*["“'‘]([^"”'’\n]{1,80})["”'’]/i,
    /\b(?:noem|geef)\s+(?:de\s+|deze\s+)?app\s*(?:de\s+naam\s*)?[:=]?\s*["“'‘]([^"”'’\n]{1,80})["”'’]/i,
];

// What a chat-style brief opens with before it says anything: a greeting,
// an acknowledgement, a thank-you, a "so" — with or without a name after it
// ("Hi Claude,", "Beste team:") — each followed by its punctuation. Every
// one of them is dropped, as often as they repeat ("Hi! Thanks. Ok, …").
const GREETING_WORD = "(?:hi|hello|hey|hoi|hallo|hey\\s+there|hi\\s+there|yo|dag|goedemorgen|goedemiddag|goedenavond|goedendag|good\\s+(?:morning|afternoon|evening|day)|greetings|thanks|thank\\s+you|bedankt|dank\\s+je(?:\\s+wel)?|dankjewel|ok|okay|oké|oke|so|dus|nou|dear|beste)";
const LEADING_GREETING_RE = new RegExp(`^(?:${GREETING_WORD}(?:\\s+[^\\s,.!:;?]{1,20}(?=[,.!:;]))?[,.!:;\\s]+)+`, 'i');
// The leading imperative of a brief and the filler after it — EN and NL,
// polite forms included ("Can you create an…", "Kun je een … maken",
// "We need an…", "Ok build a…").
const IMPERATIVE_RE = /^(?:(?:ok|okay|oké|oke|so|dus|nou)[,!]?\s+)?(?:(?:can|could|would|will)\s+you\s+|(?:kun|kan|zou|wil)\s+je\s+)?(?:please\s+|alsjeblieft\s+|graag\s+)?(?:(?:build|make|create|design|generate|set\s+up|give\s+me|give\s+us|i\s+(?:want|need|would\s+like|would\s+love)|we\s+(?:want|need|would\s+like|would\s+love)|maak|bouw|ontwerp|genereer|ik\s+wil|ik\s+heb|ik\s+zoek|wij?\s+(?:willen|hebben|zoeken))\s+)?(?:me\s+|us\s+|mij\s+|ons\s+|voor\s+mij\s+|voor\s+ons\s+|graag\s+)?(?:(?:a|an|the|one|een|de|het|'n)\s+)?(?:(?:small|simple|professional|basic|quick|new|little|nice|clean|modern|complete|full|dutch|english|eenvoudige?|simpele?|professionele?|kleine?|nieuwe?|mooie?|complete|nederlandse?)\s+)*/i;
// Dutch puts the verb last ("Kun je een klachtenlijst maken"), and a polite
// brief ends its ask with "please" — both dropped from the head.
const TRAILING_FILLER_RE = /\s+(?:maken|bouwen|ontwerpen|genereren|opzetten|please|alsjeblieft|alstublieft|aub|a\.u\.b\.|graag)[.!?]*$/i;
const LEADING_ARTICLE_RE = /^(?:a|an|the|one|een|de|het|'n|mijn|my|our|onze)\s+/i;
// Where the name ends: the first connective that starts the "what it is for".
// Captured, so a clause can take the connective after it along ("bijhouden
// van klachten").
const CONNECTIVE_RE = /\s+(for|that|which|with|so|where|on|in|over|from|about|at|by|using|to|van|voor|die|dat|met|waar|om|op|uit|bij)\s+/i;
// A head that names the kind of thing, not the thing: fall through to the clause after it.
const GENERIC_HEAD_RE = /^(?:app|application|apps|tool|dashboard|screen|screens|page|thing|something|tables?|forms?|fields?|columns?|rows?|data|applicatie|scherm|pagina|iets|tabel|tabellen|formulier)$/i;
// A word that carries no name on its own. A candidate made only of these
// (a greeting the split left behind, "We need", "Please") is not a name.
const STOP_WORD_RE = new RegExp(`^(?:${GREETING_WORD}|a|an|the|one|een|de|het|'n|my|our|your|mine|mijn|onze|jouw|uw|me|us|i|we|you|it|this|that|these|those|ik|wij|we|jij|je|u|het|dit|dat|deze|die|please|alsjeblieft|graag|need|want|would|like|can|could|will|kun|kan|zou|wil|and|or|en|of|for|with|to|voor|met|om|is|are|be|been|zijn|ben|bent|have|has|heb|hebt|heeft|hebben|there|here|hier|daar|not|niet|no|nee|yes|ja)$`, 'i');

// The sentences the route puts in for an empty message on an approval,
// continuation or image-only turn (routes/ai/appStudioBuilder.js,
// effectiveMessage). None of them is a brief — a name read from one
// ("Approved plan", "Continue", "Look") is worse than "Untitled app" — and
// the image one is persisted with a second line, hence the prefix match.
const SYNTHETIC_TURN_MESSAGES = [
    'Build the approved plan.',
    'Continue with the next phase of the approved plan.',
    'Look at the image(s) I attached.',
];

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Clamp to MAX_APP_NAME at a word boundary; '' when nothing is left. */
function clamp(name) {
    let s = collapse(name).replace(/^["“'‘]+|["”'’]+$/g, '').replace(/[.:;,!?]+$/g, '').trim();
    if (s.length > MAX_APP_NAME) {
        const cut = s.lastIndexOf(' ', MAX_APP_NAME);
        s = (cut > MAX_APP_NAME / 2 ? s.slice(0, cut) : s.slice(0, MAX_APP_NAME)).trim();
    }
    return s;
}

/** First letter up, the rest as written (a brief's own casing is usually right). */
function capitalise(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function fromExplicit(message) {
    for (const re of EXPLICIT_NAME_RES) {
        const m = re.exec(message);
        if (m && collapse(m[1])) return clamp(m[1]);
    }
    return '';
}

/**
 * The brief's lines with the DESIGN block cut out. A playbook brief ends in
 * `## DESIGN` followed by `### Screen "…"` sub-headings and bullets; every
 * line under it, until a heading of the same or a higher level, describes
 * the look — never the name.
 */
function linesOutsideDesign(message) {
    const out = [];
    let designLevel = 0;
    for (const raw of String(message).split('\n')) {
        const heading = /^\s*(#{1,3})\s+(.+?)\s*#*\s*$/.exec(raw);
        if (heading) {
            const level = heading[1].length;
            if (designLevel && level > designLevel) continue;
            designLevel = /^design\b/i.test(collapse(heading[2])) ? level : 0;
            if (designLevel) continue;
            out.push({ heading: collapse(heading[2]) });
            continue;
        }
        if (designLevel) continue;
        out.push({ text: raw.trim() });
    }
    return out;
}

/**
 * A candidate with its opening filler gone: the imperative and the article
 * before the name, the verb or the "please" after it. Shared by the heading
 * rule ("## Build an invoice app" → "invoice app") and the sentence rule.
 */
function stripImperative(text) {
    let s = collapse(text).replace(IMPERATIVE_RE, '');
    for (let guard = 0; guard < 3; guard += 1) {
        const next = s.replace(TRAILING_FILLER_RE, '');
        if (next === s) break;
        s = next;
    }
    return collapse(s).replace(LEADING_ARTICLE_RE, '');
}

function fromHeading(message) {
    for (const line of linesOutsideDesign(message)) {
        if (!line.heading) continue;
        const text = line.heading;
        if (/^(?:brief|context|requirements?|data|tables?|screens?|notes?|steps?)\b/i.test(text)) continue;
        return clamp(capitalise(stripImperative(text)));
    }
    return '';
}

function fromTables(dataModel) {
    const tables = dataModel && Array.isArray(dataModel.tables) ? dataModel.tables : [];
    for (const t of tables) {
        const name = collapse(t && (t.name || t.key));
        if (name) return clamp(capitalise(name.replace(/_/g, ' ')));
    }
    return '';
}

function fromScreens(def) {
    const screens = def && Array.isArray(def.screens) ? def.screens : [];
    for (const s of screens) {
        const name = collapse(s && s.name);
        if (name && name.toLowerCase() !== 'home' && name.toLowerCase() !== 'screen') return clamp(name);
    }
    return '';
}

/** The first prose line of the brief outside the DESIGN block: no headings, list markers, blanks. */
function firstProseLine(message) {
    for (const line of linesOutsideDesign(message)) {
        if (!line.text || /^[\-*>\d]/.test(line.text)) continue;
        // A naming directive that rule 1 declined ("App name \"Untitled app\"") is not prose.
        if (/^app\s*(?:name|naam)\b/i.test(line.text)) continue;
        return line.text;
    }
    return '';
}

function firstWords(text) {
    const words = collapse(text).split(' ').filter(Boolean).slice(0, NAME_WORDS);
    return words.length ? clamp(capitalise(words.join(' '))) : '';
}

function fromSentence(message) {
    const line = firstProseLine(message);
    if (!line) return '';
    // "Hi! Can you build me a tip splitter?" — the greeting is not the first
    // sentence, whatever the punctuation after it says.
    const sentence = collapse(line).replace(LEADING_GREETING_RE, '').split(/(?<=[.!?])\s+/)[0];
    const stripped = collapse(sentence.replace(IMPERATIVE_RE, ''));
    if (!stripped) return '';
    // "invoice tracker for my team that …" → "invoice tracker".
    const clean = (s) => stripImperative(collapse(s).replace(/[.:;,!?]+$/g, ''));
    const parts = stripped.split(CONNECTIVE_RE); // clause, connective, clause, connective, …
    const [head, ...rest] = parts.filter((_, i) => i % 2 === 0).map(clean);
    const connectives = parts.filter((_, i) => i % 2 === 1).map((c) => c.toLowerCase()); // [k] sits after clause k
    const words = head.split(' ').filter(Boolean);
    // "an app with tables where invoices are tracked" → the clause after the
    // generic head is the only thing that says what it is.
    if (!words.length || (words.length === 1 && GENERIC_HEAD_RE.test(words[0]))) {
        const k = rest.findIndex((r) => r && !GENERIC_HEAD_RE.test(r.split(' ')[0]));
        if (k < 0) return '';
        let clause = rest[k];
        // "voor het bijhouden van klachten": a one-word clause is the verb
        // alone — it takes its object with it, or the name is "Bijhouden".
        const after = connectives[k + 1];
        if (!clause.includes(' ') && rest[k + 1] && (after === 'van' || after === 'of')) clause = `${clause} ${after} ${rest[k + 1]}`;
        return firstWords(clause);
    }
    return firstWords(head);
}

// The brief rides on the builder snapshot as its own key (`brief`), capped
// here: the store trims the snapshot's messages from the HEAD in whole
// blocks once it passes 64KB, and on a long session the first human
// message — the brief — is the first thing to go; a follow-up ("Maak de kop
// groter") would then be all the net has left to read. Every other
// snapshot key survives trimming, and 4,000 chars hold any brief the
// harness or a playbook writes with room to spare.
const BRIEF_SNAPSHOT_MAX = 4000;

const isBrief = (s) => typeof s === 'string' && s.trim() !== '' && !SYNTHETIC_TURN_MESSAGES.some((p) => s.startsWith(p));

/**
 * The text the naming net reads (what the route stores as
 * draftWrap._turnMessage): the FIRST human message of the session — the
 * brief, persisted on the builder snapshot as `brief` and, before that key
 * existed, as its first role:'user' entry — and only on a session without
 * one, this turn's own text. A follow-up turn's text ("Maak de kop groter")
 * names nothing; a synthetic turn sentence never does. Machine notes never
 * reach the snapshot, so a user entry there is the human's text.
 *
 * @param {Array}  [history]   priorSnapshot.messages
 * @param {string} [message]   the client's own text this turn (empty on a synthetic turn)
 * @param {string} [persisted] priorSnapshot.brief — the brief as an earlier turn stored it
 * @returns {string} '' when there is no brief to read
 */
function briefForNaming(history, message, persisted) {
    if (isBrief(persisted)) return persisted;
    for (const m of Array.isArray(history) ? history : []) {
        if (m && m.role === 'user' && isBrief(m.content)) return m.content;
    }
    return isBrief(message) ? message : '';
}

/** What the snapshot stores under `brief`: the brief, capped — or undefined (no key) when there is none. */
function briefForSnapshot(brief) {
    return isBrief(brief) ? String(brief).slice(0, BRIEF_SNAPSHOT_MAX) : undefined;
}

/**
 * @param {object} p
 * @param {string} [p.message]   the turn's brief (draftWrap._turnMessage)
 * @param {object} [p.dataModel] draftWrap.dataModel
 * @param {object} [p.def]       draftWrap.def
 * @returns {{ name: string, source: string }|null} null when nothing derivable
 */
function deriveAppName({ message = '', dataModel = null, def = null } = {}) {
    const msg = typeof message === 'string' ? message : '';
    const tries = [
        ['brief', () => fromExplicit(msg)],
        ['heading', () => fromHeading(msg)],
        ['table', () => fromTables(dataModel)],
        ['screen', () => fromScreens(def)],
        ['sentence', () => fromSentence(msg)],
    ];
    for (const [source, fn] of tries) {
        const name = fn();
        if (!name || name.length < 2 || name.toLowerCase() === UNTITLED.toLowerCase()) continue;
        if (/["“”'‘’{}<>]/.test(name)) continue; // a quote or a brace is debris, never a name
        if (isFiller(name)) continue; // "Hi", "We need", "Please" — words, not a name
        return { name, source };
    }
    return null;
}

/** True when every word of a candidate is filler (greeting, pronoun, article, connective) or punctuation. */
function isFiller(name) {
    const words = collapse(name).split(' ').map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
    return !words.length || words.every((w) => STOP_WORD_RE.test(w));
}

/**
 * Name a still-Untitled draft in place. Returns the hint to carry on the
 * finalize result, or null when the draft was already named or nothing could
 * be derived (the draft is then left exactly as it was).
 */
function ensureAppName(draftWrap) {
    const def = draftWrap && draftWrap.def;
    if (!def || typeof def !== 'object') return null;
    const current = collapse(def.meta && def.meta.name);
    if (current && current !== UNTITLED) return null;
    const derived = deriveAppName({ message: draftWrap._turnMessage, dataModel: draftWrap.dataModel, def });
    if (!derived) return null;
    draftWrap.def = ops.updateMeta(def, { name: derived.name });
    return `The app was still "${UNTITLED}" — named "${derived.name}" from your ${derived.source === 'brief' || derived.source === 'heading' || derived.source === 'sentence' ? 'brief' : `first ${derived.source}`}; call app_set_meta to change it.`;
}

module.exports = { deriveAppName, ensureAppName, briefForNaming, briefForSnapshot, UNTITLED, MAX_APP_NAME, BRIEF_SNAPSHOT_MAX };
