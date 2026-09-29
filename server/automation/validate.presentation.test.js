/**
 * slide + presentation — what the validator catches before a run wastes a
 * render, and what it must NOT complain about while someone is still typing.
 *
 * Run: node --test --test-force-exit automation/validate.presentation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('./validate');

const base = (steps) => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps,
    edges: steps.map((s, i) => ({ from: i === 0 ? 'trg' : steps[i - 1].id, to: s.id })),
});
const deck = (over = {}) => base([{ id: 'deck', type: 'presentation', slides: '{{trigger.output.text}}', ...over }]);
const slide = (over = {}) => base([{ id: 's1', type: 'slide', title: 'T', content: '- a', ...over }]);

const codes = (def, opts) => validateDefinition(def, opts).errors.map((e) => e.code);
const allCodes = (def, opts) => { const r = validateDefinition(def, opts); return [...r.errors, ...(r.warnings || [])].map((e) => e.code); };

test('both step types are registered — the canary for VALID_STEP_TYPES', () => {
    assert.ok(!allCodes(deck()).includes('step.unknown_type'));
    assert.ok(!allCodes(slide()).includes('step.unknown_type'));
    assert.deepStrictEqual(codes(deck()), []);
    assert.deepStrictEqual(codes(slide()), []);
});

test('presentation: no slides is an error live and a warning while drafting', () => {
    for (const slides of ['', undefined, []]) {
        assert.ok(codes(deck({ slides })).includes('presentation.slides_missing'), JSON.stringify(slides));
        const r = validateDefinition(deck({ slides }), { stage: 'draft' });
        assert.ok(!r.errors.some((e) => e.code === 'presentation.slides_missing'), 'not an error in a draft');
        assert.ok((r.warnings || []).some((e) => e.code === 'presentation.slides_missing'), 'still reported');
    }
});

test('presentation: the three slide shapes validate clean; a number does not; a giant list is refused', () => {
    const listed = base([
        { id: 's1', type: 'slide', title: 'T', content: '- a' },
        { id: 'deck', type: 'presentation', slides: ['{{steps.s1.output.slide}}', { title: 'x', content: '- y' }] },
    ]);
    assert.deepStrictEqual(codes(listed), []);
    assert.deepStrictEqual(codes(deck({ slides: { kind: 'ref', path: 'trigger.output.text' } })), []);
    assert.ok(codes(deck({ slides: 42 })).includes('presentation.slides_shape'));
    assert.ok(codes(deck({ slides: Array.from({ length: 201 }, () => ({ title: 'x' })) })).includes('presentation.slides_too_many'));
});

test('presentation: format, expiry and the reference inside slides are checked', () => {
    const r = validateDefinition(deck({ format: 'odp' }));
    const issue = r.errors.find((e) => e.code === 'presentation.format');
    assert.ok(issue && /pptx/.test(issue.hint) && /pdf/.test(issue.hint));
    for (const format of ['pptx', 'pdf']) assert.deepStrictEqual(codes(deck({ format })), []);
    assert.ok(codes(deck({ expiresInDays: 0 })).includes('presentation.expiry_range'));
    assert.ok(codes(deck({ expiresInDays: 91 })).includes('presentation.expiry_range'));
    // A typo in a slide reference must warn like any other bad ref.
    const bad = validateDefinition(base([
        { id: 's1', type: 'slide', title: 'T', content: '- a' },
        { id: 'deck', type: 'presentation', slides: ['{{steps.s1.output.slide}}', '{{steps.nope.output.slide}}'] },
    ]));
    const refIssue = [...bad.errors, ...(bad.warnings || [])].find((e) => /nope/.test(e.message || '') || /nope/.test(e.path || ''));
    assert.ok(refIssue, `a dangling reference inside slides is reported: ${JSON.stringify([...bad.errors, ...(bad.warnings || [])].map((e) => e.code))}`);
});

test('presentation: no forEach, but an error branch is allowed', () => {
    assert.ok(codes(deck({ forEach: { overRef: 'trigger.output.rows', itemVar: 'r' } })).includes('foreach.type_unsupported'));
    const def = base([
        { id: 'deck', type: 'presentation', slides: '{{trigger.output.text}}' },
        { id: 'n', type: 'notification', title: 'Failed', body: '{{steps.deck.error.message}}', channels: ['in_app'] },
    ]);
    def.edges = [{ from: 'trg', to: 'deck' }, { from: 'deck', to: 'n', label: 'on_error' }];
    assert.ok(!codes(def).some((c) => /on_error/.test(c)), JSON.stringify(codes(def)));
});

test('slide: empty is completeness, a bogus layout is an error, forEach is allowed', () => {
    assert.ok(codes(slide({ title: '', content: '' })).includes('slide.content_missing'));
    const r = validateDefinition(slide({ title: '', content: '' }), { stage: 'draft' });
    assert.ok(!r.errors.some((e) => e.code === 'slide.content_missing'));
    assert.ok(codes(slide({ layout: 'hero' })).includes('slide.layout'));
    for (const layout of ['auto', 'section', 'two_column']) assert.deepStrictEqual(codes(slide({ layout })), []);
    assert.deepStrictEqual(codes(slide({ forEach: { overRef: 'trigger.output.rows', itemVar: 'r' }, title: '{{loop.r.name}}' })), []);
    // An image alone is a slide too.
    assert.deepStrictEqual(codes(slide({ title: '', content: '', image: '{{trigger.output.pic}}' })), []);
});

test('slide visuals: chart shape/type/data, stats shape, style; the chart data reference is checked like any other', () => {
    assert.deepStrictEqual(codes(slide({ chart: { type: 'bar', data: '{{trigger.output.rows}}', labels: 'maand' }, style: 'accent' })), []);
    assert.deepStrictEqual(codes(slide({ chart: { type: 'pie' }, content: '| a | b |\n|---|---|\n| x | 1 |' })), [], 'a bare type charts the table in the content');
    assert.deepStrictEqual(codes(base([{ id: 's1', type: 'slide', stats: '{{trigger.output.total}} | Omzet' }])), [], 'a KPI-only slide is complete');
    assert.ok(codes(slide({ chart: { type: 'bar' } })).includes('slide.chart_data_missing'));
    assert.ok(codes(slide({ chart: 'bar' })).includes('slide.chart_shape'));
    assert.ok(codes(slide({ chart: { type: 'radar', data: '{{trigger.output.rows}}' } })).includes('slide.chart_type'));
    assert.ok(codes(slide({ stats: 42 })).includes('slide.stats_shape'));
    assert.deepStrictEqual(codes(slide({ stats: '{{trigger.output.total}} | Omzet' })), []);
    assert.ok(codes(slide({ style: 'neon' })).includes('slide.style'));
    assert.deepStrictEqual(codes(slide({ layout: 'timeline' })), []);
    assert.deepStrictEqual(codes(slide({ layout: 'chart' })), []);
    const bad = validateDefinition(slide({ chart: { type: 'bar', data: '{{steps.nope.output.rows}}' } }));
    assert.ok([...bad.errors, ...(bad.warnings || [])].some((e) => /nope/.test(e.message || '') || /nope/.test(e.path || '')), 'a dangling chart.data reference is reported');
});

test('presentation look: logo/placement/background/footer/slide numbers/title font are checked; templates pass', () => {
    assert.deepStrictEqual(codes(deck({ logo: 'none', logoPlacement: 'corner', background: '#16191F', footerText: 'x {{trigger.output.a}}', slideNumbers: false, titleFont: 'Georgia' })), []);
    assert.deepStrictEqual(codes(deck({ logo: '{{trigger.output.logo}}', background: '{{trigger.output.bg}}' })), []);
    assert.ok(codes(deck({ logoPlacement: 'left' })).includes('presentation.logoPlacement'));
    assert.ok(codes(deck({ background: 'blue' })).includes('presentation.background'));
    assert.ok(codes(deck({ logo: 42 })).includes('presentation.logo'));
    assert.ok(codes(deck({ slideNumbers: 'yes' })).includes('presentation.slide_numbers'));
    assert.ok(codes(deck({ titleFont: 'Comic Sans' })).includes('presentation.titleFont'));
});
