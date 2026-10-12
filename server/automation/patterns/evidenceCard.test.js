// @typecheck
'use strict';
/**
 * Run: node --test automation/patterns/evidenceCard.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { toEvidenceCard, CARD_KEYS, safeText } = require('./evidenceCard');

const candidate = {
    kind: 'mail_template', template: 'Factuur <id> van <domain:d9>', apps: ['gmail', 'google-sheets'],
    verbs: ['mail.received', 'sheets_append_rows'], domains: ['d1', 'd2', 'd1'], occurrences: 13, distinctDays: 13,
    timestamps: [1, 2, 3], spansMs: [1000], signature: 'abc', score: 1.5, reasons: ['frequent'],
    cadence: { kind: 'weekly', weekday: 1, hourBand: [8, 9], cv: 0.1, perMonth: 4.333, weeksPresent: 13, weeksWindow: 13, weekdayHistogram: [0, 13, 0, 0, 0, 0, 0], lastTs: 99 },
    minutes: { range: [3, 7], basis: 'heuristic' }, confidence: 'high',
    draft: { trigger: { kind: 'app', app: 'gmail', provider: 'gmail', event: 'mail.new', label: 'New email in Gmail' }, steps: [{ family: 'app', app: 'google-sheets', label: 'Append rows', tool: 'x' }] },
    // Things that must never reach a model.
    subject: 'Factuur 4711 van Pieter Jansen', sender: 'pieter@example.org', domain: 'example.org', body: 'secret', rawRows: [{ a: 1 }],
};

test('the card carries exactly the allow-listed keys', () => {
    const card = toEvidenceCard(candidate);
    assert.deepStrictEqual(Object.keys(card).sort(), [...CARD_KEYS].sort());
    assert.deepStrictEqual(Object.keys(card.cadence).sort(), ['hourBand', 'kind', 'weekday']);
    assert.deepStrictEqual(Object.keys(card.draft.trigger).sort(), ['app', 'kind', 'label']);
    assert.deepStrictEqual(Object.keys(card.draft.steps[0]).sort(), ['app', 'family', 'label']);
});

test('unknown keys never leak, at any depth', () => {
    const json = JSON.stringify(toEvidenceCard({ ...candidate, futureField: 'LEAK-1', cadence: { ...candidate.cadence, extra: 'LEAK-2' }, draft: { ...candidate.draft, extra: 'LEAK-3' } }));
    for (const needle of ['LEAK', 'Pieter', 'pieter@', 'example.org', 'secret', 'signature', 'timestamps', 'provider', 'mail.new', '4711']) {
        assert.ok(!json.includes(needle), `card leaks ${needle}`);
    }
});

test('domains become letters, in order of first appearance, also inside the template', () => {
    const card = toEvidenceCard(candidate);
    assert.deepStrictEqual(card.domains, ['domain A', 'domain B']);
    assert.strictEqual(card.template, 'Factuur <id> van <domain:C>');
    // One map: the template's pseudonym that is also in the list gets its letter.
    const same = toEvidenceCard({ ...candidate, domains: ['d9', 'd1'] });
    assert.deepStrictEqual(same.domains, ['domain A', 'domain B']);
    assert.strictEqual(same.template, 'Factuur <id> van <domain:A>');
});

test('numbers are rounded and the histogram is always seven integers', () => {
    const card = toEvidenceCard(candidate);
    assert.strictEqual(card.perMonth, 4.3);
    assert.deepStrictEqual(card.weekdayHistogram, [0, 13, 0, 0, 0, 0, 0]);
    assert.deepStrictEqual(toEvidenceCard({ kind: 'sequence' }).weekdayHistogram, [0, 0, 0, 0, 0, 0, 0]);
});

test('a template with an address or url is withheld', () => {
    assert.strictEqual(toEvidenceCard({ ...candidate, template: 'Mail from pieter@example.org' }).template, null);
    assert.strictEqual(toEvidenceCard({ ...candidate, template: 'See https://x.example' }).template, null);
    assert.strictEqual(safeText('x'.repeat(500)).length, 160);
});

test('unknown enum values fall back to safe defaults', () => {
    const card = toEvidenceCard({ kind: 'evil', confidence: 'certain', cadence: { kind: 'hourly' }, apps: ['ok', 'not ok', 'a@b'], draft: { trigger: { kind: 'webhook', label: 'x' }, steps: [{ family: 'shell', label: 'rm' }] } });
    assert.strictEqual(card.kind, 'sequence');
    assert.strictEqual(card.confidence, 'normal');
    assert.strictEqual(card.cadence.kind, 'irregular');
    assert.deepStrictEqual(card.apps, ['ok']);
    assert.strictEqual(card.draft.trigger.kind, 'manual');
    assert.strictEqual(card.draft.steps[0].family, 'app');
    assert.strictEqual(card.minutes, null);
});

test('a template that still holds a link of any scheme never reaches a model', () => {
    for (const template of ['Upload to ftp://files.example.org/in', 'Open smb://share/x', 'Mail jan@example.org']) {
        assert.strictEqual(toEvidenceCard({ ...candidate, template }).template, null, template);
    }
    assert.strictEqual(safeText('Factuur <id> van <domain:A>'), 'Factuur <id> van <domain:A>');
});
