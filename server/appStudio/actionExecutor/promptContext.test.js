/**
 * promptContext serialisation — the cut that must never land mid-JSON.
 *
 * `JSON.stringify(rows).slice(0, 8000)` was the original, and on a 163-line
 * purchase order it produced eight-and-a-half rows and a dangling brace. The
 * model was then asked to match a drawing against an order it could not parse
 * and answered with empty fields; a triage step fed the same way reported
 * "all 8 drawings must be opened" on that order — the truncation counting,
 * not a judgement.
 *
 * Run: cd server && node --test appStudio/actionExecutor/promptContext.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { serializePromptContext, MAX_PROMPT_CONTEXT_CHARS } = require('./aiSteps');

/** A row roughly the weight of a real projectregel (file descriptors included). */
const row = (i) => ({
    pos: i * 10,
    basisnaam: `mw2604-01-${3000 + i}-001`,
    cad_bestand: `MW2604-01-${3000 + i}-001.step`,
    materiaal: 'Aluminium 6082',
    dikte_mm: 10,
    aantal: 4,
    tekening_file: JSON.stringify({ kind: 'studio_attachment', fileId: `f-${i}`, name: `MW2604-01-${3000 + i}-001.pdf`, mime: 'application/pdf' }),
});

test('a context that fits is passed through untouched', () => {
    const small = [row(1), row(2)];
    assert.equal(serializePromptContext(small), JSON.stringify(small));
});

test('an oversized array sheds whole rows and stays parseable', () => {
    const many = Array.from({ length: 200 }, (_, i) => row(i));
    const out = serializePromptContext(many);

    assert.ok(out.length <= MAX_PROMPT_CONTEXT_CHARS, 'still inside the budget');
    const parsed = JSON.parse(out); // the whole point: this used to throw
    assert.ok(Array.isArray(parsed.rows));
    assert.ok(parsed.rows.length > 0, 'something survives');
    assert.ok(parsed.rows.length < many.length, 'but not everything');
    // Every row that survived is a WHOLE row.
    assert.deepEqual(parsed.rows[parsed.rows.length - 1], many[parsed.rows.length - 1]);
});

test('it says how much it dropped, so the model knows its view is partial', () => {
    const many = Array.from({ length: 200 }, (_, i) => row(i));
    const parsed = JSON.parse(serializePromptContext(many));
    assert.match(parsed._afgekapt, /van 200 rijen weggelaten/);
    assert.match(parsed._afgekapt, new RegExp(`^${200 - parsed.rows.length} `));
});

test('one row too big for the budget yields an honest empty, never half a row', () => {
    const monster = [{ blob: 'x'.repeat(MAX_PROMPT_CONTEXT_CHARS * 2) }];
    const parsed = JSON.parse(serializePromptContext(monster));
    assert.deepEqual(parsed.rows, []);
    assert.match(parsed._afgekapt, /te groot/);
});

test('an object sheds from its longest array and keeps the scalars', () => {
    // THE case this exists for: promptContext on the per-drawing extract is the
    // whole purchase-order result — an OBJECT. Slicing its JSON destroyed the
    // order number and the material list along with the lines.
    const po = {
        ordernummer: 'PO24118',
        materiaalvraag: '',
        materialenlijst: 'x'.repeat(900),
        materialen: Array.from({ length: 20 }, (_, i) => ({ term: `alu${i}`, materiaal: 'Aluminium 6082' })),
        regels: Array.from({ length: 163 }, (_, i) => ({
            pos: (i + 1) * 10, partnummer: `MW2604-01-${3000 + i}-001`, aantal: 4, omschrijving: 'z'.repeat(70),
        })),
    };
    const parsed = JSON.parse(serializePromptContext(po));

    assert.equal(parsed.ordernummer, 'PO24118', 'the scalar the model needs most survives');
    assert.equal(parsed.materialen.length, 20, 'the short list is untouched');
    assert.ok(parsed.regels.length > 0 && parsed.regels.length < 163, 'the long one is trimmed');
    assert.deepEqual(parsed.regels[0], po.regels[0], 'and every surviving row is whole');
    assert.match(parsed._afgekapt.regels, /van 163 weggelaten/);
});

test('an object with nothing to shed says so rather than shipping half of itself', () => {
    const fat = { note: 'y'.repeat(MAX_PROMPT_CONTEXT_CHARS * 2) };
    const parsed = JSON.parse(serializePromptContext(fat));
    assert.equal(parsed._afgekapt, 'context te groot');
});

test('the empty and absent cases are unchanged', () => {
    assert.equal(serializePromptContext(null), '');
    assert.equal(serializePromptContext(undefined), '');
    // "Context:\n[]" reads as "this ticket has no messages" rather than
    // "nothing was selected" — still worse than no header at all.
    assert.equal(serializePromptContext([]), '');
    assert.equal(serializePromptContext('al tekst'), 'al tekst');
});

/**
 * contextSources — the SECOND thing an AI step needs to see.
 *
 * promptContext is one binding, so a draft-reply step could be pointed at the
 * conversation or at the order lines, never both. Given only the conversation,
 * the model cannot name the lines still missing a material or a thickness — the
 * exact question the reply exists to ask. Each source is labelled so the model
 * reads two named tables instead of two anonymous arrays.
 */
test('contextSources: each source is labelled and joined, empty ones dropped', async () => {
    const { resolveContextSources } = require('./aiSteps');

    const step = {
        contextSources: [
            { label: 'Gesprek', source: { kind: 'static', value: [{ van: 'klant', tekst: 'Waar blijft het?' }] } },
            { label: 'Projectregels', source: { kind: 'static', value: [{ pos: 10, materiaal: null }] } },
            // An empty table must not announce itself: "Onbekend:\n[]" reads as
            // a fact ("there are none") rather than "nothing was selected".
            { label: 'Leeg', source: { kind: 'static', value: [] } },
            // A malformed entry is skipped, not thrown over.
            { label: 'Kapot' },
        ],
    };

    const out = await resolveContextSources({}, {}, step, { viewer: { id: 'u1' } }, {});

    assert.match(out, /^Gesprek:\n/, 'the first source keeps its label');
    assert.ok(out.includes('Projectregels:\n'), 'and so does the second');
    assert.ok(out.includes('Waar blijft het?'));
    assert.ok(out.includes('"materiaal":null'), 'the gap itself reaches the model');
    assert.ok(!out.includes('Leeg:'), 'an empty source says nothing at all');
    assert.ok(!out.includes('Kapot'), 'an entry without a source is skipped');
});

test('contextSources: no sources means no extra prompt text', async () => {
    const { resolveContextSources } = require('./aiSteps');
    assert.strictEqual(await resolveContextSources({}, {}, {}, {}, {}), '');
    assert.strictEqual(await resolveContextSources({}, {}, { contextSources: [] }, {}, {}), '');
});

/**
 * markdownToHtml — let the model write markdown, hand the app HTML.
 *
 * Asking a model for hand-rolled HTML costs tokens twice: the prompt has to
 * list which tags are allowed, and the answer carries the tag soup. Markdown is
 * the shape models are best at, and the mail service already owns a converter
 * that outbound e-mail trusts.
 */
test('markdownToHtml: the mail converter turns an agent reply into real HTML', () => {
    const { markdownToHtml } = require('../../services/email/send');
    const md = [
        'Hoi Tom,',
        '',
        'Twee vragen voordat we kunnen snijden:',
        '',
        '1. **TN2506-01-3166-001**: er staat geen materiaal op de bon.',
        '2. **MW2604-01-3021-001**: de dikte is onduidelijk.',
        '',
        'Met vriendelijke groet,',
    ].join('\n');

    const html = markdownToHtml(md);

    assert.ok(html.includes('<p>Hoi Tom,</p>'), 'paragraphs survive as paragraphs');
    assert.ok(html.includes('<ol>') && html.includes('</ol>'), 'a numbered list becomes a list');
    assert.strictEqual((html.match(/<li>/g) || []).length, 2, 'one item per question');
    assert.ok(html.includes('<strong>TN2506-01-3166-001</strong>'), 'the part number stays emphasised');
    // No stray markdown left behind — a reply that ships '**' to a customer
    // looks like a template that failed to render.
    assert.ok(!html.includes('**'), 'no unconverted markdown reaches the customer');
});
