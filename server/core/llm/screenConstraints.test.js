/**
 * The person's screen intent, read off their words and enforced on a design.
 *
 * Run: node --test --test-force-exit core/llm/screenConstraints.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { deriveScreenConstraints, describeScreenConstraints, applyScreenConstraints, isBinding } = require('./screenConstraints');

const el = (kind, label) => ({ kind, label, note: '' });
const DESIGN = {
    name: 'Facturen', tagline: '', look: { preset: 'cloud', accent: '#1e7f4f', mood: '' },
    screens: [
        { name: 'Dashboard', purpose: 'Het totaal zien', sections: [{ title: 'Kerncijfers', layout: 'row', elements: [el('stat', 'Aantal'), el('chart', 'Per maand')] }, { title: 'Alle facturen', layout: 'stack', elements: [el('filters', 'Leverancier'), el('table', 'Facturen')] }] },
        { name: 'Factuur', purpose: 'Eén factuur bekijken', sections: [{ title: 'Details', layout: 'stack', elements: [el('detail', 'Factuur'), el('button', 'Terug')] }, { title: 'Verloop', layout: 'stack', elements: [el('chart', 'Betalingen')] }] },
    ],
    principles: [],
};

test('"only a dashboard" in English and Dutch reads as exactly one screen', () => {
    for (const ask of [
        'Build only a data insight dashboard for the invoices.',
        'I want just a dashboard with totals per supplier.',
        'Maak alleen een dashboard met de kerncijfers.',
        'Enkel een overzicht, niets anders.',
        'Put everything on one screen.',
        'Alles op één scherm.',
        'A single page app: totals and a table.',
        'Dashboard only.',
    ]) {
        const c = deriveScreenConstraints(ask);
        assert.ok(c, ask);
        assert.equal(c.screens, 1, ask);
        assert.equal(c.exact, true, ask);
    }
});

test('"no detail page" is a constraint on its own; an explicit count is exact; nothing said is null', () => {
    assert.deepEqual(deriveScreenConstraints('A dashboard and a list, but no detail page.'), { screens: null, exact: false, noDetail: true, wantsDetail: false, source: 'no detail page' });
    assert.equal(deriveScreenConstraints('Een overzicht zonder detailscherm.').noDetail, true);
    assert.equal(deriveScreenConstraints('Two screens: a dashboard and an invoice page.').screens, 2);
    assert.equal(deriveScreenConstraints('Drie schermen graag.').screens, 3);
    assert.equal(deriveScreenConstraints('Read the invoices into a table and show them.'), null);
    assert.equal(deriveScreenConstraints('', null, undefined), null);
});

test('a detail screen asked for in so many words wins over "only a dashboard"', () => {
    const c = deriveScreenConstraints('Only a dashboard, with a detail page per invoice.');
    assert.equal(c.screens, 2);
    assert.equal(c.noDetail, false);
    // Asked for and nothing else said: an answer, not a constraint.
    const asked = deriveScreenConstraints('Een dashboard en een detailpagina per factuur.');
    assert.equal(asked.wantsDetail, true);
    assert.equal(isBinding(asked), false);
    assert.equal(describeScreenConstraints(asked), '');
    assert.equal(isBinding(deriveScreenConstraints('Add a detail screen for one invoice.')), false);
    assert.ok(deriveScreenConstraints('Add a detail screen for one invoice.'), 'still non-null, so it can lift an earlier rule');
});

test('the first text that states a constraint wins; later texts only fill silence', () => {
    const c = deriveScreenConstraints('Give me the numbers per supplier.', 'Goal: one screen with the totals', '### Screen "A"\n### Screen "B"');
    assert.equal(c.screens, 1);
    assert.equal(deriveScreenConstraints('Two screens please', 'only a dashboard').screens, 2);
});

test('describeScreenConstraints is one binding English line naming the evidence', () => {
    const one = describeScreenConstraints(deriveScreenConstraints('Build only a data insight dashboard.'));
    assert.match(one, /^SCREENS \(binding, from the person's own words "only a data insight dashboard"\): exactly ONE screen — everything the person needs lives on that single screen; never add a second screen, a detail screen or a navigation to another screen\.$/);
    assert.match(describeScreenConstraints(deriveScreenConstraints('no detail screen')), /no detail screen and no record\/drill-down screen/);
    assert.match(describeScreenConstraints(deriveScreenConstraints('two screens')), /exactly 2 screens — never more, never fewer/);
    assert.equal(describeScreenConstraints(null), '');
});

test('applyScreenConstraints folds an extra screen into the first and drops the detail element, and says what it did', () => {
    const { design, changes } = applyScreenConstraints(DESIGN, deriveScreenConstraints('only a dashboard'));
    assert.equal(design.screens.length, 1);
    assert.equal(design.screens[0].name, 'Dashboard');
    // The detail-only section went; the chart section from "Factuur" came along, titled as it was.
    assert.deepEqual(design.screens[0].sections.map((s) => s.title), ['Kerncijfers', 'Alle facturen', 'Details', 'Verloop']);
    assert.deepEqual(design.screens[0].sections[2].elements.map((e) => e.kind), ['button']);
    assert.deepEqual(changes, ['dropped 1 detail element', 'folded 1 extra screen ("Factuur") into "Dashboard" — 2 sections moved']);
    // The input was not mutated.
    assert.equal(DESIGN.screens.length, 2);
});

test('applyScreenConstraints: no-detail alone keeps both screens but strips the record view; a compliant design is returned as-is', () => {
    const { design, changes } = applyScreenConstraints(DESIGN, deriveScreenConstraints('but no detail page'));
    assert.equal(design.screens.length, 2);
    assert.deepEqual(design.screens[1].sections.map((s) => s.elements.map((e) => e.kind)), [['button'], ['chart']]);
    assert.deepEqual(changes, ['dropped 1 detail element']);
    const same = applyScreenConstraints(DESIGN, deriveScreenConstraints('two screens'));
    assert.strictEqual(same.design, DESIGN);
    assert.deepEqual(same.changes, []);
    assert.strictEqual(applyScreenConstraints(DESIGN, null).design, DESIGN);
});

test('the section cap holds when folding: sections beyond it are left behind', () => {
    const many = { ...DESIGN, screens: [DESIGN.screens[0], { name: 'Meer', sections: Array.from({ length: 8 }, (_, i) => ({ title: `S${i}`, layout: 'stack', elements: [el('text', `T${i}`)] })) }] };
    const { design } = applyScreenConstraints(many, deriveScreenConstraints('one screen'), { maxSections: 4 });
    assert.equal(design.screens[0].sections.length, 4);
});
