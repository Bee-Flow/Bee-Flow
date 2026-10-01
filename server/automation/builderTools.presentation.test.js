/**
 * builder_add_slide / builder_add_presentation — the AI/MCP route into the
 * presentation pair. Registration canaries (ADD_FOR_TYPE, PATCHABLE_FIELDS,
 * the batch enum, the aliases) plus the one behaviour that matters: `slides`
 * survives the trip in whatever shape the model gave it, and `$tempId`
 * references inside that list are rewritten like every other string.
 *
 * Run: node --test --test-force-exit automation/builderTools.presentation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, TOOL_SCHEMAS } = require('./builderTools');
const { validateDefinition } = require('./validate');

const freshWrap = () => ({
    userId: 'u_test',
    def: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] },
});
const addDeck = (dw, args) => applyToolCall('builder_add_presentation', args, dw);
const addSlide = (dw, args) => applyToolCall('builder_add_slide', args, dw);
const byType = (dw, type) => dw.def.steps.find((s) => s.type === type);

test('both tools exist, with the shape the small model is taught', () => {
    const deck = TOOL_SCHEMAS.find((t) => t.function.name === 'builder_add_presentation');
    assert.ok(deck, 'builder_add_presentation registered');
    assert.deepStrictEqual(deck.function.parameters.required, ['slides']);
    assert.strictEqual(deck.function.parameters.properties.slides.type, undefined, 'slides is string OR list — no `type`, or the llama.cpp grammar rejects one shape');
    assert.deepStrictEqual(deck.function.parameters.properties.format.enum, ['pptx', 'pdf']);
    assert.match(deck.function.description, /steps\.write\.output\.text/);
    assert.match(deck.function.description, /results\[\*\]\.output\.slide/);
    assert.match(deck.function.description, /sourceHandle/);

    const slide = TOOL_SCHEMAS.find((t) => t.function.name === 'builder_add_slide');
    assert.ok(slide, 'builder_add_slide registered');
    assert.deepStrictEqual(slide.function.parameters.required, ['title']);
    assert.ok(slide.function.parameters.properties.forEach, 'a slide can run once per row');
});

test('shape 1: an outline binding lands as a string, the step validates clean, defaults filled', async () => {
    const dw = freshWrap();
    const res = await addDeck(dw, { slides: '{{trigger.output.text}}', title: 'Kwartaal' });
    assert.ok(!res.error, res.error);
    const step = byType(dw, 'presentation');
    assert.strictEqual(step.slides, '{{trigger.output.text}}');
    assert.strictEqual(step.format, 'pptx');
    assert.strictEqual(step.houseStyle, true);
    assert.strictEqual(step.expiresInDays, 7);
    assert.strictEqual(step.label, 'Presentation', 'matches nodeDefs.defaultLabel — serverLabels test compares them');
    assert.strictEqual(step.forEach, undefined);
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});

test('shape 2: a list of slide references is kept as a list, and a batch rewrites $tempIds inside it', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_steps', {
        steps: [
            { type: 'slide', tempId: 'intro', spec: { title: 'Intro', content: '- welkom' } },
            { type: 'slide', tempId: 'cijfers', spec: { title: 'Cijfers', content: '- {{trigger.output.omzet}}' } },
            { type: 'presentation', spec: { title: 'Deck', slides: ['{{steps.$intro.output.slide}}', '{{steps.$cijfers.output.slide}}'] } },
        ],
    }, dw);
    assert.ok(!res.error, JSON.stringify(res));
    const [s1, s2] = dw.def.steps.filter((s) => s.type === 'slide');
    const deck = byType(dw, 'presentation');
    assert.ok(Array.isArray(deck.slides));
    assert.deepStrictEqual(deck.slides, [`{{steps.${s1.id}.output.slide}}`, `{{steps.${s2.id}.output.slide}}`]);
    assert.strictEqual(s1.label, 'Slide');
    assert.deepStrictEqual(validateDefinition(dw.def).errors, [], JSON.stringify(validateDefinition(dw.def).errors));
});

test('shape 3: a slide with forEach followed by a deck over its results', async () => {
    const dw = freshWrap();
    const s = await addSlide(dw, { title: '{{loop.r.name}}', content: '- Omzet: {{loop.r.omzet}}', forEach: { overRef: 'trigger.output.rows', itemVar: 'r' } });
    assert.ok(!s.error, s.error);
    const slide = byType(dw, 'slide');
    assert.deepStrictEqual(slide.forEach, { overRef: 'trigger.output.rows', itemVar: 'r' });
    const d = await addDeck(dw, { afterStepId: slide.id, slides: `{{steps.${slide.id}.output.results[*].output.slide}}`, title: 'Per rij' });
    assert.ok(!d.error, d.error);
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});

test('refusals: an empty deck, an empty slide — each with a hint', async () => {
    const r1 = await addDeck(freshWrap(), { title: 'Leeg' });
    assert.match(r1.error, /slides is required/);
    const r2 = await addSlide(freshWrap(), {});
    assert.match(r2.error, /title or some content/);
});

test('aliases: "deck", "pptx", "powerpoint", "slides" and "dia" reach the right builders', async () => {
    for (const type of ['deck', 'pptx', 'powerpoint', 'slides']) {
        const dw = freshWrap();
        const res = await applyToolCall('builder_add_steps', { steps: [{ type, spec: { slides: '{{trigger.output.text}}' } }] }, dw);
        assert.ok(!res.error, `${type}: ${res.error}`);
        assert.strictEqual(dw.def.steps[0].type, 'presentation', type);
    }
    const dw = freshWrap();
    await applyToolCall('builder_add_steps', { steps: [{ type: 'dia', spec: { title: 'x' } }] }, dw);
    assert.strictEqual(dw.def.steps[0].type, 'slide');
});

test('update: slides is replaced wholesale, format/houseStyle/layout are coerced like on add', async () => {
    const dw = freshWrap();
    await addDeck(dw, { slides: '{{trigger.output.text}}', title: 'Eerste' });
    const id = byType(dw, 'presentation').id;
    let res = await applyToolCall('builder_update_step', { stepId: id, patch: { slides: ['{{trigger.output.a}}'], format: 'pdf', houseStyle: false, expiresInDays: 500 } }, dw);
    assert.ok(!res.error, res.error);
    const deck = byType(dw, 'presentation');
    assert.deepStrictEqual(deck.slides, ['{{trigger.output.a}}']);
    assert.strictEqual(deck.format, 'pdf');
    assert.strictEqual(deck.houseStyle, false);
    assert.strictEqual(deck.expiresInDays, 90);
    assert.strictEqual(deck.title, 'Eerste', 'untouched fields stay');

    await addSlide(dw, { title: 'S', layout: 'section' });
    const sid = byType(dw, 'slide').id;
    res = await applyToolCall('builder_update_step', { stepId: sid, patch: { layout: 'hero', notes: 'n' } }, dw);
    assert.ok(!res.error, res.error);
    const slide = byType(dw, 'slide');
    assert.strictEqual(slide.layout, undefined, 'an unknown layout clears it → auto');
    assert.strictEqual(slide.notes, 'n');
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});

// Review M5a: update_step sent a pick through bindingToTemplate, which has
// no text for one, and stored slides: '' without an error.
test('update: slides given as a pick is stored as the add path stores it', async () => {
    const dw = freshWrap();
    const slides = { pick: 'trigger.output.rows[*].slide' };
    const added = await addDeck(dw, { slides, title: 'Eerste' });
    assert.ok(!added.error, added.error);
    const fromAdd = byType(dw, 'presentation').slides;
    assert.strictEqual(fromAdd.kind, 'pick');
    assert.strictEqual(fromAdd.take, 'all');
    await applyToolCall('builder_update_step', { stepId: byType(dw, 'presentation').id, patch: { slides: '{{trigger.output.text}}' } }, dw);
    const res = await applyToolCall('builder_update_step', { stepId: byType(dw, 'presentation').id, patch: { slides } }, dw);
    assert.ok(!res.error, res.error);
    assert.deepStrictEqual(byType(dw, 'presentation').slides, fromAdd);
});

test('replace: a generate_document can be swapped for a presentation and keeps its id', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_add_generate_document', { content: '{{trigger.output.text}}', layout: 'slides' }, dw);
    const id = dw.def.steps[0].id;
    const res = await applyToolCall('builder_replace_step', { stepId: id, newType: 'presentation', spec: { slides: '{{trigger.output.text}}' } }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(dw.def.steps[0].id, id);
    assert.strictEqual(dw.def.steps[0].type, 'presentation');
});

test('visuals: chart/stats/style land on a slide as the executor reads them; the look fields land on a deck; update coerces like add', async () => {
    const dw = freshWrap();
    let res = await addSlide(dw, { title: 'Omzet', chart: { type: 'BAR', data: { kind: 'ref', path: 'trigger.output.rows' }, labels: 'maand', values: ['omzet', 'kosten'], stacked: true, unit: '€' }, style: 'accent' });
    assert.ok(!res.error, res.error);
    let s = byType(dw, 'slide');
    assert.deepStrictEqual(s.chart, { type: 'bar', data: '{{trigger.output.rows}}', labels: 'maand', values: 'omzet,kosten', stacked: true, unit: '€' });
    assert.strictEqual(s.style, 'accent');
    // A slide that is ONLY a KPI row is enough
    res = await applyToolCall('builder_add_slide', { title: '', stats: '{{trigger.output.total}} | Omzet' }, dw);
    assert.ok(!res.error, res.error);
    // Deck look
    res = await addDeck(dw, { slides: '{{trigger.output.text}}', logo: 'none', logoPlacement: 'corner', background: '#16191F', footerText: 'Vertrouwelijk', slideNumbers: false, titleFont: 'georgia', preset: 'dark' });
    assert.ok(!res.error, res.error);
    const d = byType(dw, 'presentation');
    assert.strictEqual(d.logo, 'none');
    assert.strictEqual(d.logoPlacement, 'corner');
    assert.strictEqual(d.background, '#16191F');
    assert.strictEqual(d.footerText, 'Vertrouwelijk');
    assert.strictEqual(d.slideNumbers, false);
    assert.strictEqual(d.titleFont, 'Georgia');
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
    // Update: an invalid chart type falls back, a blank logo clears, "geen" is none
    res = await applyToolCall('builder_update_step', { stepId: s.id, patch: { chart: { type: 'radar', data: 'a: 1\nb: 2' }, style: 'neon' } }, dw);
    assert.ok(!res.error, res.error);
    s = byType(dw, 'slide');
    assert.deepStrictEqual(s.chart, { type: 'column', data: 'a: 1\nb: 2' });
    assert.strictEqual(s.style, undefined);
    res = await applyToolCall('builder_update_step', { stepId: d.id, patch: { logo: 'Geen', logoPlacement: 'middle', background: 'blue' } }, dw);
    assert.ok(!res.error, res.error);
    const d2 = byType(dw, 'presentation');
    assert.strictEqual(d2.logo, 'none');
    assert.strictEqual(d2.logoPlacement, undefined);
    assert.strictEqual(d2.background, undefined);
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
    // The schemas teach the same vocabulary, briefly
    const slideTool = TOOL_SCHEMAS.find((t) => t.function.name === 'builder_add_slide').function.parameters.properties;
    assert.strictEqual(slideTool.chart.properties.data.type, undefined, 'chart.data has no type — llama.cpp grammar');
    assert.ok(slideTool.layout.enum.includes('timeline') && slideTool.style.enum.includes('accent'));
    const deckTool = TOOL_SCHEMAS.find((t) => t.function.name === 'builder_add_presentation').function.parameters.properties;
    for (const k of ['logo', 'logoPlacement', 'background', 'footerText']) assert.ok(deckTool[k] && deckTool[k].description.length < 220, `${k} described in one sentence`);
});

test('saveCopy: the deck can be kept in Studio → Documents; only true is stored, and update coerces like add', async () => {
    const { applyToolCall, TOOL_SCHEMAS } = require('./builderTools');
    const dw = { userId: 'u', def: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] } };
    await applyToolCall('builder_add_presentation', { slides: '{{steps.w.output.text}}', saveCopy: true }, dw);
    const step = dw.def.steps[0];
    assert.strictEqual(step.saveCopy, true);
    const dw2 = { userId: 'u', def: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] } };
    await applyToolCall('builder_add_presentation', { slides: '{{steps.w.output.text}}', saveCopy: 'yes' }, dw2);
    assert.strictEqual(dw2.def.steps[0].saveCopy, undefined);
    const res = await applyToolCall('builder_update_step', { stepId: step.id, patch: { saveCopy: false, copyName: 'Deck {{trigger.date}}' } }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(dw.def.steps[0].saveCopy, false);
    assert.strictEqual(dw.def.steps[0].copyName, 'Deck {{trigger.date}}');
    assert.strictEqual(TOOL_SCHEMAS.find(t => t.function.name === 'builder_add_presentation').function.parameters.properties.saveCopy.type, 'boolean');
});
