/**
 * Unit tests for the AI-builder catalog rendering (catalogRender.js).
 *
 * Pins the three contracts the builder route depends on:
 *   1. byte-stability — the rendered catalog is identical across calls, which
 *      is what keeps provider prompt caches warm across builder turns;
 *   2. completeness — all six binding kinds, all action kinds and all step
 *      kinds appear (spec-derived, so a catalog addition shows up here);
 *   3. prompt budget — the rendered text stays under a fixed ceiling. Every
 *      builder turn pays for this text, on every model, so it is a cost and
 *      latency guardrail rather than a capability one. (It began life as the
 *      gate for a local fine-tuned builder model; that model was removed, so
 *      the small-model justification no longer applies — the budget does.)
 *
 * Run: node --test appStudio/builderPrompt/catalogRender.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    renderCatalogText,
    renderCompactCatalogText,
    buildCatalogSections,
    renderComponentEntry,
    renderStepEntry,
    renderComponentCompact,
    COMPACT_STEP_KINDS,
} = require('./catalogRender');
const crypto = require('node:crypto');
const {
    BINDING_KINDS,
    ACTION_KINDS,
    ACTION_SPECS,
    STEP_KINDS,
    STEP_SPECS,
    COMPONENT_TYPES,
    COMPONENT_SPECS,
    DATA_MUTATING_STEP_KINDS,
    LIMITS,
    STYLE_KNOBS,
    SECTION_STYLE_KNOBS,
    ADVANCED_WIDTH_KNOBS,
    ADVANCED_HEIGHT_KNOBS,
    expandStyleKnobs,
} = require('../componentSpecs');
const { FIELD_TYPES, FILTER_OPS, ACCESS_MODES, SYSTEM_COLUMNS } = require('../dataModel');
const { EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES } = require('../../automation/expr');

/**
 * Raised 27_000 → 30_000 when the local builder model was removed. The old
 * ceiling was set by what an 8B model could afford; nothing runs on that any
 * more, and the catalog had 56 chars of headroom left, so a single new
 * component type could not be added without trimming unrelated descriptions.
 *
 * Raised 30_000 → 32_000 for the v3 batch (stepper, file_gallery,
 * connector_status, two nav styles, screen.description): measured 30_476 with
 * the three new descriptions already written as tightly as they can teach.
 * The alternative was cutting the teaching text on `pane` and `message_thread`,
 * which exists because authors get those two wrong — paying ~500 tokens a turn
 * beats a builder that lays out sidebars incorrectly.
 *
 * Raised 32_000 → 33_000 for declared variables: measured 31_251 with the
 * ### Variables block, which is 5 lines rendered from VARIABLE_SPEC. The 749
 * chars of headroom left under the old ceiling was too thin to leave — one more
 * component type and this test would fail for an unrelated change.
 *
 * Raised 33_000 → 36_000 for the look pass (v2.2): measured 34_167 with the
 * twelve look/accent/cardLook enums, the two button variants and the two
 * background values. Honesty note: the catalog measured 33_425 BEFORE the
 * look pass — an earlier addition had already outgrown the 33_000 ceiling
 * without this test being re-run, so 742 of the overage is the look pass and
 * 425 predates it. 36_000 leaves ~1.8k headroom, because the 749 chars left
 * at the 32_000 bump proved too thin to survive one unrelated change.
 *
 * Raised 36_000 → 37_000 for prop descriptions: measured 35_825. The look
 * pass shipped its enums but renderPropSpec dropped their `description`
 * strings, so the model saw "striped"|"minimal"|"cards" as opaque tokens and
 * kept picking the default — the whole point of the pass. Rendering the 13
 * descriptions costs +1_840; retiring the bindings summary line ("Use static
 * for fixed copy, …" — each shape already carries the same gloss inline)
 * bought back 200. Net +1_658 over 34_167, leaving ~1.2k headroom.
 *
 * Raised 37_000 → 40_000 for the ### Formulas block: measured 37_972, i.e.
 * +2_147 over the 35_825 that preceded it. Of that, 1_163 is the function
 * vocabulary itself (68 signatures, DERIVED from EXPR_FUNCTION_NAMES) and ~980
 * is three prose lines — the totality rule, the `^` precedence trap and the
 * "that is the whole vocabulary" close. This is the single most expensive line
 * item added to the catalog, and it is here because its absence had a
 * measurable cost: the maths family (pow/sqrt/ln/log/exp/trig, PI(), E(), `^`)
 * shipped with NOTHING in the prompt naming any of it, and the builder told a
 * user their scientific calculator could not be built. A vocabulary the model
 * cannot see is a vocabulary that does not exist.
 *
 * 40_000 (not 38_000) because the block GROWS with the engine: every function
 * another agent adds lands here automatically, which is the whole point of
 * deriving it — but it means the ceiling has to carry slack for that growth.
 * ~2_000 chars ≈ 60 more signatures.
 *
 * Raised 40_000 → 42_000 for the ### Node logic block: measured 39_379, i.e.
 * +1_407 over the 37_972 that preceded it, and only 621 chars of headroom left
 * under the old ceiling — thinner than the 749 that already proved too thin
 * once. The block documents `computed`, `readOnly` and `validations`, which
 * existed in canonicalize, validate AND the renderer while appearing in no
 * schema and no prompt. That gap has the same shape as the maths-family one
 * above and cost the same thing: 22 of the component types have no
 * binding-typed prop, so without `computed` every string on a heading, button
 * or callout is static forever — and a builder that tried to show a running
 * value on one, failed, and reported that live binding was architecturally
 * limited was reasoning correctly from what it had been told.
 *
 * NOT raised for advanced sizing (the four width/height knobs): measured
 * 40_715, i.e. +1_336 over the 39_379 above, leaving 1_285 under the ceiling.
 * The honest arithmetic, because the temptation was to bump to 43_000 and not
 * think about it: +80 is the two `unitInt` knobs finally rendering their
 * per-unit ranges instead of a bare name (a bare `widthValue` teaches nothing,
 * and one merged range would teach a lie — 40..2000 is right for px and absurd
 * for pct), and the other ~1_256 is the four-line Advanced sizing block.
 *
 * That block is priced against the alternative it replaces. Availability is
 * DERIVED (componentSpecs.expandStyleKnobs: the width pair follows `span`, the
 * height pair follows `height`), so the obvious rendering — appending the pairs
 * to every type's `style:` line — costs ~1_500 chars to say the same sentence
 * 48 times and drifts the moment one array is missed. One stated rule is
 * cheaper AND cannot drift. The three facts in the block are all unguessable
 * from the knob list: that `span` keeps owning placement (so the two knobs
 * compose instead of competing), that a percentage height is an ERROR rather
 * than a no-op without a definite parent, and that an exact width is capped on
 * mobile — a model that does not know the last one avoids the feature.
 *
 * 1_285 is thinner than the 2_621 the last bump left, and deliberately not
 * bumped: it is still ~3 new component types of room, roughly double the 621
 * and 749 margins that have each proved too thin, and unlike the formula block
 * this one does not grow with another module — it grows only if someone adds a
 * unit to a unitInt knob.
 *
 * Raised 42_000 → 44_000 for the table/person pass: measured 41_959, i.e.
 * +1_244 over the 40_715 above, leaving FORTY-ONE chars of headroom — past
 * thin, into "the next line of prose fails the build for no design reason".
 *
 * The arithmetic, again honestly. ~684 of it is the data_grid and table column
 * shapes rendering their new field list: eight appended `format` values
 * (currency/percent/datetime/relative/check/tags/progress/user) plus align,
 * truncate, hidden, toneFrom, labelFrom and toneMap, on BOTH components. That
 * is derived text, not prose — it grows because the schema grew, and it is the
 * part a builder cannot guess: `toneFrom` is what makes a status pill take the
 * colour its own config table already stores, and a model that cannot see the
 * key writes another grey table.
 *
 * The other ~560 is `input_person`, whose description carries the one fact
 * about it that is unguessable: it publishes `<name>_label` alongside the id,
 * because there are no joins and the server has no directory at write time, so
 * an action that writes only the id stores a row nobody can read. A picker
 * documented without that produces apps whose assignee column shows user ids.
 *
 * 44_000 not 43_000: 2_041 of headroom is ~4 component types, in the range the
 * 2_621 margin that held comfortably occupied, and above the 621/749/1_285
 * margins that have each had to be revisited.
 *
 * 48_000 (health-data wave, measured 2026-08-20): the catalog was 43_689 under
 * the 44_000 ceiling — 311 of headroom, i.e. already spent. That wave added two
 * component types (input_dataset, browser_view), two step kinds (dataset_query,
 * ai_browse) and six chart props (time axis, y bounds, reference lines/bands,
 * unit label), and the rendered catalog measured 45_980 AFTER trimming every
 * new description to the facts a builder cannot guess. Five real capabilities
 * genuinely cost ~2_290 chars; the previous ceiling could not have absorbed
 * them. 48_000 restores ~2_020 of headroom — the same ~4-types margin the
 * 44_000 bump aimed for, at ≈12_000 tokens.
 *
 * It is still a real limit: this text is re-sent on every builder turn, so it
 * costs tokens and latency on every model. Bump it deliberately, with a fresh
 * measurement — not to make room for prose.
 *
 * 48_000 → 52_000 (data_grid grouping/active-row pass, measured 2026-09-02):
 * the catalog was ALREADY 48_378 before this pass — the ceiling had been
 * silently overrun by earlier growth, so this bump first pays off that debt.
 * The pass itself costs 579: groupBy/groupOrder/activeWhen with one-line
 * descriptions (grouping semantics and the per-row formula contract are the
 * two things a builder cannot guess) plus five derived column-shape tokens
 * (subtextFrom, subtextToneFrom, badgeStyle, flagFrom, flagTone). Measured
 * 48_957; 52_000 leaves ~3_000 headroom for the sibling passes of the same
 * design wave (tabs badges, progress segments, list grouping).
 *
 * NOT raised for the rest of that wave (compacted instead, 2026-09-05): the
 * 48_957 above was a MID-batch measurement — the same squashed commit went on
 * to land the predicted sibling passes AND more (message_thread email/events,
 * list peek*, modal placement, hideBelow/hideAbove, chart orientation, AI
 * contextSources, four filter ops), ending at 53_300 — 1_300 over the ceiling
 * it had itself just set, with the budget test evidently not re-run at batch
 * end. Four derived formula functions later: 53_454. All of it is legitimate
 * spec-derived product, but the renderer was carrying pure redundancy, so the
 * budget was recovered there rather than bumped: (a) "(default null)"/"[]"/
 * "false" annotations — 150+ statements that absent means absent, now one
 * convention line (~2_300 back); (b) the nine action kinds whose field spec is
 * byte-identical to their step twin rendered the full list twice, now a
 * pointer to ### Sequence steps when that is the shorter form (~800 back).
 * Measured 50_345 — ~1_650 headroom, no information removed from the prompt.
 */
const CATALOG_CHAR_CEILING = 52_000;

test('renderCatalogText is byte-stable across calls (prompt-cache discipline)', () => {
    const a = renderCatalogText();
    const b = renderCatalogText();
    assert.strictEqual(a, b);
    assert.strictEqual(typeof a, 'string');
    assert.ok(a.length > 1000, 'catalog is non-trivial');
});

test('all binding kinds are taught, with the exact filter/sort grammar', () => {
    const text = renderCatalogText();
    assert.strictEqual(BINDING_KINDS.length, 8, 'spec still has eight binding kinds');
    for (const kind of BINDING_KINDS) {
        assert.ok(text.includes(`"kind": "${kind}"`), `binding kind ${kind} appears with its shape`);
    }
    // The records/record query grammar: filter entries, formula-valued filter
    // form, sort shape and the system columns.
    assert.ok(text.includes('"op"'), 'filter entry shape present');
    assert.ok(text.includes(FILTER_OPS.join('|')), 'the closed op vocabulary is spelled out');
    assert.ok(text.includes('{"kind":"formula","expr"'), 'formula-valued filter form taught');
    assert.ok(text.includes('"dir": "asc"|"desc"'), 'sort shape taught');
    assert.ok(text.includes(SYSTEM_COLUMNS.join('/')), 'system columns listed as filterable/sortable');
});

test('all action kinds are rendered — inline fields, or a pointer to an identical step twin', () => {
    // Since the 2026-09 compaction an action kind whose field spec is
    // byte-identical to the step of the same name may render as a pointer to
    // ### Sequence steps instead of repeating the full list (the fields were
    // rendered twice, verbatim, ~30 lines apart). The pointer is only legal
    // when the twin really is identical — a kind that differs (run_automation)
    // or has no step twin (sequence) must keep its fields inline.
    const text = renderCatalogText();
    for (const kind of ACTION_KINDS) {
        assert.ok(new RegExp(`^${kind}: \\{`, 'm').test(text), `action kind ${kind} rendered with a shape`);
        const twin = STEP_SPECS[kind];
        const identicalTwin = twin
            && JSON.stringify(twin.fields) === JSON.stringify(ACTION_SPECS[kind].fields);
        if (!identicalTwin) {
            assert.ok(
                !new RegExp(`^${kind}: \\{ …`, 'm').test(text),
                `${kind} has no identical step twin, so its action fields must stay inline`,
            );
        }
    }
    assert.ok(text.includes('open_modal: { modalId'), 'open_modal shape present');
    assert.ok(text.includes('sequence: { steps'), 'sequence shape present');
    // Derived, not re-typed: the catalog must teach whatever the limit
    // currently is, so raising the cap cannot leave the prompt teaching a
    // stale number to the builder.
    assert.ok(text.includes(`max ${LIMITS.MAX_ACTION_STEPS} steps`), 'MAX_ACTION_STEPS cap taught');
});

test('all step kinds are rendered from STEP_SPECS with the client/server partition', () => {
    const text = renderCatalogText();
    for (const kind of STEP_KINDS) {
        assert.ok(
            new RegExp(`^${kind} \\[(client|SERVER)\\]: \\{`, 'm').test(text),
            `step kind ${kind} rendered with its side tag`,
        );
    }
    for (const kind of DATA_MUTATING_STEP_KINDS) {
        assert.ok(new RegExp(`^${kind} \\[SERVER\\]:`, 'm').test(text), `${kind} tagged server-side`);
    }
    assert.ok(text.includes('run on the API'), 'client-vs-server note present');
});

test('the data-model contract section is rendered from dataModel.js constants', () => {
    const text = renderCatalogText();
    assert.ok(text.includes('### Data model'), 'section present');
    assert.ok(text.includes(FIELD_TYPES.join(', ')), 'FIELD_TYPES listed');
    assert.ok(text.includes(ACCESS_MODES.join(' | ')), 'ACCESS_MODES listed');
    assert.ok(text.includes(SYSTEM_COLUMNS.join(', ')), 'system columns listed');
    assert.ok(/\d+ tables\/app/.test(text), 'DATA_LIMITS caps rendered');
    assert.ok(text.includes('snake_case'), 'key grammar taught');
});

test('every component type appears in the catalog', () => {
    const text = renderCatalogText();
    for (const type of COMPONENT_TYPES) {
        assert.ok(new RegExp(`^${type} \\[`, 'm').test(text), `component ${type} rendered`);
    }
});

test('every prop description is rendered, on the single props line', () => {
    // The look/accent/cardLook enums carry `description` strings explaining
    // what each value LOOKS like (striped = zebra rows, hero = a tall centered
    // masthead). Without them in the prompt the model sees opaque tokens and
    // ships the default for everything — which is exactly the sameness the
    // look pass exists to end.
    const text = renderCatalogText();
    const lines = text.split('\n');
    let described = 0;
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
        for (const [key, fs] of Object.entries(spec.props || {})) {
            if (!fs.description) continue;
            described++;
            assert.ok(text.includes(`— ${fs.description}`), `${type}.${key} description rendered`);
            const line = lines.find((l) => l.includes(fs.description));
            assert.ok(line && line.trimStart().startsWith('props:'),
                `${type}.${key} description stays compact on the one props line`);
        }
    }
    // The 13 look-pass descriptions are the reason this rendering exists; a
    // drop below that count means someone stripped them from the spec.
    assert.ok(described >= 13, `expected the look-pass descriptions to be in the spec (saw ${described})`);
});

/**
 * The formula vocabulary is DERIVED from the engine, not transcribed.
 *
 * This is the drift test. The maths family landed in shared/expr with zero
 * mentions anywhere in the prompt, so the builder could not use pow/sqrt/ln or
 * the `^` operator and reported a scientific calculator as impossible. Walking
 * EXPR_FUNCTION_NAMES (= Object.keys(FUNCTIONS), the exact set the parser
 * accepts) means the next function another agent adds appears in the prompt
 * with no edit here at all — and if someone replaces the derivation with a
 * hand-typed list, this test fails the moment the engine moves.
 */
test('every callable function name in the engine is rendered in the catalog', () => {
    const text = renderCatalogText();
    assert.ok(text.includes('### Formulas'), 'the formula section exists');
    const section = text.slice(text.indexOf('### Formulas'), text.indexOf('### Variables'));
    assert.ok(EXPR_FUNCTION_NAMES.length > 20, 'sanity: the engine has a real whitelist');
    for (const name of EXPR_FUNCTION_NAMES) {
        assert.ok(section.includes(`${name}(`), `formula function ${name} is missing from the catalog`);
    }
    // Signatures, not bare names: arity and argument names are most of the
    // teaching value (substring(text, start, end?) vs "substring").
    for (const f of EXPR_FUNCTIONS) {
        assert.ok(section.includes(f.signature), `signature ${f.signature} rendered verbatim`);
    }
});

test('the formula section teaches the operators and the NaN hole in totality', () => {
    // These are the two things the signature list cannot carry, and both have
    // burned a real build: `^` binds tighter than unary minus, and the bare
    // arithmetic operators are the ONE place the engine leaks NaN (every
    // whitelisted helper normalises it to null).
    const text = renderCatalogText();
    assert.match(text, /-2\^2 = -4/, 'the unary-minus precedence trap is spelled out');
    assert.match(text, /2\^3\^2 = 512/, 'right-associativity is spelled out');
    assert.match(text, /PI\(\) and E\(\)/, 'the constants are taught as bracketed calls');
    assert.match(text, /is NaN/, 'the operators-leak-NaN rule is stated');
    assert.match(text, /isEmpty\(x\) \? 0 :/, 'the guard form is given');
});

test(`prompt budget: rendered catalog stays under ${CATALOG_CHAR_CEILING} chars`, () => {
    const text = renderCatalogText();
    assert.ok(
        text.length < CATALOG_CHAR_CEILING,
        `catalog is ${text.length} chars — over the ${CATALOG_CHAR_CEILING} ceiling (≈${Math.round(CATALOG_CHAR_CEILING / 4)} tokens). ` +
        'Trim the rendering, or bump the ceiling deliberately after measuring.',
    );
});

/**
 * The node-logic block. `computed`, `readOnly` and `validations` shipped in
 * canonicalize, validate and the renderer with NOTHING in the catalog or the
 * schemas naming them — the same failure mode as the maths family, and with a
 * sharper consequence: most component types have no binding-typed prop, so
 * without `computed` a builder correctly concludes that a heading can never
 * show a live value.
 */
test('the node-logic block teaches computed as the live-prop escape hatch', () => {
    const text = renderCatalogText();
    assert.match(text, /### Node logic/);
    assert.match(text, /computed: \{ "<propKey>"/, 'the shape is given');
    assert.match(text, /makes ANY prop LIVE/, 'what it is FOR is stated, not just its shape');
    assert.match(text, /overrides that prop/, 'the precedence over props is stated');
    for (const flag of ['visibleWhen', 'enabledWhen', 'readOnly', 'visibleToRoles', 'validations']) {
        assert.ok(text.includes(flag), `node field ${flag} taught`);
    }
});

// ── Advanced sizing ─────────────────────────────────────────────────
//
// The four width/height knobs shipped through spec → canonicalize → validate →
// resolver → runtime → inspector while the AI catalog printed `spec.styleKnobs`
// verbatim — and they are in NO type's styleKnobs (availability is derived from
// `span`/`height` by expandStyleKnobs). So the whole feature was invisible to
// the builder: the same shape as the maths-family and node-logic gaps above.
// These tests pin the two halves of the fix — the knob line rendering the unit
// ranges, and one stated rule replacing 48 repeated per-type suffixes.

test('unitInt knobs render their range PER UNIT, derived from the spec', () => {
    const text = renderCatalogText();
    const unitKnobs = Object.entries(STYLE_KNOBS).filter(([, k]) => k.type === 'unitInt');
    assert.ok(unitKnobs.length >= 2, 'sanity: the spec still has the width/height value knobs');
    for (const [name, knob] of unitKnobs) {
        // The mode knob is named, because the legal window depends on it.
        assert.ok(text.includes(`${name}(int, by ${knob.modeKnob}:`), `${name} names its mode knob`);
        for (const [unit, range] of Object.entries(knob.units)) {
            assert.ok(
                text.includes(`${unit} ${range.min}..${range.max}`),
                `${name} teaches the ${unit} window ${range.min}..${range.max}`,
            );
        }
    }
});

test('the advanced-sizing block teaches the derived availability rule instead of repeating it per type', () => {
    const text = renderCatalogText();
    const block = text.slice(text.indexOf('Advanced sizing'), text.indexOf('### Screens'));
    assert.ok(block.length > 100, 'the block is present in the style-knobs section');
    // 1. Availability: derived from span / height, not listed per component.
    assert.match(block, /NOT listed per component/);
    assert.match(block, /WIDTH pair exactly when its `style:` line below includes `span`/);
    assert.match(block, /HEIGHT pair exactly when it includes `height`/);
    // 2. The placement/box split — without it, a model sets widthValue and
    //    deletes the span, and every sibling reflows.
    assert.match(block, /`span` still owns PLACEMENT/);
    assert.match(block, /sizes the painted box INSIDE that cell/);
    // 3. The defaults ARE today's behaviour (identity discipline, stated to the
    //    model as "omit these unless you mean them").
    for (const knob of ['widthMode', 'heightMode']) {
        assert.ok(block.includes(`${knob} "${STYLE_KNOBS[knob].default}"`), `${knob}'s default is named`);
    }
    // 4. Mobile: an exact width can never overflow a phone. A model that does
    //    not know this either avoids the feature or invents a workaround.
    assert.match(block, /max-width:100%/);
    assert.match(block, /640px/);
});

test('the catalog teaches the pct-height rule as an ERROR, per height ROUTE', () => {
    // A percentage height against an auto-height parent resolves to `auto` in
    // CSS — the knob silently does nothing. validate.js therefore rejects it
    // rather than emitting a dead declaration, so the catalog has to teach the
    // precondition, not just the value.
    //
    // This test used to assert the DEFINITE_HEIGHT_PRESETS list appeared
    // verbatim, i.e. "a parent with any of these heights takes a pct child".
    // That rule was too loose and the catalog was over-promising: a parent
    // HAVING a height and a parent PASSING IT DOWN are different questions.
    // The resolved height lands on the parent's grid CELL, and card/container
    // only thread it through their wrapper on the fill path — so pct under a
    // card at height "md" validated and then collapsed in the browser, which
    // is the exact failure the error code exists to prevent. validate.js now
    // asks containerPassesHeightDown, and the catalog must teach THAT.
    const text = renderCatalogText();
    const block = text.slice(text.indexOf('Advanced sizing'), text.indexOf('### Screens'));
    assert.match(block, /style\.height_pct_indefinite/, 'the error code the validator emits is named');
    assert.match(block, /PASSES ITS HEIGHT DOWN/, 'the distinction that makes the rule correct is stated');
    assert.match(block, /card` or `container` does ONLY when its own height is "fill"/, 'the card/container route is named');
    assert.match(block, /never do/, 'the containers that can never host a pct child are named');
    assert.match(block, /on a SECTION "pct" is never legal/i, 'the section ban is stated');
    assert.match(block, /use "vh" for a share of the viewport/, 'and the fix is given, not just the ban');
    assert.match(block, /"fill" is itself relative/, 'fill is not a free pass — it inherits its parent definiteness');
});

test('the advanced-sizing rule agrees with expandStyleKnobs for every component type', () => {
    // The catalog states ONE rule; expandStyleKnobs IS that rule. If someone
    // changes the derivation (say, gives `tabs` a height pair), the prompt
    // silently starts lying — this walks every type and fails when it does.
    const text = renderCatalogText();
    const lines = text.split('\n');
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
        const expanded = expandStyleKnobs(spec.styleKnobs);
        const hasWidthPair = ADVANCED_WIDTH_KNOBS.every((k) => expanded.includes(k));
        const hasHeightPair = ADVANCED_HEIGHT_KNOBS.every((k) => expanded.includes(k));
        assert.strictEqual(hasWidthPair, spec.styleKnobs.includes('span'), `${type}: width pair follows span`);
        assert.strictEqual(hasHeightPair, spec.styleKnobs.includes('height'), `${type}: height pair follows height`);
        // The rendered `style:` line is what the rule is applied TO, so it must
        // still be the RAW list — rendering the expanded one would make the
        // rule circular and cost ~1_500 chars of budget.
        const line = lines.find((l) => l === `  style: ${spec.styleKnobs.join(', ')}`
            || l.startsWith(`  style: ${spec.styleKnobs.join(', ')} (defaults`));
        assert.ok(line, `${type}: style line renders the base knob list the rule reads`);
    }
    // Sections earn the height pair the same way, from the same rule.
    assert.ok(expandStyleKnobs(SECTION_STYLE_KNOBS).includes('heightMode'), 'sections earn the height pair');
    assert.ok(text.includes(`Sections: style knobs ${SECTION_STYLE_KNOBS.join(', ')}`), 'and their line stays the base list too');
});

test('the validation types in the catalog are the ones the tool surface declares', () => {
    const { NODE_VALIDATION_TYPES } = require('../builderTools/schemas');
    const text = renderCatalogText();
    assert.ok(text.includes(NODE_VALIDATION_TYPES.join('|')), 'the whole rule vocabulary is rendered, derived');
    assert.ok(text.includes(`max ${LIMITS.MAX_VALIDATIONS_PER_FIELD} per component`), 'the cap is the spec\'s');
});

// ── The section refactor: the full text must not have moved a byte ──
//
// renderCatalogText() used to be one 180-line function; it now assembles
// from buildCatalogSections() so the compact form can share the builders.
// A refactor of a prompt-cached block is only a refactor if the bytes are
// the same — this is the digest of the text BEFORE the split (measured
// 2026-09-17, 50_760 chars). A deliberate catalog change updates it here:
// 2026-09-18, the generate_presentation step kind joined STEP_SPECS, with
// its look fields (preset/accent/font/coverStyle/tableStyle) — 51_434 chars.
// 2026-10-04, "routine" became "automation" throughout the catalog — 51_818 chars.
const FULL_CATALOG_SHA256_BEFORE_REFACTOR = 'e8af3d2e133fed8119c30b4e639094cd1dd4c9d2b7d8c9e86bc71fc98f5808e9';

test('renderCatalogText is byte-identical after the section refactor (stored digest)', () => {
    const text = renderCatalogText();
    const sha = crypto.createHash('sha256').update(text).digest('hex');
    if (sha !== FULL_CATALOG_SHA256_BEFORE_REFACTOR) {
        // Not a silent constant: a spec change legitimately moves the
        // digest, and the failure message says so — but a renderer change
        // that moves it is a prompt-cache invalidation for every cloud model.
        assert.fail(`the full catalog changed (sha256 ${sha}, ${text.length} chars). If componentSpecs/dataModel changed, update FULL_CATALOG_SHA256_BEFORE_REFACTOR; if only the renderer did, the refactor moved bytes.`);
    }
    const s = buildCatalogSections();
    for (const key of ['theme', 'design', 'knobs', 'advancedSizing', 'screen', 'components', 'nodeLogic', 'actions', 'steps', 'bindings', 'formulas', 'variables', 'dataModel', 'limits']) {
        assert.ok(typeof s[key] === 'string' && s[key].length, `section ${key} is a non-empty string`);
        assert.ok(text.includes(s[key]), `section ${key} is used verbatim by the full text`);
    }
});

// ── The compact catalog (small band) ───────────────────────────────

/**
 * The compact form exists to take the small band's system prompt from ~77k
 * to ~31k chars; the component section is where the bytes were. 24_000 is
 * the whole compact catalog (measured 22_875 at introduction), and unlike
 * the full ceiling it should only ever go DOWN: a line that grows here is
 * paid on every round of every local build.
 */
const COMPACT_CHAR_CEILING = 24_000;

test('renderCompactCatalogText is byte-stable across calls (prompt-cache discipline)', () => {
    const a = renderCompactCatalogText();
    const b = renderCompactCatalogText();
    assert.strictEqual(a, b);
    assert.ok(a.length > 5000, 'compact catalog is non-trivial');
    assert.ok(a.length < renderCatalogText().length / 2, 'and less than half the full catalog');
});

test(`prompt budget: compact catalog stays under ${COMPACT_CHAR_CEILING} chars`, () => {
    const text = renderCompactCatalogText();
    assert.ok(text.length < COMPACT_CHAR_CEILING, `compact catalog is ${text.length} chars — over the ${COMPACT_CHAR_CEILING} ceiling`);
});

test('every component type and every event name appears on its compact line', () => {
    const text = renderCompactCatalogText();
    const lines = text.split('\n');
    for (const type of COMPONENT_TYPES) {
        const line = lines.find((l) => l.startsWith(`${type} [`));
        assert.ok(line, `component ${type} has a compact line`);
        assert.strictEqual(line, renderComponentCompact(type), `${type}: the section line is the per-type renderer's output`);
        const spec = COMPONENT_SPECS[type];
        for (const ev of spec.events || []) assert.ok(line.includes(ev), `${type}: event ${ev} named on its line`);
        if (spec.container) assert.ok(line.includes('CONTAINER'), `${type}: container flag`);
        if (spec.isInput) assert.ok(/\] input\b/.test(line), `${type}: input flag`);
        // Every required prop is on the line, starred.
        for (const [k, fs] of Object.entries(spec.props || {})) {
            if (fs.required) assert.ok(line.includes(`${k}*:`), `${type}: required prop ${k} is on the line`);
        }
        // The style vocabulary is the type's own, so an illegal knob is never taught.
        const styleAt = line.lastIndexOf(' style: ');
        assert.ok(styleAt > 0, `${type}: style line present`);
        const knobs = line.slice(styleAt + ' style: '.length).split(',').map((k) => k.split('=')[0]);
        assert.deepStrictEqual(knobs, spec.styleKnobs, `${type}: style knobs are the spec's, in order`);
        assert.ok(line.length <= 420, `${type}: one line stays compact (${line.length} chars)`);
    }
});

test('list-item enums with ≤5 values render inline (filter_bar.fields.type), longer ones do not', () => {
    const line = renderComponentCompact('filter_bar');
    assert.ok(line.includes('fields:[{name*,label,type:search|select|toggle|date,options}]'), line);
    // data_grid.columns.format has 18 values: named, not enumerated.
    const grid = renderComponentCompact('data_grid');
    assert.ok(grid.includes('columns:[{key*,'), grid);
    assert.ok(!grid.includes('currency|'), 'an 18-value item enum is not spelled out on the line');
    // A top-level enum up to 7 values is spelled out (look), a longer one names its size.
    assert.ok(renderComponentCompact('card').includes('look:default|flat|raised|tinted|accent|gradient|solid'));
});

test('compact steps: the common kinds in full, the rest named once with the inspect pointer', () => {
    const text = renderCompactCatalogText();
    const section = text.slice(text.indexOf('\n### Sequence steps\n'), text.indexOf('### Bindings'));
    assert.strictEqual(COMPACT_STEP_KINDS.length, 17, 'seventeen common kinds');
    for (const kind of COMPACT_STEP_KINDS) {
        assert.ok(STEP_SPECS[kind], `${kind} is a real step kind`);
        assert.ok(new RegExp(`^${kind} \\[(client|SERVER)\\]: \\{`, 'm').test(section), `${kind} rendered in full`);
        assert.ok(section.includes(renderStepEntry(kind)), `${kind}: the compact line IS the full step line`);
    }
    const rest = STEP_KINDS.filter((k) => !COMPACT_STEP_KINDS.includes(k));
    assert.ok(rest.length > 0);
    const other = section.split('\n').find((l) => l.startsWith('Other step kinds'));
    assert.ok(other, 'the other kinds are named once');
    assert.ok(other.includes('app_inspect_catalog {steps:[…]}'), 'and the way to fetch them');
    for (const kind of rest) {
        assert.ok(other.includes(kind), `${kind} is named on the "other" line`);
        assert.ok(!new RegExp(`^${kind} \\[(client|SERVER)\\]:`, 'm').test(section), `${kind} is NOT rendered in full`);
    }
    // The kinds line still lists everything — a kind the model cannot see is one it will not use.
    for (const kind of STEP_KINDS) assert.ok(section.includes(kind), `${kind} listed`);
});

test('the compact catalog keeps the whole formula vocabulary and the core binding kinds, and drops the rest', () => {
    const text = renderCompactCatalogText();
    const formulas = text.slice(text.indexOf('### Formulas'), text.indexOf('### Data model'));
    for (const name of EXPR_FUNCTION_NAMES) assert.ok(formulas.includes(`${name}(`), `formula function ${name} present`);
    for (const f of EXPR_FUNCTIONS) assert.ok(formulas.includes(f.signature), `signature ${f.signature} verbatim`);
    for (const kind of ['static', 'actionResult', 'formula', 'record', 'records', 'aggregate']) {
        assert.ok(text.includes(`"kind": "${kind}"`), `binding kind ${kind} taught`);
    }
    // dataset needs app_upsert_dataset, connector needs app_list_connectors —
    // neither is on the core menu, so neither shape is taught.
    assert.ok(!text.includes('"kind": "dataset"'), 'dataset binding dropped');
    assert.ok(!text.includes('"kind": "connector"'), 'connector binding dropped');
    for (const gone of ['### Theme', '### Design', '### Variables', 'Advanced sizing —', 'app_set_variables', 'app_list_connectors', 'app_set_public_access', 'app_update_screen']) {
        assert.ok(!text.includes(gone), `${gone} is not in the compact catalog`);
    }
    // What replaced ### Variables: the one variable the core menu can use.
    assert.match(text, /vars\.filters\.<name>/);
    assert.match(text, /say so instead of inventing one/);
    // Style knobs: the exact-sizing pairs are out of the vocabulary line.
    const knobLine = text.split('\n')[1];
    for (const k of ['widthMode', 'widthValue', 'heightMode', 'heightValue']) assert.ok(!knobLine.includes(k), `${k} not in the compact knob vocabulary`);
    assert.ok(knobLine.includes('span(1..12)'));
    // The sections a small model needs verbatim.
    for (const key of ['dataModel', 'limits']) {
        assert.ok(text.includes(buildCatalogSections()[key]), `${key} section shared verbatim with the full catalog`);
    }
    // Actions: every kind listed; the twin rule stated once; the kinds with
    // fields of their own (run_automation, sequence, open_modal…) inline.
    const actions = text.slice(text.indexOf('### Actions'), text.indexOf('\n### Sequence steps\n'));
    for (const kind of ACTION_KINDS) assert.ok(actions.includes(kind), `action kind ${kind} listed`);
    assert.match(actions, /take exactly the fields of the step of the same name/);
    assert.match(actions, /^sequence: \{ steps/m);
    assert.match(actions, /^run_automation: \{ automationId/m);
    assert.ok(!actions.includes('…fields exactly as the'), 'no per-kind pointer lines (four of the twins are not rendered in the compact step list)');
    // Screens: only what the core app_add_screen declares.
    const screens = text.slice(text.indexOf('### Screens'), text.indexOf('### Components'));
    assert.match(screens, /name: string REQUIRED/);
    for (const gone of ['maxWidth', 'refreshInterval', 'Sections: style knobs']) assert.ok(!screens.includes(gone), `${gone} is not taught to a menu that cannot set it`);
    // It names ONLY tools on the core menu.
    const { APP_CORE_TOOL_NAMES } = require('../builderModelProfiles');
    const named = [...new Set(text.match(/\bapp_[a-z_]+/g) || [])];
    assert.deepStrictEqual(named.filter((t) => !APP_CORE_TOOL_NAMES.has(t)), [], 'no off-menu tool is named');
});

test('renderComponentEntry / renderStepEntry serve the full entry the compact line points at', () => {
    const full = renderCatalogText();
    assert.ok(full.includes(renderComponentEntry('data_grid')), 'the entry is the full catalog block');
    assert.match(renderComponentEntry('data_grid'), /^data_grid \[Data\]/);
    assert.match(renderComponentEntry('data_grid'), /\n  props: /);
    assert.match(renderComponentEntry('data_grid'), /\n  style: /);
    assert.strictEqual(renderComponentEntry('nope'), null);
    assert.ok(full.includes(renderStepEntry('request_approval')));
    assert.match(renderStepEntry('request_approval'), /^request_approval \[SERVER\]: \{/);
    assert.strictEqual(renderStepEntry('nope'), null);
});
