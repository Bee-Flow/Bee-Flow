// @typecheck
'use strict';
/**
 * Run: node --test automation/patterns/templating.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
    maskText, subjectTemplate, filenameStem, templateIdOf, tokenize, jaccard, clusterTemplates, maskNames, fallbackMask,
    replaceBareDomains,
} = require('./templating');

test('maskText masks urls, addresses, dates, ids and numbers', () => {
    assert.strictEqual(maskText('Mail jan@example.org see https://example.org/x?q=1'), 'Mail <email> see <url>');
    assert.strictEqual(maskText('Due 2026-10-03 and 3/10/26'), 'Due <date> and <date>');
    assert.strictEqual(maskText('Order INV-2026-0042 for 1.234,56'), 'Order <id> for <n>');
    assert.strictEqual(maskText('Ticket #4711'), 'Ticket <id>');
    assert.strictEqual(maskText('Report week 41 and Q3 2026'), 'Report <date> and <date>');
    assert.strictEqual(maskText('Meeting 09:30 on 3 Oct'), 'Meeting <date> on <date>');
});

test('maskText keeps placeholders whole and is idempotent', () => {
    assert.strictEqual(maskText('Invoice from <domain:d9> for <name> <*>'), 'Invoice from <domain:d9> for <name> <*>');
    const once = maskText('Order INV-2026-0042 for 1.234,56 on 2026-10-03');
    assert.strictEqual(maskText(once), once);
    // Only the closed list counts: an address in angle brackets is still masked.
    assert.strictEqual(maskText('From <jan@example.org>'), 'From < <email> >');
});

test('maskText treats long month names as dates but leaves short words alone', () => {
    assert.strictEqual(maskText('Declaratie oktober'), 'Declaratie <date>');
    assert.strictEqual(maskText('Expenses September'), 'Expenses <date>');
    assert.strictEqual(maskText('You may join'), 'You may join');
});

test('accents and non-Latin letters survive masking', () => {
    assert.strictEqual(maskText('Réunion équipe café 12'), 'Réunion équipe café <n>');
    assert.strictEqual(maskText('Überweisung für März'), 'Überweisung für <date>');
    assert.deepStrictEqual(tokenize('Réunion équipe <n>'), ['réunion', 'équipe', '<n>']);
});

test('maskText hides bare hosts and links of any scheme: a real domain never survives', () => {
    // Meeting titles, file names and knowledge uploads have no domain
    // pseudonymiser of their own, and a guard can miss a host: maskText is
    // the floor under every template (events.js runs it on all of them).
    assert.strictEqual(maskText('Weekly sync with acme.com team'), 'Weekly sync with <domain> team');
    assert.strictEqual(maskText('Invoice from Acme-Supplies.nl'), 'Invoice from <domain>');
    assert.strictEqual(maskText('See acme.sharepoint.com/sites/JanDeVries'), 'See <url>');
    assert.strictEqual(maskText('Upload to ftp://files.acme.nl/in'), 'Upload to <url>');
    assert.strictEqual(maskText('Mail jan.devries@acme.nl now'), 'Mail <email> now');
    // A file extension is not a domain.
    assert.strictEqual(maskText('report.pdf attached'), 'report.pdf attached');
    // Placeholders a source already wrote stay whole.
    assert.strictEqual(maskText('From <domain:d1> and acme.nl'), 'From <domain:d1> and <domain>');
});

test('filenameStem hides a host before the dots become spaces, and keeps dotted names', () => {
    assert.strictEqual(filenameStem('/Clients/2026-10-01 Offerte acme.nl.pdf'), '<date> Offerte <domain>');
    assert.strictEqual(filenameStem('export client.portal.com.csv'), 'export <domain>');
    // "Weekly.Report" is a naming style, not a host.
    assert.strictEqual(filenameStem('Weekly.Report.2026-10-01.xlsx'), 'Weekly Report <date>');
});

test('replaceBareDomains leaves an address alone and hands the host to the replacer', () => {
    const seen = [];
    const out = replaceBareDomains('jan.devries@acme.nl and acme.nl/x', (host, path) => { seen.push([host, path]); return '<h>'; });
    assert.strictEqual(out, 'jan.devries@acme.nl and <h>');
    assert.deepStrictEqual(seen, [['acme.nl', '/x']]);
});

test('subjectTemplate strips reply/forward prefixes and external tags', () => {
    assert.strictEqual(subjectTemplate('[EXT] RE: Fwd: AW: Factuur 123'), 'Factuur <n>');
    assert.strictEqual(subjectTemplate('Antw: WG: Offerte'), 'Offerte');
    assert.strictEqual(subjectTemplate('Re[2]: Status'), 'Status');
});

test('filenameStem drops path, extension and copy markers and keeps a date whole', () => {
    assert.strictEqual(filenameStem('/a/b/Sales_report-2026-10-05 (1).xlsx'), 'Sales report <date>');
    assert.strictEqual(filenameStem('C:\\x\\Rapport_week_41.docx'), 'Rapport <date>');
    assert.strictEqual(filenameStem('notes.txt'), 'notes');
});

test('templateIdOf is 12 hex, case-insensitive and stable', () => {
    assert.match(templateIdOf('Factuur <id>'), /^[0-9a-f]{12}$/);
    assert.strictEqual(templateIdOf('Factuur <id>'), templateIdOf('factuur  <id>'));
    assert.notStrictEqual(templateIdOf('Factuur <id>'), templateIdOf('Offerte <id>'));
});

test('jaccard on token sets', () => {
    assert.strictEqual(jaccard(['a', 'b'], ['a', 'b']), 1);
    assert.strictEqual(jaccard(['a', 'b'], ['c']), 0);
    assert.strictEqual(jaccard(['a', 'b', 'c'], ['a', 'b', 'd']), 0.5);
});

test('clusterTemplates merges variants and wildcards the differing position', () => {
    const { clusters, assignment } = clusterTemplates([
        'Weekly report sales', 'Weekly report marketing', 'Invoice <id>', 'Meeting <id>', 'Factuur <id> van <date>', 'Factuur <id> van <date>',
    ]);
    assert.strictEqual(clusters.length, 4);
    assert.strictEqual(clusters[0].template, 'Weekly report <*>');
    assert.deepStrictEqual(assignment, [0, 0, 1, 2, 3, 3]);
    // Two-token templates differing in their only fixed word stay apart.
    assert.notStrictEqual(assignment[2], assignment[3]);
});

test('clusterTemplates merges unequal lengths on Jaccard within a prefix', () => {
    const { clusters } = clusterTemplates(['Order <id> received from shop', 'Order <id> received from the shop']);
    assert.strictEqual(clusters.length, 1);
    assert.deepStrictEqual(clusters[0].members, [0, 1]);
});

test('clusterTemplates ignores empty input', () => {
    const { clusters, assignment } = clusterTemplates(['', '   ']);
    assert.deepStrictEqual(clusters, []);
    assert.deepStrictEqual(assignment, [-1, -1]);
});

test('maskNames batches ONE detectPii call and maps offsets back per line', async () => {
    const calls = [];
    const detectPii = async (text) => {
        calls.push(text);
        const ents = [];
        for (const [word, category] of [['Pieter Jansen', 'Person'], ['Acme', 'Organization']]) {
            let i = text.indexOf(word);
            while (i >= 0) { ents.push({ category, offset: i, length: word.length }); i = text.indexOf(word, i + 1); }
        }
        return { hasPii: ents.length > 0, entities: ents };
    };
    const out = await maskNames(['Invoice from Acme', 'Call with Pieter Jansen', 'Weekly report'], { detectPii });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(out.method, 'guard');
    assert.deepStrictEqual(out.templates, ['Invoice from <org>', 'Call with <name>', 'Weekly report']);
    assert.deepStrictEqual(out.categories, ['Organization', 'Person']);
});

test('maskNames falls back deterministically when the guard is absent', async () => {
    for (const detectPii of [null, undefined, async () => null, async () => { throw new Error('down'); }]) {
        const out = await maskNames(['Invoice from Acme for Jan Jansen', 'Weekly report'], { detectPii });
        assert.strictEqual(out.method, 'fallback');
        assert.deepStrictEqual(out.templates, ['Invoice from <name> for <name>', 'Weekly report']);
    }
});

test('maskNames treats a degraded guard scan as no guard at all', async () => {
    const detectPii = async () => ({ hasPii: false, entities: [], degraded: true, degradedReason: 'guard_circuit_open' });
    const out = await maskNames(['Invoice from Acme'], { detectPii });
    assert.strictEqual(out.method, 'fallback');
    assert.deepStrictEqual(out.templates, ['Invoice from <name>']);
});

test('fallbackMask: capitalised non-initial words and unknown words become <name>', () => {
    assert.strictEqual(fallbackMask('Weekly report Pieter'), 'Weekly report <name>');
    assert.strictEqual(fallbackMask('Bram heeft factuur <id>'), '<name> factuur <id>');
    assert.strictEqual(fallbackMask('Factuur <id> van leverancier'), 'Factuur <id> van leverancier');
    assert.strictEqual(fallbackMask('Factuur <id> van kwekerij'), 'Factuur <id> van <name>');
    assert.strictEqual(fallbackMask('Status update <date>'), 'Status update <date>');
});

test('maskNames on an empty list does not call the guard', async () => {
    let called = false;
    const out = await maskNames([], { detectPii: async () => { called = true; return null; } });
    assert.deepStrictEqual(out.templates, []);
    assert.strictEqual(called, false);
});
