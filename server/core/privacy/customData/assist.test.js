'use strict';
/**
 * The assistant boundary.
 *
 *   - PROPERTY: whatever the admin types, the serialised messages never
 *     contain a real example (case-insensitive, 3+ characters). Examples that
 *     occur in the fixed prompt text itself are not a leak and are skipped.
 *   - buildAssistMessages is built from its four inputs only.
 *   - The answer is untrusted: templates need an exact look-alike, real
 *     examples are swapped in with correct offsets, near misses, patterns and
 *     labels are dropped when they do not qualify, and every drop is counted.
 *   - checkOutbound fails closed.
 *
 * Run: node --test core/privacy/customData/assist.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildOutbound, buildAssistMessages, sanitizeAssistOutput, checkOutbound, hasUsableOutput, scrubText, ASSIST_TOOL,
} = require('./assist');
const { localPatternCheck } = require('./patternTools');

const KEY = Buffer.alloc(32, 3);
const TYPE = { id: 'cdt_0123456789', name: 'Customer numbers', description: '', method: 'pattern' };

// ── A seeded generator, so a failing case can be replayed ───────────────────
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ÉéÜüß';
const INNER = `${ALNUM}-._/ `;
const FILLER = ['the', 'code', 'for', 'our', 'client', 'numbers', 'like', 'and', 'project', 'internal', 'e.g.', 'see'];

function randomExample(r) {
    const len = 3 + Math.floor(r() * 12);
    let s = ALNUM[Math.floor(r() * ALNUM.length)];
    while (Array.from(s).length < len - 1) s += INNER[Math.floor(r() * INNER.length)];
    s += ALNUM[Math.floor(r() * ALNUM.length)];
    return s;
}
function recase(r, s) {
    const x = r();
    return x < 0.33 ? s.toUpperCase() : x < 0.66 ? s.toLowerCase() : s;
}
function randomText(r, examples, maxLen) {
    const parts = [];
    const n = 2 + Math.floor(r() * 8);
    for (let i = 0; i < n; i += 1) {
        if (examples.length && r() < 0.5) parts.push(recase(r, examples[Math.floor(r() * examples.length)]));
        else parts.push(FILLER[Math.floor(r() * FILLER.length)]);
    }
    // Glue some pieces without a space, so examples also sit inside words.
    return parts.reduce((acc, p) => acc + (r() < 0.3 ? '' : ' ') + p, '').trim().slice(0, maxLen);
}

test('PROPERTY: the serialised messages never contain a real example', () => {
    const r = rng(20260926);
    let checked = 0;
    for (let round = 0; round < 400; round += 1) {
        const examples = [...new Set(Array.from({ length: 1 + Math.floor(r() * 10) }, () => randomExample(r)))];
        const method = ['words', 'pattern', 'ai'][Math.floor(r() * 3)];
        const type = {
            id: 'cdt_0123456789',
            name: randomText(r, examples, 60) || 'x',
            description: randomText(r, examples, 400),
            method,
        };
        const keepFixed = r() < 0.5 ? [examples[0].slice(0, 3)] : undefined;
        const { outbound } = buildOutbound({ type, examples, keepFixed, key: KEY, orgId: `org-${round}` });
        const messages = buildAssistMessages({ ...outbound, method });
        const skeleton = buildAssistMessages({ name: '', description: '', lookalikes: [], method })
            .map((m) => m.content).join('\n').toLowerCase();
        const flat = messages.map((m) => m.content).join('\n').toLowerCase();
        const serialised = JSON.stringify(messages).toLowerCase();
        for (const ex of examples) {
            const low = ex.toLowerCase();
            if (Array.from(ex).length < 3 || skeleton.includes(low)) continue;
            checked += 1;
            assert.ok(!flat.includes(low), `round ${round}: example ${JSON.stringify(ex)} leaked`);
            assert.ok(!serialised.includes(low), `round ${round}: example ${JSON.stringify(ex)} leaked (serialised)`);
        }
    }
    assert.ok(checked > 1000, `only ${checked} examples checked`);
});

test('the outbound replaces examples in name and description, case-insensitively', () => {
    const { outbound, pairs } = buildOutbound({
        type: { ...TYPE, name: 'KL-12345 numbers', description: 'Numbers such as kl-12345 or KL-99812.' },
        examples: ['KL-12345', 'KL-99812'],
        keepFixed: ['KL-'],
        key: KEY,
        orgId: 'org-a',
    });
    assert.equal(pairs.length, 2);
    const [l1, l2] = outbound.lookalikes;
    assert.equal(outbound.name, `${l1} numbers`);
    assert.equal(outbound.description, `Numbers such as ${l1} or ${l2}.`);
    assert.match(l1, /^KL-\d{5}$/);
    assert.notEqual(l1, 'KL-12345');
});

test('scrubbing repeats when a replacement forms a new occurrence', () => {
    // Replacing "abc" inside "aabcc" with a look-alike that starts with "ab"
    // and ends with "c"... must not leave any "abc" behind.
    const out = scrubText('xaabccx', ['abc'], new Map([['abc', 'bca']]));
    assert.ok(!out.toLowerCase().includes('abc'), out);
    // Short examples are replaced as whole words only.
    assert.equal(scrubText('a 12 b 123', ['12'], new Map([['12', '98']])), 'a 98 b 123');
});

test('buildAssistMessages is built from its four inputs only', () => {
    const msgs = buildAssistMessages({
        name: 'N', description: 'D', lookalikes: ['KL-83920'], method: 'pattern',
        // Anything else is ignored by construction.
        orgName: 'Acme BV', examples: ['KL-12345'], email: 'a@b.test',
    });
    const flat = JSON.stringify(msgs);
    for (const leak of ['Acme', 'KL-12345', 'a@b.test']) assert.ok(!flat.includes(leak), leak);
    assert.match(msgs[1].content, /KL-83920/);
    assert.equal(ASSIST_TOOL.function.parameters.properties.templates.maxItems, 16);
});

// ── The answer ──────────────────────────────────────────────────────────────

const PAIRS = [
    { example: 'KL-12345', lookalike: 'KL-83920' },
    { example: 'KL-9', lookalike: 'KL-4' },
];
let n = 0;
const ctx = (over = {}) => ({
    pairs: PAIRS,
    examples: PAIRS.map((p) => p.example),
    validatePattern: async (src) => localPatternCheck(src, false),
    caseSensitive: false,
    newId: () => `s_${(n += 1)}`,
    ...over,
});

test('templates: real examples swapped in round-robin, gold computed on the swapped text', async () => {
    const out = await sanitizeAssistOutput({
        templates: [
            'Order KL-83920 is late.',
            'Compare KL-83920 with KL-83920 please.',
            'Nothing here.',
            'lowercase kl-83920 does not count',
        ],
    }, ctx());
    assert.equal(out.sentences.length, 2);
    assert.equal(out.dropped.sentences, 2);
    const all = [];
    for (const s of out.sentences) {
        assert.equal(s.origin, 'assistant');
        for (const g of s.gold) all.push(s.text.slice(g.start, g.end));
        assert.ok(!s.text.includes('KL-83920'), 'no look-alike remains');
    }
    // Every real example appears, and every gold span covers exactly one.
    assert.deepEqual(all.sort(), ['KL-12345', 'KL-12345', 'KL-9'].sort());
    const second = out.sentences[1];
    assert.equal(second.text, 'Compare KL-9 with KL-12345 please.');
    assert.deepEqual(second.gold, [{ start: 8, end: 12 }, { start: 18, end: 26 }]);
});

test('templates: control characters stripped, capped, deduplicated, at most 5 values', async () => {
    const out = await sanitizeAssistOutput({
        templates: [
            'Line\u0000one KL-83920\n',
            'Line one KL-83920',
            `${'KL-83920 '.repeat(6)}`,
            `${'x'.repeat(400)} KL-83920`,
        ],
    }, ctx());
    assert.equal(out.sentences.length, 1);
    assert.equal(out.sentences[0].text, 'Line one KL-12345');
    assert.equal(out.dropped.sentences, 3);
});

test('near misses: dropped when they mention a look-alike or a real example', async () => {
    const out = await sanitizeAssistOutput({
        near_misses: ['Invoice 2024-11 was paid.', 'see kl-83920', 'see KL-12345', 'the order kl-12345'],
    }, ctx());
    assert.deepEqual(out.nearMisses.map((s) => s.text), ['Invoice 2024-11 was paid.']);
    assert.deepEqual(out.nearMisses[0].gold, []);
    assert.equal(out.nearMisses[0].origin, 'nearmiss');
    assert.equal(out.dropped.sentences, 3);
});

test('patterns: must be safe and match every real example completely', async () => {
    const out = await sanitizeAssistOutput({
        patterns: ['KL-\\d{1,5}', '(a+)+', 'KL-\\d{5}', 'KL-\\d{1,5}', ''],
    }, ctx());
    assert.deepEqual(out.candidates.patterns, [{ source: 'KL-\\d{1,5}', describe: 'KL- followed by 1 to 5 digits' }]);
    assert.equal(out.dropped.patterns, 4);
});

test('labels: label-shaped, distinct, never one of our values, at most 6', async () => {
    const out = await sanitizeAssistOutput({
        ai_labels: [
            'customer number', 'Customer Number', 'x', 'number <b>', 'number KL-83920', 'number kl-12345',
            'order id', 'client code', 'account ref', 'contract id', 'case number', 'ticket id',
        ],
    }, ctx());
    assert.deepEqual(out.candidates.aiLabels, ['customer number', 'order id', 'client code', 'account ref', 'contract id', 'case number']);
    assert.equal(out.dropped.labels, 6);
});

test('suggested method in the enum or null; no structured answer is null', async () => {
    assert.equal((await sanitizeAssistOutput({ suggested_method: 'pattern' }, ctx())).suggestedMethod, 'pattern');
    assert.equal((await sanitizeAssistOutput({ suggested_method: 'regex' }, ctx())).suggestedMethod, null);
    assert.equal(await sanitizeAssistOutput(null, ctx()), null);
    assert.equal(await sanitizeAssistOutput(['x'], ctx()), null);
    assert.equal(hasUsableOutput(await sanitizeAssistOutput({ templates: ['nothing'] }, ctx())), false);
    assert.equal(hasUsableOutput(null), false);
});

// ── The check on the outbound payload ──────────────────────────────────────

const OUT = { name: 'Customer numbers', description: 'Numbers for Jan Jansen, e.g. Falcon.' };
const engineWith = (over = {}) => ({
    compileTypes: (types) => ({ types }),
    matchNode: (text) => {
        const at = text.indexOf('Falcon');
        return { spans: at >= 0 ? [{ start: at, end: at + 6, typeId: 'cdt_aaaaaaaaaa' }] : [], partial: false, timedOut: [] };
    },
    ...over,
});
const WORDS = [{ id: 'cdt_aaaaaaaaaa', method: 'words', words: { values: ['Falcon'] } }];

test('findings from the guard and from the org\'s own words, with offsets into the outbound', async () => {
    const detectPii = async (text, cats, thr, opts) => {
        assert.equal(cats, null);
        assert.deepEqual(opts, { priority: 'bulk' });
        const at = text.indexOf('Jan Jansen');
        return { hasPii: at >= 0, entities: at >= 0 ? [{ offset: at, length: 10, category: 'PERSON' }] : [] };
    };
    const findings = await checkOutbound({ outbound: OUT, detectPii, engine: engineWith(), orgTypes: WORDS });
    assert.deepEqual(findings, [
        { field: 'description', start: 12, end: 22, category: 'PERSON' },
        { field: 'description', start: 29, end: 35, category: 'cdt_aaaaaaaaaa' },
    ]);
});

test('the org\'s "Never hide these" settings apply to the guard\'s findings, never to its own types', async () => {
    const out = { name: 'Project names', description: 'Code names used at Philips and at Acme Holding, e.g. Falcon.' };
    const detectPii = async (text) => {
        const entities = [];
        for (const org of ['Philips', 'Acme Holding']) {
            const at = text.indexOf(org);
            if (at >= 0) entities.push({ offset: at, length: org.length, text: org, category: 'Organization' });
        }
        return { hasPii: entities.length > 0, entities };
    };
    const categoriesWith = async (allowConfig) => (await checkOutbound({
        outbound: out, detectPii, engine: engineWith(), orgTypes: WORDS, allowConfig,
    })).map((f) => f.category);

    // Well-known companies are allowed by default, like in chat; the org's own
    // allow term covers the other one; the org's own word still blocks.
    assert.deepEqual(await categoriesWith({ piiAllowTerms: ['Acme Holding'] }), ['cdt_aaaaaaaaaa']);
    // Without the org's term, the unknown company blocks.
    assert.deepEqual(await categoriesWith({}), ['Organization', 'cdt_aaaaaaaaaa']);
    // With the public list switched off, both companies block.
    assert.deepEqual(await categoriesWith({ piiAllowPublicOrgs: false }), ['Organization', 'Organization', 'cdt_aaaaaaaaaa']);
});

test('the check fails closed', async () => {
    const clean = async () => ({ hasPii: false, entities: [] });
    const cases = [
        { detectPii: async () => null },
        { detectPii: async () => ({ hasPii: false, entities: [], degraded: true }) },
        { detectPii: async () => ({ hasPii: false, entities: [], guardAbsent: true }) },
        { detectPii: async () => { throw new Error('down'); } },
        { detectPii: clean, engine: engineWith({ matchNode: () => ({ spans: [], partial: false, timedOut: ['cdt_aaaaaaaaaa'] }) }) },
        { detectPii: clean, engine: engineWith({ matchNode: () => ({ spans: [], partial: true, timedOut: [] }) }) },
    ];
    for (const c of cases) {
        await assert.rejects(
            checkOutbound({ outbound: OUT, detectPii: c.detectPii, engine: c.engine || engineWith(), orgTypes: WORDS }),
            (err) => err.status === 503 && err.code === 'assist_check_unavailable',
        );
    }
    // Without own words/patterns the engine is not needed at all.
    assert.deepEqual(await checkOutbound({ outbound: OUT, detectPii: clean, engine: {}, orgTypes: [] }), []);
});
