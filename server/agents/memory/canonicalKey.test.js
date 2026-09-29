/**
 * The canonical key `(type, subject, attribute)`.
 *
 * THE BUG THIS PINS: the surviving extractor declared
 * `subject: { enum: ["user", "project", "agent"] }`. `createMemory` dedupes and
 * SUPERSEDES on that key, so with only three possible subjects every person's
 * role collapses to `(person, 'user', 'role')` — and the second colleague the
 * assistant learns about silently replaces the first. Not weak dedupe: data
 * loss, with no error and nothing in the UI to show it happened.
 *
 * Free text is what the system was designed for: subjects read like "Tom Smit",
 * "Theodorus van der Brug", "Dekker Techniek" (fictional examples). Subjects of
 * that kind came from the SECOND extractor, the one that was retired when the
 * two pipelines were merged into one; consolidating onto the stricter schema
 * would have quietly ended that.
 *
 * These used to be static assertions against extractor.js's and the prompt
 * file's raw text. That pins the shape of the code, not what it does: it goes
 * red on a harmless reformat and stays green if the shipped schema drifts from
 * the string a regex happens to match elsewhere in the file. Below, the
 * extraction call actually runs (with its LLM call stubbed) and the JSON
 * schema it hands the model is asserted on directly; the seeded prompt is
 * read through the real seeding path instead of a second `readFileSync`.
 *
 * Run: cd server && node --test agents/memory/canonicalKey.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

let capturedResponseFormat = null;
let seededPrompt = null;

before(async () => {
    // ── The extraction schema actually sent to the model ────────────────
    const restoreExtractorStubs = installResolveStub({
        '../../stores/memoryStore': {
            findByKey: async () => null,
            findSimilarMemory: async () => null,
            createMemory: async () => 'mem_1',
            updateMemoryValue: async () => {},
            confirmMemory: async () => {},
            addMemorySource: async () => {},
        },
        '../../stores/agentStore': {
            getAgent: async () => null,
            getSystemAgent: async () => ({ system_prompt: 'stub prompt', model: 'tier:fast', config: {} }),
        },
        '../../core/memory/extractionModel': {
            resolveMemoryExtractionModel: async () => 'stub-model',
            EXTRACTION_CHAT_OPTIONS: {},
            EXTRACTION_MAX_CHARS: { user: 8000, assistant: 4000 },
        },
        '../../core/llm/llmClient': {
            chat: async (_model, _messages, opts) => {
                capturedResponseFormat = opts.responseFormat;
                return { content: '{"memories":[]}' };
            },
        },
    });
    const { extractFromConversation } = require('./extractor');
    await extractFromConversation('usr_canonical_key_test', null, [
        { role: 'user', content: 'Please remember that my role here is backend engineer.' },
    ]);
    restoreExtractorStubs();
    assert.ok(capturedResponseFormat, 'extractFromConversation never reached the model call — cannot assert on its schema');

    // ── The prompt seeded into new installs ──────────────────────────────
    const seedInserts = [];
    const restoreSeedStubs = installResolveStub({
        '../../db': {
            getOne: async () => null, // nothing exists yet -> every registry entry takes the insert path
            run: async (sql, params) => { seedInserts.push({ sql, params }); },
        },
        './initSchema': { initDB: async () => {} },
    });
    const { seedSystemAgents } = require('../../stores/agent/systemAgents');
    await seedSystemAgents();
    restoreSeedStubs();

    const insert = seedInserts.find((i) => i.params[0] === 'system-memory-extractor');
    assert.ok(insert, 'seedSystemAgents never inserted the memory-extractor agent');
    seededPrompt = insert.params[3]; // INSERT ... (id, name, description, system_prompt, model) VALUES ($1..$5, ...)
});

// ── The schema ───────────────────────────────────────────────────────

test('subject is free text, not an enum', () => {
    const subject = capturedResponseFormat.json_schema.schema.properties.memories.items.properties.subject;
    assert.ok(
        !('enum' in subject),
        'subject must not be an enum — it is half of the canonical key, and restricting it '
        + 'makes every person share one key',
    );
});

test('subject still tells the model what canonical form means', () => {
    // A free-text field with no guidance is its own failure mode: "my boss",
    // "he", "Tom" and "Tom Smit" would each fork the key.
    const subject = capturedResponseFormat.json_schema.schema.properties.memories.items.properties.subject;
    assert.ok(/canonical/i.test(subject.description || ''), 'subject needs a description that explains canonical form');
});

test('the type enum covers every type the rest of the system renders', () => {
    // typeScores, formatMemoriesForPrompt and the Manage UI all understand
    // seven. A narrower enum here means four of them can never be produced.
    const { enum: types } = capturedResponseFormat.json_schema.schema.properties.memories.items.properties.type;
    for (const type of ['fact', 'preference', 'instruction', 'person', 'project', 'workflow', 'context']) {
        assert.ok(types.includes(type), `type "${type}" missing from the schema actually sent to the model`);
    }
});

// ── The prompt that ships with it ────────────────────────────────────

test('the seeded prompt no longer documents the three-value subject', () => {
    // The schema and the prompt are sent in the same request. A prompt saying
    // `"subject": "user|project|agent"` actively fights a free-text schema.
    assert.ok(
        !seededPrompt.includes('"subject": "user|project|agent"'),
        'the prompt still documents the enum the schema dropped',
    );
});

test('the seeded prompt documents all seven types', () => {
    assert.ok(seededPrompt.includes('person|project|workflow|context'));
});

test('the seeded prompt explains that the key is a key', () => {
    assert.ok(seededPrompt.includes('## The canonical key'));
    // The consequence, stated plainly — this is the part that stops the model
    // reusing one subject for two people.
    assert.ok(/replace/i.test(seededPrompt));
});

// ── The migration that carries it to existing installs ───────────────

// migration.js destructures `getOne`/`run` from '../db' exactly once, at its
// own first require — install the stub before that happens, then drive it
// per-test through these two mutable slots instead of re-requiring the
// module (Node's module cache makes a second require-with-different-stub
// unreliable within one process).
let dbRow = null;
let dbUpdate = null;
const restoreMigrationDbStub = installResolveStub({
    '../db': {
        getOne: async () => dbRow,
        run: async (sql, params) => { dbUpdate = { sql, params }; },
    },
});
const migration = require('../../migrations/memory-extractor-prompt-2026-08');
// migration.js has now captured our stub functions by reference (the
// destructuring happened during the require() above) — safe to restore the
// global resolve hook immediately so it cannot leak into other files' requires.
restoreMigrationDbStub();
const { REGISTRY_MAP } = require('../../stores/agent/systemAgentRegistry');

test('a migration exists, because the prompt file alone never reaches one', () => {
    // `system-memory-extractor` is registered with `alwaysUpdate: false`, so
    // seedSystemAgents writes the prompt exactly once, at row creation.
    // Editing the .md fixes new installs and nothing else.
    assert.strictEqual(
        REGISTRY_MAP['system-memory-extractor'].alwaysUpdate, false,
        'if this became true, the migration is redundant — but so is every operator edit',
    );
    assert.strictEqual(typeof migration.up, 'function');
    assert.ok(migration.REPLACEMENTS.some(([stale]) => stale.includes('user|project|agent')));
});

test('the migration is a fixed point on the prompt actually shipped today', () => {
    // The docblock promises the seeded .md file is kept equal to the output
    // of correctPrompt(); if it ever drifts, this is the assertion that
    // notices, because it runs the real correction against the real content.
    assert.strictEqual(migration.correctPrompt(seededPrompt), seededPrompt);
});

test('the migration replaces only the two exact stale lines, preserving anything else in the row', async () => {
    // Also exercise the DB-facing up(), not just the pure correctPrompt()
    // helper — up() has its own copy of the replacement loop.
    dbRow = {
        id: migration.AGENT_ID,
        system_prompt: [
            'Custom operator preamble that must survive.',
            '"subject": "user|project|agent",',
            '"type": "fact|preference|instruction",',
            'Custom operator epilogue that must survive.',
        ].join('\n'),
    };
    dbUpdate = null;

    await migration.up();

    assert.ok(dbUpdate, 'up() must write the correction back for a stale row');
    const [updatedPrompt, agentId] = dbUpdate.params;
    assert.strictEqual(agentId, migration.AGENT_ID);
    assert.ok(updatedPrompt.includes('Custom operator preamble that must survive.'), 'must not overwrite the row wholesale');
    assert.ok(updatedPrompt.includes('Custom operator epilogue that must survive.'), 'must not overwrite the row wholesale');
    assert.ok(!updatedPrompt.includes('"subject": "user|project|agent"'));
    assert.ok(!updatedPrompt.includes('"type": "fact|preference|instruction",'));
    assert.ok(updatedPrompt.includes('## The canonical key'));
});

test('the migration is idempotent: a row it already corrected produces no second write', async () => {
    dbRow = { id: migration.AGENT_ID, system_prompt: seededPrompt };
    dbUpdate = null;

    await migration.up();

    assert.strictEqual(dbUpdate, null, 'nothing stale left, so up() must not write again');
});

test('an operator who already rewrote the stale lines away keeps their own text untouched', () => {
    // This prompt is operator-editable in the admin UI. A migration that
    // pattern-matches exact stale lines must be a no-op once they are gone,
    // even though the row is otherwise nothing like the seeded file.
    const edited = [
        'This admin wrote a fully custom extraction prompt.',
        'Subjects and types follow this org\'s own vocabulary.',
        '',
        '## The canonical key',
        '',
        'Already explains replace semantics in this org\'s own words.',
    ].join('\n');
    assert.strictEqual(migration.correctPrompt(edited), edited, 'nothing stale to fix, nothing should change');
});
