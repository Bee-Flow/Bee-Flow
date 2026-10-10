const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('./memory-extractor-sensitivity-2026-10');
const { loadPromptFile, REGISTRY_MAP } = require('../stores/agent/systemAgents');

// What a fresh install seeds, loaded the way seeding loads it.
const seeded = loadPromptFile(REGISTRY_MAP['system-memory-extractor'].promptFile);

test('a new install already gets the guidance: the seeded prompt is a fixed point', () => {
    assert.ok(seeded.includes(migration.HEADING));
    assert.strictEqual(migration.correctPrompt(seeded), seeded);
    assert.ok(seeded.includes('"sensitivity": "none|art9"'));
});

test('an existing prompt gets the section appended once, and operator edits stay', () => {
    const tuned = 'Operator-tuned prompt.\nOnly save things about cats.';
    const once = migration.correctPrompt(tuned);
    assert.ok(once.startsWith(tuned));
    assert.ok(once.includes('government ID numbers'));
    assert.ok(once.includes('absolute dates'));
    assert.strictEqual(migration.correctPrompt(once), once, 'idempotent');
});

test('the appended text is what the .md ends with', () => {
    assert.ok(seeded.endsWith(migration.SENSITIVITY_GUIDANCE.trim()));
});
