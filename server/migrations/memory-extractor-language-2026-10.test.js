const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = require('./memory-extractor-language-2026-10');

const seeded = fs.readFileSync(path.join(__dirname, '..', 'stores', 'agent', 'prompts', 'memory-extractor.md'), 'utf8');

test('a new install already gets the guidance: the seeded prompt is a fixed point', () => {
    assert.ok(seeded.includes(migration.HEADING));
    assert.strictEqual(migration.correctPrompt(seeded), seeded);
});

test('an existing prompt gets the guidance appended once, and its own text stays', () => {
    const tuned = 'Operator-tuned prompt.';
    const once = migration.correctPrompt(tuned);
    assert.ok(once.startsWith(tuned));
    assert.ok(once.includes('only when the\nuser says it must ALWAYS apply'));
    assert.strictEqual(migration.correctPrompt(once), once, 'idempotent');
});

test('the migration is registered, or it never runs', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'boot', 'bootMigrations.js'), 'utf8');
    assert.match(src, /'memory-extractor-language-2026-10'/);
});
