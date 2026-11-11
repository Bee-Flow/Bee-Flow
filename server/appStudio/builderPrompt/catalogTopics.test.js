// @typecheck
/**
 * The prompt diet: what left the cached builder prompt is served by app_inspect_catalog.
 *
 * For every fact that moved, one row here says "the base text points at X, and X contains the
 * fact": a rarely used component type or step kind is answered by name, everything else by a
 * topic (catalogTopics.mts). The same file holds the statements the prompt used to make two ways
 * (MAP 6.4), each pinned to the spec it speaks about.
 *
 * Run: node --test appStudio/builderPrompt/catalogTopics.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemPrompt } = require('../builderPrompt');
const { renderCatalogText, renderCompactCatalogText, renderComponentEntry, renderStepEntry, renderSpecFields, buildCatalogSections } = require('./catalogRender');
const { CATALOG_TOPIC_NAMES, renderTopic, isTopicName, describeTopics } = require('./catalogTopics.mts');
const { ON_REQUEST_TYPES, ON_REQUEST_STEP_KINDS, TOPIC_PREFIX, askTopic } = require('./catalogDiet.mts');
const { applyToolCall } = require('../builderTools');
const { COMPONENT_SPECS, STEP_SPECS, LIMITS, emptyDefinition } = require('../componentSpecs');
const { fullCatalogue } = require('../catalogTiers.mts');
const { APP_CORE_TOOL_NAMES } = require('../builderModelProfiles');

const wrap = () => ({ def: emptyDefinition('Topics') });
const inspect = (args) => applyToolCall('app_inspect_catalog', args, wrap());
const FULL = buildSystemPrompt({ ownerContext: 'note' });
const CORE = buildSystemPrompt({ toolset: 'core', catalogMode: 'filtered' });

// ── The topics themselves ────────────────────────────────────────────

test('a topic name can never be mistaken for a component type or a step kind', () => {
    const full = fullCatalogue();
    for (const name of CATALOG_TOPIC_NAMES) {
        assert.ok(!Object.hasOwn(full.COMPONENT_SPECS, name), `${name} is not a component type`);
        assert.ok(!full.STEP_KINDS.includes(name), `${name} is not a step kind`);
        assert.ok(typeof renderTopic(name) === 'string' && renderTopic(name).length > 50, `${name} has a text`);
        assert.ok(describeTopics().includes(`${name} (`), `${name} says what it holds`);
    }
    assert.strictEqual(renderTopic('nope'), null);
    assert.ok(isTopicName('topic:anything') && isTopicName('formulas') && !isTopicName('data_grid'));
});

test('app_inspect_catalog answers a topic from either name list, beside types and kinds, without using up their caps', async () => {
    const r = await inspect({ components: ['topic:formulas', 'sizing', 'list', 'topic:formulas'], steps: ['topic:sequences', 'transaction'] });
    assert.deepEqual(Object.keys(r.topics), ['formulas', 'sizing', 'sequences']);
    assert.strictEqual(r.topics.formulas, renderTopic('formulas'));
    assert.deepEqual(Object.keys(r.components), ['list']);
    assert.deepEqual(Object.keys(r.steps), ['transaction']);
    assert.strictEqual(r.unknown, undefined);
    // Eight types and every topic in one call: the topics do not count as types.
    const many = await inspect({ components: [...Object.keys(COMPONENT_SPECS).slice(0, 8), ...CATALOG_TOPIC_NAMES.map((n) => `${TOPIC_PREFIX}${n}`)] });
    assert.strictEqual(Object.keys(many.components).length, 8);
    assert.deepEqual(Object.keys(many.topics), [...CATALOG_TOPIC_NAMES]);
    assert.strictEqual(many.note, undefined);
});

test('a topic alone is a valid call, an unknown one is answered with the list, and a `topics` argument is read', async () => {
    const alone = await inspect({ components: ['topic:mail_apps'] });
    assert.strictEqual(alone.error, undefined);
    assert.deepEqual(Object.keys(alone), ['topics']);
    const unknown = await inspect({ steps: ['topic:colours'] });
    assert.strictEqual(unknown.error, undefined);
    assert.match(unknown.unknown[0], /^colours is not a topic \(topics: formulas, sizing, sequences, /);
    const byArg = await inspect({ topics: ['data_model', 'topic:limits'] });
    assert.deepEqual(Object.keys(byArg.topics), ['data_model', 'limits']);
    // Nothing asked at all still explains itself, and now names the topics.
    const empty = await inspect({});
    assert.match(empty.error, /Name at least one/);
    assert.match(empty._fixHint, /Topics, asked as "topic:<name>" in either list: formulas \(/);
});

// ── Every fact that left the base text ───────────────────────────────

/** @type {{ name: string, facts: string[] }[]} The topic the base text points at and the facts it must hold. */
const MOVED = [
    { name: 'formulas', facts: ['sin(radians)', 'atan2(y, x)', 'factorial(n)', 'padStart(text, length, char?)', 'regexMatch(text, "pattern", "flags"?)', 'groupSummary(group)',
        'no look-around or back-references', 'returns NOTHING, never NaN', 'x/0 is Infinity'] },
    { name: 'sizing', facts: ['A FIXED sidebar beside something that takes the remainder', '`span` still owns PLACEMENT', 'PASSES ITS HEIGHT DOWN', 'style.height_pct_indefinite',
        'max-width:100%', 'hideBelow "md" hides the component on viewports narrower than 1024px'] },
    { name: 'sequences', facts: [`transaction: ≤${LIMITS.MAX_TRANSACTION_STEPS} create/update/delete_record`, 'saved all or none', 'children carry no onError/retry',
        `≤${LIMITS.MAX_WRITE_FILTER_CLAUSES} clauses`, '{ matched, updated|deleted, remaining }', 'upsertKey: [column]', 'replaceWhere: [clause]'] },
    { name: 'actions', facts: ['never recursive', `≤${LIMITS.MAX_CALL_DEPTH} calls deep`, 'On a public page the called actions ship to the browser'] },
    { name: 'data_model', facts: ['computed.stored:true', 'text↔select, number↔text, integer↔text, integer↔number', 'onUnconvertible:"clear"', 'dryRun:true counts the values that cannot convert'] },
    { name: 'mail_apps', facts: ['attachmentMatchKey "provider_message_id"', 'inlineContentIdKey "content_id"', 'target "inbound_message"',
        'create_record, update_record, ai_generate, ai_extract, kb_query, dataset_query, file_intake, generate_file, fill_document, generate_presentation, redact_pdf', 'capped per sync and per minute'] },
    { name: 'documents', facts: ['set viewer "app" for the app\'s own PDF reader', 'textLayer true makes the text selectable', '`input_document` lets the user pick from the documentIds/folderId you list',
        'only left = its versions', '`copy_document` {source, templateDocumentId?, name?, resultVar}', 'list every document a dynamic binding may point at in a picker'] },
];

for (const { name, facts } of MOVED) {
    test(`the base text points at topic ${name}, and the topic holds what left it`, async () => {
        assert.ok(FULL.includes(askTopic(name)) || (FULL.includes(askTopic('<name>')) && new RegExp(`with [^\\n]*\\b${name}\\b`).test(FULL)), `the prompt names topic ${name} with the call that reads it`);
        const served = (await inspect({ components: [`${TOPIC_PREFIX}${name}`] })).topics[name];
        for (const fact of facts) {
            assert.ok(served.includes(fact), `topic ${name} holds: ${fact}`);
            assert.ok(!FULL.includes(fact), `and the base text no longer carries it: ${fact}`);
        }
    });
}

test('every topic the prompt asks for by name exists', () => {
    for (const text of [FULL, CORE, buildSystemPrompt({ catalogMode: 'filtered' })]) {
        const asked = [...text.matchAll(/topic:([a-z_]+)/g)].map((m) => m[1]);
        assert.ok(asked.length > 0);
        for (const name of asked) assert.ok(CATALOG_TOPIC_NAMES.includes(name), `topic:${name} is served`);
    }
    // The index line of the full catalogue names topics by bare word: each is one.
    const index = renderCatalogText().split('\n')[0];
    for (const name of ['formulas', 'sizing', 'sequences', 'actions', 'data_model', 'mail_apps', 'documents', 'theme', 'screens', 'node_logic', 'bindings', 'variables', 'limits']) {
        assert.ok(index.includes(name) && CATALOG_TOPIC_NAMES.includes(name), `${name} is in the index and served`);
    }
    assert.deepEqual([...CATALOG_TOPIC_NAMES].sort(), ['actions', 'bindings', 'data_model', 'design_example', 'documents', 'formulas', 'layout_dashboard', 'layout_form_wizard', 'layout_kanban_board', 'layout_landing', 'layout_list_detail', 'layout_report', 'layouts', 'limits', 'mail_apps', 'node_logic', 'screens', 'sequences', 'sizing', 'theme', 'variables']);
});

test('a rarely used component type is one summary line, and its full entry is served by name', async () => {
    const text = renderCatalogText();
    assert.match(text, /A type written on ONE line .* is a SUMMARY of a rarely used type: read its full entry with app_inspect_catalog \{components:\[…\]\} BEFORE you add it\./);
    assert.strictEqual(ON_REQUEST_TYPES.length, 17);
    for (const type of ON_REQUEST_TYPES) {
        const spec = COMPONENT_SPECS[type];
        assert.ok(spec, `${type} is a base type`);
        assert.ok(new RegExp(`^${type} \\[[A-Za-z]+\\][^\\n]* style: `, 'm').test(text), `${type} has its summary line`);
        assert.ok(!text.includes(`\n${type} [${spec.category}]`) || !text.includes(`\n${renderComponentEntry(type).split('\n')[1]}\n`), `${type}: no props line in the base text`);
        for (const [key, fs] of Object.entries(spec.props)) {
            assert.ok(renderComponentEntry(type).includes(`${key}: `), `${type}.${key} is in the served entry`);
            if (fs.description) assert.ok(!text.includes(fs.description), `${type}.${key}: its description left the base text`);
        }
    }
    // Eight per call (the tool's cap): three calls read them all, each with every prop.
    const served = {};
    for (let i = 0; i < ON_REQUEST_TYPES.length; i += 8) Object.assign(served, (await inspect({ components: ON_REQUEST_TYPES.slice(i, i + 8) })).components);
    assert.deepEqual(Object.keys(served), [...ON_REQUEST_TYPES]);
    for (const type of ON_REQUEST_TYPES) assert.strictEqual(served[type], renderComponentEntry(type));
    // Every other base type is in the base text whole. A since-3 type is not base vocabulary: the
    // extension index names it (catalogContract.test.js), as the since-3 step fields below.
    const baseTypes = Object.keys(COMPONENT_SPECS).filter((t) => !ON_REQUEST_TYPES.includes(t) && !(COMPONENT_SPECS[t].since >= 3));
    for (const type of baseTypes) {
        // Whole: its head line followed by its props or style line. The served entry may add since-3
        // props and events, so the base head is the served one's type and description.
        const head = renderComponentEntry(type).split('\n')[0];
        const lines = text.split('\n');
        const at = lines.findIndex((l) => l.startsWith(`${type} [${COMPONENT_SPECS[type].category}]`));
        assert.ok(at > 0 && lines[at + 1].startsWith('  '), `${type} rides whole`);
        assert.ok(head.endsWith(lines[at].slice(lines[at].lastIndexOf(' — '))), `${type}: the base head is the served one`);
    }
});

test('a rarely used step kind is named with its side, and its field list is served by name', async () => {
    const text = renderCatalogText();
    assert.strictEqual(ON_REQUEST_STEP_KINDS.length, 11);
    const served = {};
    for (let i = 0; i < ON_REQUEST_STEP_KINDS.length; i += 6) Object.assign(served, (await inspect({ steps: ON_REQUEST_STEP_KINDS.slice(i, i + 6) })).steps);
    for (const kind of ON_REQUEST_STEP_KINDS) {
        assert.ok(STEP_SPECS[kind], `${kind} is a base step kind`);
        assert.strictEqual(served[kind], renderStepEntry(kind));
        for (const [field, fs] of Object.entries(STEP_SPECS[kind].fields)) {
            if (!fs.envelope) assert.ok(served[kind].includes(`${field}: `), `${kind}.${field} is in the served entry`);
        }
        assert.ok(!text.includes(served[kind]), `${kind}: the field list left the base text`);
    }
    for (const kind of Object.keys(STEP_SPECS).filter((k) => !ON_REQUEST_STEP_KINDS.includes(k) && fullCatalogue().STEP_KINDS.includes(k) && renderCatalogText().includes(`\n${k} [`))) {
        // Whole: the base line is the served entry without the fields marked since 3.
        const served = renderStepEntry(kind);
        const baseFields = Object.fromEntries(Object.entries(STEP_SPECS[kind].fields).filter(([, fs]) => !(fs.since >= 3)));
        assert.ok(text.includes(`\n${served.slice(0, served.indexOf(': {'))}: { ${renderSpecFields(baseFields)} }`), `${kind} rides whole`);
    }
    // The envelope every server step may carry stays in the base text; the prompt's pitfalls point at it.
    assert.match(text, /\[SERVER\] steps and call_action may carry onError: \{ steps, stop\?: true \}/);
    assert.match(FULL, /A server STEP inside it may carry onError \{steps\} \/ retry \(see\n? *### Sequence steps\)/);
});

test('the small band keeps every capability: what its catalogue stopped spelling out is one inspect call away, with tools it has', async () => {
    const compact = renderCompactCatalogText();
    assert.ok(APP_CORE_TOOL_NAMES.has('app_inspect_catalog'));
    // The AI action kinds are twins of steps the compact list only names: the pointer says how to read them.
    for (const kind of ['ai_extract', 'ai_generate', 'kb_query', 'send_email', 'call_action']) {
        assert.ok(compact.split('\n').find((l) => l.startsWith('Other step kinds')).includes(kind), `${kind} is named`);
        assert.ok((await inspect({ steps: [kind] })).steps[kind].startsWith(`${kind} [`));
    }
    // The topics the core prompt asks for name no tool off its menu.
    const asked = [...new Set([...CORE.matchAll(/topic:([a-z_]+)/g)].map((m) => m[1]))];
    assert.deepEqual(asked.sort(), ['data_model', 'formulas']);
    for (const name of asked) {
        const tools = renderTopic(name).match(/\bapp_[a-z_]+/g) || [];
        assert.deepEqual(tools.filter((t) => !APP_CORE_TOOL_NAMES.has(t)), [], `topic ${name} names only tools on the core menu`);
    }
});

// ── The statements the prompt used to make two ways (MAP 6.4) ────────

test('one story on escape hatches: catalog first, no blanket "no CSS" claim beside an extension tier', () => {
    assert.ok(!FULL.includes('There is no HTML, CSS or JavaScript here'));
    assert.match(FULL, /CATALOG FIRST: compose from the catalog's components, looks and style knobs/);
    assert.match(FULL, /escape hatches where the catalog's Extensions list names them: read that entry with app_inspect_catalog before you reach for one/);
    // The small band has no extension tier, so for it the sentence is still true.
    assert.ok(CORE.includes('There is no HTML, CSS or JavaScript here'));
    assert.ok(!CORE.includes('### Extensions'));
});

test('no heading claims the list above the extension index is everything', () => {
    for (const text of [FULL, buildSystemPrompt({ catalogMode: 'filtered' })]) {
        assert.ok(!text.includes('the ONLY legal types'));
        assert.ok(!text.includes('the only legal style keys'));
        assert.ok(!text.includes('the ONLY component types'));
        assert.match(text, /## Catalog \(the component types, props, style knobs and action kinds you build with; nothing exists outside it and the Extensions list that may follow it\)/);
    }
});

test('effects: action-level effects are run_automation\'s, and a step\'s onError is said to be a different thing', () => {
    for (const text of [FULL, CORE]) {
        assert.ok(!text.includes('Effects (onSuccess/onError) exist on run_automation only'));
        assert.match(text, /ACTION-level effects \(onSuccess\/onError\) exist on run_automation only/);
        assert.match(text, /a server STEP[^.]*own onError[^.]*different thing/);
    }
});

test('looks are described the way they draw', () => {
    // style.background "panel" is a raised band (styleResolver/box.ts: card colour plus shadow).
    assert.match(renderCatalogText(), /^background: .*panel = a RAISED band \(card colour plus shadow\)/m);
    // Only the container LOOK is recessed (AppContainer.tsx), and only its own entry says so.
    assert.strictEqual(FULL.split('recessed').length - 1, 1);
    assert.match(renderComponentEntry('container'), /panel = recessed grouping surface/);
    // page_header look "split" draws title left, subtitle right, a hairline (AppPageHeader.tsx SplitHeader); no panel.
    assert.match(COMPONENT_SPECS.page_header.props.look.description, /split = title left, subtitle right-aligned and muted, a hairline below\./);
    assert.ok(!FULL.includes('actions right on a panel surface'));
});

test('a list inside a list shows its item keys', () => {
    const nested = [];
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
        for (const [key, fs] of Object.entries(spec.props)) {
            for (const [itemKey, item] of Object.entries(fs.itemShape || {})) {
                if (item.type !== 'list' || !item.itemShape) continue;
                nested.push(`${type}.${key}.${itemKey}`);
                const shape = `${itemKey}:[{${Object.entries(item.itemShape).map(([k, s]) => `${k}${s.required ? '!' : ''}`).join(', ')}}]`;
                assert.ok(renderComponentEntry(type).includes(shape), `${type}.${key}: ${shape}`);
                assert.ok(!renderComponentEntry(type).includes(`${itemKey}:list`), `${type}.${key}.${itemKey} is not a bare "list"`);
            }
        }
    }
    assert.ok(nested.includes('data_grid.columns.toneMap') && nested.length >= 3);
    assert.ok(renderCatalogText().includes('toneMap:[{value!, label, tone}]'));
    assert.ok(buildCatalogSections().components.includes('options:[{value!, label}]'));
});
