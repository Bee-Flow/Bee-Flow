'use strict';

/**
 * githubSyncService — skill.json round-trip (Bee Flow Builder redesign,
 * Sep 2026, Track S1).
 *
 * `skill.json` used to carry five keys, so a skill that went out to GitHub
 * and came back lost its sharing, its linked automation — and, after S1,
 * would lose its steps, its rule polarity, its worked examples and its
 * output schema. This pins the round-trip:
 *
 *   serializeSkillMeta(row)  →  JSON  →  deserializeSkillMeta(JSON)
 *
 * and the two shapes a row arrives in (a mapped camelCase row, and a raw
 * `SELECT *` snake_case row with JSONB already parsed or still a string).
 * A format-1 file — written before S1 — must yield NO structured keys, so
 * the store parses the .md text instead of overwriting a skill's structure
 * with empty arrays.
 *
 * DB-free: configStore and githubSyncStore are stubbed via the
 * Module._resolveFilename hook.
 *
 * Run: cd server && node --test --test-force-exit services/githubSyncService.skills.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const MOCKS = {
    '../stores/configStore': { getSecret: async () => null },
    '../stores/githubSyncStore': {},
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:gh-sync-skills:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /services[\\/]githubSyncService\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { serializeSkillMeta, deserializeSkillMeta, SKILL_META_FORMAT } = require('./githubSyncService');
test.after(() => { Module._resolveFilename = originalResolve; });

const OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        amount: { type: 'number', title: 'Amount', 'x-unit': 'EUR' },
        deliveredOn: { type: 'string', title: 'Delivered on', format: 'date' },
    },
    required: ['amount'],
};

/** A mapped row, as stores/skillStore.mapRow hands it over. */
const MAPPED = {
    id: 'sk1',
    name: 'Quote helper',
    description: 'Helps with quotes',
    icon: '⚡',
    isShared: true,
    dynamicActivation: true,
    sharedGroups: ['g1', 'g2'],
    automationId: 'au-legacy',
    enabledIntegrations: ['gmail'],
    version: 7,
    steps: [
        { id: 's1', text: 'Read the request', refs: [{ kind: 'kb', id: 'kb1' }] },
        { id: 's2', text: 'Look up the price', refs: [{ kind: 'table', id: 'tbl1' }] },
    ],
    rulesV2: [
        { id: 'r1', polarity: 'never', text: 'Never guess a price' },
        { id: 'r2', polarity: 'must', text: 'Always name the source' },
    ],
    examplesV2: [{ id: 'e1', question: 'How much?', good: 'EUR 120', rationale: 'From the price list', bad: 'About a hundred', violatedRuleId: 'r1' }],
    outputSchema: OUTPUT_SCHEMA,
    knowledgeBaseIds: ['kb1', 'kb2'],
    allowedAutomationIds: ['au1'],
    updatedAt: '2026-09-03T10:00:00.000Z',
};

test('a skill survives serialize → deserialize with its structure intact', () => {
    const back = deserializeSkillMeta(serializeSkillMeta(MAPPED));
    assert.deepStrictEqual(back.steps, MAPPED.steps, 'step references survive');
    assert.deepStrictEqual(back.rulesV2, MAPPED.rulesV2, 'rule polarity survives');
    assert.deepStrictEqual(back.examplesV2, MAPPED.examplesV2, 'the bad answer and the rule it violates survive');
    assert.deepStrictEqual(back.outputSchema, OUTPUT_SCHEMA, 'the output schema survives — 3a/3b read the fields from it');
    assert.deepStrictEqual(back.knowledgeBaseIds, ['kb1', 'kb2']);
    assert.deepStrictEqual(back.allowedAutomationIds, ['au1']);
    assert.strictEqual(back.version, 7);
    // …and the metadata that was silently dropped before S1.
    assert.strictEqual(back.dynamicActivation, true);
    assert.deepStrictEqual(back.sharedGroups, ['g1', 'g2']);
    assert.strictEqual(back.automationId, 'au-legacy');
    assert.deepStrictEqual(back.enabledIntegrations, ['gmail']);
    assert.strictEqual(back.isShared, true);
});

test('the file is stable JSON with a format stamp (a second export of an unchanged skill is not a commit)', () => {
    const a = serializeSkillMeta(MAPPED);
    assert.strictEqual(a, serializeSkillMeta(MAPPED));
    const parsed = JSON.parse(a);
    assert.strictEqual(parsed.format, SKILL_META_FORMAT);
    assert.ok(SKILL_META_FORMAT >= 2);
    // The .md files hold the human-readable text; the JSON holds structure.
    for (const k of ['workflow', 'instructions']) assert.ok(!(k in parsed), `${k} stays in its .md file`);
});

test('a raw SELECT * row serialises the same as its mapped form — parsed JSONB or still a string', () => {
    const raw = {
        id: 'sk1', name: 'Quote helper', description: 'Helps with quotes', icon: '⚡',
        is_shared: true, dynamic_activation: true,
        shared_groups: '["g1","g2"]',              // TEXT column, JSON inside
        automation_id: 'au-legacy',
        enabled_integrations: '["gmail"]',
        version: 7,
        steps: MAPPED.steps,                        // JSONB, already parsed by pg
        rules_v2: MAPPED.rulesV2,
        examples_v2: MAPPED.examplesV2,
        output_schema: JSON.stringify(OUTPUT_SCHEMA), // …or still a string
        knowledge_base_ids: ['kb1', 'kb2'],
        allowed_automation_ids: ['au1'],
        updated_at: '2026-09-03T10:00:00.000Z',
    };
    assert.strictEqual(serializeSkillMeta(raw), serializeSkillMeta(MAPPED));
});

test('an empty skill serialises to empty collections, never null or undefined', () => {
    const parsed = JSON.parse(serializeSkillMeta({ id: 'sk2', name: 'Empty', updatedAt: null }));
    assert.deepStrictEqual(parsed.steps, []);
    assert.deepStrictEqual(parsed.rules, []);
    assert.deepStrictEqual(parsed.examples, []);
    assert.deepStrictEqual(parsed.knowledgeBaseIds, []);
    assert.deepStrictEqual(parsed.allowedAutomationIds, []);
    assert.strictEqual(parsed.outputSchema, null, 'null = this skill yields no fields');
    assert.strictEqual(parsed.version, 1);
    assert.strictEqual(parsed.icon, '⚡');
});

test('a format-1 file yields NO structured keys, so importing it never blanks a skill\'s structure', () => {
    const legacy = { id: 'sk1', name: 'Quote helper', description: 'd', icon: '⚡', isShared: true, enabledIntegrations: [], updatedAt: '2026-01-01T00:00:00.000Z' };
    const back = deserializeSkillMeta(JSON.stringify(legacy));
    for (const k of ['steps', 'rulesV2', 'examplesV2', 'outputSchema', 'knowledgeBaseIds', 'allowedAutomationIds', 'version']) {
        assert.ok(!(k in back), `${k} absent → the store parses the .md text instead`);
    }
    assert.strictEqual(back.name, 'Quote helper');
    assert.strictEqual(back.isShared, true);
    assert.strictEqual(back.dynamicActivation, false);
});

test('deserialize accepts a parsed object as well as a string, and repairs a hand-edited file', () => {
    const fromObject = deserializeSkillMeta(JSON.parse(serializeSkillMeta(MAPPED)));
    assert.deepStrictEqual(fromObject.steps, MAPPED.steps);
    // Someone edited skill.json by hand and broke the types.
    const mangled = deserializeSkillMeta({ format: 2, id: 'sk1', name: 'x', steps: 'not an array', rules: null, outputSchema: 'nonsense', version: -3, sharedGroups: 'g1' });
    assert.deepStrictEqual(mangled.steps, []);
    assert.deepStrictEqual(mangled.rulesV2, []);
    assert.strictEqual(mangled.outputSchema, null);
    assert.strictEqual(mangled.version, 1);
    assert.deepStrictEqual(mangled.sharedGroups, []);
});
