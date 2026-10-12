'use strict';

/**
 * The naming step: one shielded model call over evidence cards, and nothing
 * the model says is taken on trust. Synthetic candidates, a stub model.
 *
 * Run: cd server && node --test automation/patterns/explain.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    namePatterns, fallbackName, fallbackExplanation, allowedNumbers, cleanSentences, cleanTitle,
    NAME_PATTERNS_TOOL, NAMING_OPTIONS, appLabel,
} = require('./explain');
const { toDraft } = require('./builderMapping');
const { toEvidenceCard, CARD_KEYS } = require('./evidenceCard');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 18);

function candidate(over = {}) {
    const c = {
        kind: 'mail_template', apps: ['gmail', 'google_sheets'],
        verbs: ['mail.received', 'gmail_read_attachment', 'sheets_append_rows'],
        verbApps: ['gmail', 'gmail', 'google_sheets'],
        templateIds: ['0123456789ab'], template: 'Factuur <id> van <name> <domain:d7>', direction: 'in', domains: ['d7'],
        structured: true, occurrences: 13, timestamps: [NOW - 5 * DAY], distinctDays: 13,
        cadence: {
            kind: 'weekly', weekday: 1, hourBand: [8, 9], cv: 0.05, distinctDays: 13, weeksPresent: 13, weeksWindow: 13,
            perMonth: 4.3, weekdayHistogram: [0, 13, 0, 0, 0, 0, 0], lastTs: NOW - 5 * DAY,
        },
        confidence: 'high', minutes: { range: [3, 6], basis: 'heuristic' }, score: 1.4, reasons: ['frequent', 'regular'],
        ...over,
    };
    return { ...c, draft: over.draft !== undefined ? over.draft : toDraft(c) };
}

/** A model stub that records what it was sent and answers `answer`. */
function stubModel(answer, { fail = false } = {}) {
    const calls = [];
    return {
        calls,
        llmClient: {
            async chatForcedTool(modelId, messages, tool, opts) {
                calls.push({ modelId, messages: structuredClone(messages), tool, opts });
                if (fail) throw new Error('provider down');
                return { structured: answer, usage: { prompt_tokens: 10, completion_tokens: 5 } };
            },
        },
    };
}

test('a deterministic name for every kind, with app names and no model', () => {
    assert.strictEqual(fallbackName(candidate()), 'Handle recurring Gmail emails');
    assert.strictEqual(fallbackName(candidate({ direction: 'out', verbs: ['mail.sent'], verbApps: ['gmail'] })), 'Send the recurring Gmail email');
    assert.strictEqual(fallbackName(candidate({ kind: 'file_drop', apps: ['nextcloud'], verbs: ['file.created'], verbApps: ['nextcloud'] })),
        'Save the recurring file in Nextcloud');
    assert.strictEqual(fallbackName(candidate({ kind: 'file_drop', apps: ['beeflow'], verbs: ['doc.uploaded'], verbApps: ['beeflow'] })),
        'Add the recurring document to the knowledge base');
    assert.strictEqual(fallbackName(candidate({ kind: 'meeting_followup', apps: ['teams'], verbs: ['meeting.held', 'teams_post_message'] })),
        'Follow up after the recurring Microsoft Teams meeting');
    assert.strictEqual(fallbackName(candidate({ kind: 'sequence', verbs: ['gmail_search', 'sheets_append_rows'], verbApps: ['gmail', 'google_sheets'] })),
        'Search in Gmail, then append rows in Google Sheets');
    assert.strictEqual(appLabel('google_drive'), 'Google Drive');
    assert.strictEqual(appLabel('acme_crm'), 'Acme Crm');
});

test('the deterministic build prompt is the draft, the rhythm and the template', () => {
    const { why, buildPrompt } = fallbackExplanation(candidate());
    assert.match(why, /arriving/);
    assert.match(buildPrompt, /^Build an automation/);
    assert.match(buildPrompt, /Trigger: New email in Gmail\./);
    assert.match(buildPrompt, /Append rows \(Google Sheets\)/);
    assert.match(buildPrompt, /every week/);
    assert.match(buildPrompt, /"Factuur <id> van <name> <domain:A>"/, 'the card\'s lettered domain, never the pseudonym');
});

test('no model configured: deterministic names, no call', async () => {
    const out = await namePatterns([candidate()], { modelId: null, llmClient: null });
    assert.strictEqual(out.called, false);
    assert.strictEqual(out.names[0].source, 'fallback');
    assert.strictEqual(out.names[0].title, 'Handle recurring Gmail emails');
});

test('one call, with the documented parameters and nothing but the cards', async () => {
    const m = stubModel({ patterns: [] });
    const ac = new AbortController();
    await namePatterns([candidate(), candidate({ kind: 'sequence' })], { modelId: 'fast', llmClient: m.llmClient, signal: ac.signal });
    assert.strictEqual(m.calls.length, 1);
    const { tool, opts, messages } = m.calls[0];
    assert.strictEqual(tool, NAME_PATTERNS_TOOL);
    assert.deepStrictEqual({ ...opts, signal: undefined }, { ...NAMING_OPTIONS, signal: undefined });
    assert.strictEqual(opts.maxTokens, 4096);
    assert.strictEqual(opts.reasoningEffort, 'none');
    assert.strictEqual(opts.signal, ac.signal);
    assert.deepStrictEqual(messages.map((x) => x.role), ['system', 'user']);
    const cards = JSON.parse(messages[1].content).patterns;
    assert.deepStrictEqual(cards.map((c) => c.ref), ['A', 'B']);
    for (const card of cards) assert.deepStrictEqual(Object.keys(card).filter((k) => k !== 'ref').sort(), [...CARD_KEYS].sort());
    assert.ok(!messages[1].content.includes('d7'), 'domain pseudonyms are lettered per card');
});

test('the Shield runs on the messages first: what it rewrites is what the model gets', async () => {
    const m = stubModel({ patterns: [] });
    const seen = [];
    const guard = async (messages) => {
        seen.push(messages.length);
        messages[1].content = messages[1].content.replace('<name>', '[person_1]');
        return { blocked: false, categories: ['Person'] };
    };
    const out = await namePatterns([candidate()], { modelId: 'fast', llmClient: m.llmClient, guard });
    assert.deepStrictEqual(seen, [2]);
    assert.ok(m.calls[0].messages[1].content.includes('[person_1]'));
    assert.deepStrictEqual(out.categories, ['Person']);
});

test('a guard that blocks or fails means no call at all (fail closed)', async () => {
    for (const guard of [async () => ({ blocked: true, categories: ['Person'] }), async () => { throw new Error('guard down'); }]) {
        const m = stubModel({ patterns: [{ ref: 'A', title: 'Never used', why: 'x', buildPrompt: 'y' }] });
        const out = await namePatterns([candidate()], { modelId: 'fast', llmClient: m.llmClient, guard });
        assert.strictEqual(m.calls.length, 0);
        assert.strictEqual(out.blocked, true);
        assert.strictEqual(out.names[0].source, 'fallback');
    }
});

test('the model\'s words are cleaned: tokens, addresses, links and invented numbers do not survive', async () => {
    const m = stubModel({
        patterns: [
            {
                ref: 'a',
                title: 'File [person_1]\'s invoices in a sheet',
                why: 'Every invoice from <org> is typed into the sheet by hand. That costs you 11 hours a month.',
                buildPrompt: 'When a mail like "Factuur <id> van <name>" arrives, read the attachment.\n1. Extract the amount.\n2. Append a row.\nMail https://acme.example/x or pieter@acme.example for help.',
            },
            { ref: 'B', title: 42 },               // malformed: costs only itself
            { ref: 'Z', title: 'Nobody asked' },   // no such card
        ],
    });
    const out = await namePatterns([candidate(), candidate({ kind: 'sequence', verbs: ['gmail_search', 'sheets_append_rows'], verbApps: ['gmail', 'google_sheets'] })],
        { modelId: 'fast', llmClient: m.llmClient });
    const [a, b] = out.names;
    assert.strictEqual(a.source, 'llm');
    assert.strictEqual(a.title, 'File someone\'s invoices in a sheet');
    assert.strictEqual(a.why, 'Every invoice from an organisation is typed into the sheet by hand.');
    assert.ok(a.buildPrompt.includes('1. Extract the amount.'), 'list numbering is not a measurement');
    assert.ok(a.buildPrompt.includes('"Factuur <id> van <name>"'), 'placeholders stay in the build prompt');
    assert.ok(!/@|https?:/.test(a.buildPrompt));
    assert.strictEqual(b.source, 'fallback');
    assert.strictEqual(b.title, 'Search in Gmail, then append rows in Google Sheets');
});

test('a title with an invented number falls back whole; numbers the card holds may stay', () => {
    const card = toEvidenceCard(candidate());
    const allowed = allowedNumbers(card, [90]);
    for (const n of ['13', '4.3', '4', '5', '90', '8', '9']) assert.ok(allowed.has(n), n);
    assert.strictEqual(cleanTitle('Save 7 hours on invoices', allowed), '');
    assert.strictEqual(cleanTitle('"Weekly invoices, 13 so far."', allowed), 'Weekly invoices, 13 so far');
    assert.strictEqual(cleanSentences('Seen 13 times. Saves 25 minutes!', allowed, { max: 200, words: true }), 'Seen 13 times.');
    assert.strictEqual(cleanSentences('About 4,3 times a month.', allowed, { max: 200, words: true }), 'About 4,3 times a month.');
});

test('a failing model call falls back to the deterministic names', async () => {
    const m = stubModel(null, { fail: true });
    const out = await namePatterns([candidate()], { modelId: 'fast', llmClient: m.llmClient });
    assert.strictEqual(m.calls.length, 1);
    assert.strictEqual(out.names[0].source, 'fallback');
    assert.strictEqual(out.usage, null);
});

test('a hidden host reads as words in a title, never as a bare placeholder', () => {
    const allowed = allowedNumbers(toEvidenceCard(candidate()), [90]);
    assert.strictEqual(cleanTitle('File invoices from <domain>', allowed), 'File invoices from a website');
    assert.strictEqual(cleanSentences('Mail from <domain> repeats.', allowed, { max: 200, words: true }), 'Mail from a website repeats.');
});
