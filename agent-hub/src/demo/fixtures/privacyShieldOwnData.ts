/**
 * "Your own data" for the Privacy Shield demo: the organisation's own kinds
 * of data, their test sets, and a canned test bench.
 *
 * Same fictional insurer as privacyShield.js (Van Dael Assurantiën). Three
 * types, one per method, so every row state of the tab is on screen:
 *   - "Polisnummer", a fixed format (PN- and seven digits), tested clean;
 *   - "Projectnamen", recognised by AI, one miss and one false alarm;
 *   - "schadedossier", migrated from the old "Always hide these" list.
 *
 * The bench answers locally and deterministically: lists of words and fixed
 * formats run in the browser with the same rules as the real Node matcher
 * (whole words, case), and the AI type "finds" the demo's own project names.
 * Nothing leaves the browser, like every other demo route.
 */

type Span = { start: number; end: number };
type Sentence = { id: string; text: string; gold?: Span[]; origin?: string };
type DemoType = {
    id: string;
    name: string;
    method: 'words' | 'pattern' | 'ai';
    tokenKey: string;
    words?: { values: string[]; caseSensitive?: boolean; wholeWord?: boolean };
    pattern?: { source: string; caseSensitive?: boolean };
    ai?: { prompt: string; floor: number };
};
type Ctx = { state: { shield: Record<string, unknown> }; body: Record<string, unknown> | null };

export const POLIS_ID = 'cdt_de0000a001';
export const PROJECT_ID = 'cdt_de0000a002';
export const LEGACY_ID = 'cdt_de0000a003';

const DEMO_PROJECTS = ['Zilvermeeuw', 'Kraanvogel', 'Grutto', 'Tureluur'];

export function ownDataTypes(at: string) {
    return [
        {
            id: POLIS_ID,
            name: 'Polisnummer',
            description: 'Het nummer van een polis: PN- gevolgd door zeven cijfers.',
            method: 'pattern',
            tokenKey: 'polisnummer',
            pattern: { source: '\\bPN-\\d{7}\\b', caseSensitive: false, engine: 're2' },
            quality: { found: 12, total: 12, falseAlarms: 0, sentences: 14, at },
            origin: 'created',
            createdAt: at,
            updatedAt: at,
        },
        {
            id: PROJECT_ID,
            name: 'Projectnamen',
            description: 'De interne namen van onze projecten, meestal een vogelnaam.',
            method: 'ai',
            tokenKey: 'projectnaam',
            ai: { prompt: 'interne projectnaam', floor: 0.55 },
            quality: { found: 9, total: 10, falseAlarms: 1, sentences: 12, at },
            origin: 'created',
            createdAt: at,
            updatedAt: at,
        },
        {
            id: LEGACY_ID,
            name: 'schadedossier',
            description: '',
            method: 'words',
            tokenKey: 'customterm',
            words: { values: ['schadedossier'], caseSensitive: false, wholeWord: true },
            origin: 'migrated',
            legacy: true,
        },
    ];
}

const s = (id: string, text: string, gold?: Span[], origin = 'assistant'): Sentence => ({ id, text, origin, ...(gold ? { gold } : {}) });
const spanOf = (text: string, needle: string): Span => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
const marked = (id: string, text: string, needle: string, origin = 'assistant') => s(id, text, [spanOf(text, needle)], origin);

export function ownDataTests(at: string) {
    return {
        [POLIS_ID]: {
            examples: ['PN-4471902', 'PN-0038215', 'PN-7720014'],
            keepFixed: ['PN-'],
            sentences: [
                marked('s_polis01', 'Kunt u polis PN-4471902 opzeggen per 1 januari?', 'PN-4471902'),
                marked('s_polis02', 'De schade valt onder PN-0038215, dekking all-risk.', 'PN-0038215'),
                marked('s_polis03', 'PN-7720014 is vorige week verlengd.', 'PN-7720014'),
                s('s_polis04', 'Het formulier heet PN-A en hoort bij de aanvraag.', [], 'nearmiss'),
            ],
            updatedAt: at,
        },
        [PROJECT_ID]: {
            examples: ['Zilvermeeuw', 'Kraanvogel', 'Grutto'],
            sentences: [
                marked('s_proj01', 'Voor Zilvermeeuw plannen we de livegang in maart.', 'Zilvermeeuw'),
                marked('s_proj02', 'Het team van Kraanvogel zit op de derde verdieping.', 'Kraanvogel'),
                marked('s_proj03', 'Grutto loopt twee weken uit.', 'Grutto'),
                s('s_proj04', 'Op het strand zagen we een grutto en een meeuw.', [], 'nearmiss'),
            ],
            updatedAt: at,
        },
    };
}

// ── The canned bench ─────────────────────────────────────────────────────

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wordsMatcher(words: DemoType['words']): RegExp | null {
    const values = (words?.values || []).filter(Boolean).map(escapeRe);
    if (!values.length) return null;
    const edge = words?.wholeWord === false ? '' : '\\b';
    return new RegExp(`${edge}(?:${values.join('|')})${edge}`, words?.caseSensitive ? 'g' : 'gi');
}

function patternMatcher(pattern: DemoType['pattern']): RegExp | null {
    try { return new RegExp(pattern?.source || '(?!)', pattern?.caseSensitive ? 'g' : 'gi'); } catch { return null; }
}

/**
 * "AI" in the demo recognises the organisation's own project names. Below a
 * floor of 0.6 it also takes "Grutto" in any sentence, the bird on the
 * beach included: the one false alarm Tune can fix.
 */
function aiMatcher(ai: DemoType['ai']): RegExp {
    const strict = (ai?.floor ?? 0.5) >= 0.6;
    return new RegExp(`\\b(?:${DEMO_PROJECTS.join('|')})\\b`, strict ? 'g' : 'gi');
}

/** The same rules as the real matcher: whole words by default, case-insensitive by default. */
function matcherFor(type: DemoType): RegExp | null {
    if (type.method === 'words') return wordsMatcher(type.words);
    if (type.method === 'pattern') return patternMatcher(type.pattern);
    return aiMatcher(type.ai);
}

function findsIn(text: string, re: RegExp | null): Span[] {
    if (!re) return [];
    return [...text.matchAll(re)].filter(m => m[0].length > 0).map(m => ({ start: m.index!, end: m.index! + m[0].length }));
}

const overlap = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

function score(sentence: Sentence, found: Span[]) {
    const marks: (Span & { kind: string })[] = [];
    if (!sentence.gold) return { marks: found.map(f => ({ ...f, kind: 'found' })), verdict: 'no_gold', hit: 0, total: 0, fa: 0 };
    let hit = 0;
    for (const g of sentence.gold) {
        const covered = found.reduce((n, f) => n + Math.max(0, Math.min(g.end, f.end) - Math.max(g.start, f.start)), 0);
        const ok = covered * 2 >= g.end - g.start;
        if (ok) hit++;
        marks.push({ ...g, kind: ok ? 'hit' : 'missed' });
    }
    const alarms = found.filter(f => !sentence.gold!.some(g => overlap(g, f)));
    for (const f of alarms) marks.push({ ...f, kind: 'false_alarm' });
    const missed = sentence.gold.length - hit;
    let verdict = 'correct';
    if (missed && alarms.length) verdict = 'mixed';
    else if (missed) verdict = 'missed';
    else if (alarms.length) verdict = 'false_alarm';
    return { marks: marks.sort((a, b) => a.start - b.start), verdict, hit, total: sentence.gold.length, fa: alarms.length };
}

function runBench(type: DemoType, sentences: Sentence[]) {
    const re = matcherFor(type);
    const summary = { found: 0, total: 0, falseAlarms: 0, sentences: 0 };
    const results = sentences.map(sentence => {
        const r = score(sentence, findsIn(sentence.text, re));
        if (sentence.gold) {
            summary.found += r.hit; summary.total += r.total; summary.falseAlarms += r.fa; summary.sentences += 1;
        }
        return { id: sentence.id, marks: r.marks, verdict: r.verdict };
    });
    return { results, summary };
}

/** Same length and character class at every position, never the original. */
function lookalike(value: string, keep: string[]): string {
    const fixed = keep.find(k => value.startsWith(k)) || '';
    const rest = value.slice(fixed.length);
    let out = '';
    for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        const n = (i * 7 + 3) % 10;
        if (/\d/.test(c)) out += String((Number(c) + n + 1) % 10);
        else if (/[a-z]/.test(c)) out += String.fromCharCode(97 + ((c.charCodeAt(0) - 97 + n + 1) % 26));
        else if (/[A-Z]/.test(c)) out += String.fromCharCode(65 + ((c.charCodeAt(0) - 65 + n + 1) % 26));
        else out += c;
    }
    return fixed + out;
}

function keepFixedProposal(method: string, examples: string[]): string[] {
    if (method !== 'pattern' || examples.length < 2) return [];
    const m = /^([A-Za-z]{1,4}-?)/.exec(examples[0]);
    return m && examples.every(e => e.startsWith(m[1])) ? [m[1]] : [];
}

function previewOf(body: Record<string, unknown>) {
    const type = (body.type || {}) as { name?: string; description?: string; method?: string };
    const examples = Array.isArray(body.examples) ? body.examples as string[] : [];
    const proposal = keepFixedProposal(type.method || '', examples);
    const keep = (Array.isArray(body.keepFixed) ? body.keepFixed as string[] : []).filter(k => proposal.includes(k));
    return {
        outbound: { name: type.name || '', description: type.description || '', lookalikes: examples.map(e => lookalike(e, keep)) },
        keepFixedProposal: proposal,
    };
}

const TEMPLATES = [
    'Kunt u {x} vandaag nog controleren?',
    'Zoals besproken sturen we {x} door naar de afdeling schade.',
    'In de notitie van dinsdag staat {x} vermeld.',
    'Graag een update over {x} voor het einde van de week.',
    'Mevrouw belde over {x} en vroeg om terugbelverzoek.',
];

function assistOf(body: Record<string, unknown>) {
    const preview = previewOf(body);
    const examples = (Array.isArray(body.examples) ? body.examples as string[] : []).filter(Boolean);
    const type = (body.type || {}) as { method?: string; name?: string };
    const sentences = examples.length ? TEMPLATES.map((tpl, i) => {
        const x = examples[i % examples.length];
        const text = tpl.replace('{x}', x);
        return marked(`s_demo_a${i}`, text, x);
    }) : [];
    return {
        outbound: preview.outbound,
        suggestedMethod: null,
        sentences,
        nearMisses: [s('s_demo_n1', 'Het formulier en de bijlage zijn compleet.', [], 'nearmiss')],
        candidates: {
            patterns: type.method === 'pattern' && examples[0] ? [{ source: `\\b${escapeRe(examples[0].replace(/\d/g, '0')).replace(/0+/g, m => `\\d{${m.length}}`)}\\b`, describe: 'The same shape as your examples' }] : [],
            aiLabels: type.method === 'ai' && type.name ? [type.name.toLowerCase()] : [],
        },
        dropped: { sentences: 0, patterns: 0, labels: 0 },
    };
}

function preview1(type: DemoType, sentence: Sentence) {
    const re = matcherFor(type);
    let n = 0;
    return re ? sentence.text.replace(re, () => `[${type.tokenKey}_${++n}]`) : sentence.text;
}

function testOf(body: Record<string, unknown>) {
    const type = body.type as DemoType;
    const sentences = (Array.isArray(body.sentences) ? body.sentences : []) as Sentence[];
    const bench = runBench(type, sentences);
    return {
        ...bench,
        ...(sentences.length === 1 ? { preview: preview1(type, sentences[0]) } : {}),
        engine: type.method === 'ai' ? 'guard' : 'local',
    };
}

const needsGold = () => new Response(
    JSON.stringify({ error: 'Mark at least five sentences first.', code: 'tune_needs_gold', details: { needed: 5 } }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
);

/** The best candidate's config and its one-line description, per method. */
function bestOf(type: DemoType, tuned: DemoType) {
    if (type.method === 'ai') return { config: { ai: tuned.ai }, describe: { label: tuned.ai?.prompt, sensitivity: 'medium' } };
    if (type.method === 'pattern') return { config: { pattern: type.pattern }, describe: { patternWords: type.pattern?.source } };
    return {
        config: { words: type.words },
        describe: { flags: { wholeWord: type.words?.wholeWord !== false, caseSensitive: !!type.words?.caseSensitive } },
    };
}

function tuneOf(body: Record<string, unknown>) {
    const type = body.type as DemoType;
    const sentences = (Array.isArray(body.sentences) ? body.sentences : []) as Sentence[];
    if (sentences.filter(x => (x.gold || []).length > 0).length < 5) return needsGold();
    const before = runBench(type, sentences).summary;
    // The demo's one real improvement: the AI type tuned to a stricter
    // floor, which drops the bird on the beach as a false alarm.
    const tuned: DemoType = type.method === 'ai' ? { ...type, ai: { prompt: type.ai?.prompt || '', floor: 0.6 } } : type;
    const after = runBench(tuned, sentences).summary;
    const improved = after.found > before.found || (after.found === before.found && after.falseAlarms < before.falseAlarms);
    const best = bestOf(type, tuned);
    return {
        best: { ...best, summary: improved ? after : before },
        before: { summary: before },
        improved,
        tried: type.method === 'ai' ? 7 : 4,
    };
}

export const OWN_DATA_ROUTES = {
    'POST /api/org-privacy-shield/:orgId/custom-data/assist/preview': ({ body }: Ctx) => previewOf(body || {}),
    'POST /api/org-privacy-shield/:orgId/custom-data/assist': ({ body }: Ctx) => assistOf(body || {}),
    'POST /api/org-privacy-shield/:orgId/custom-data/test': ({ body }: Ctx) => testOf(body || {}),
    'POST /api/org-privacy-shield/:orgId/custom-data/tune': ({ body }: Ctx) => tuneOf(body || {}),
};

export const _ownDataInternals = { lookalike, matcherFor, runBench, DEMO_PROJECTS };
