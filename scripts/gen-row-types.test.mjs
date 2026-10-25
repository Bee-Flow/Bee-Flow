import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchema, render, tsType } from './gen-row-types.mjs';

const SQL = `
    CREATE TABLE IF NOT EXISTS widgets (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        size        INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
        total       BIGINT,
        price       NUMERIC(10, 2) NOT NULL,
        tags        TEXT[] NOT NULL DEFAULT '{}',
        config      JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        note        TEXT,
        a TEXT, b TEXT,
        PRIMARY KEY (id, a),
        UNIQUE (owner_id, b)
    );
    ALTER TABLE widgets ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT 'red';
    CREATE TABLE IF NOT EXISTS \${TABLE} (id TEXT);
`;

test('columns map to the types the pg driver returns, NOT NULL and the key drop the null', () => {
    const t = parseSchema([SQL]);
    const w = t.get('widgets');
    assert.deepEqual(w.get('id'), { ts: 'string', notNull: true });
    assert.deepEqual(w.get('owner_id'), { ts: 'string', notNull: true });
    assert.deepEqual(w.get('size'), { ts: 'number', notNull: true });
    assert.deepEqual(w.get('total'), { ts: 'string', notNull: false });
    assert.deepEqual(w.get('price'), { ts: 'string', notNull: true });
    assert.deepEqual(w.get('tags'), { ts: 'string[]', notNull: true });
    assert.deepEqual(w.get('config'), { ts: 'Json', notNull: false });
    assert.deepEqual(w.get('created_at'), { ts: 'Date', notNull: true });
    assert.deepEqual(w.get('a'), { ts: 'string', notNull: true }, 'part of a composite primary key');
    assert.deepEqual(w.get('b'), { ts: 'string', notNull: false });
    assert.deepEqual(w.get('color'), { ts: 'string', notNull: false }, 'from the ALTER');
    assert.deepEqual([...t.keys()], ['widgets'], 'a table named with a placeholder is skipped');
});

test('render writes one interface per table, columns sorted, in the DbRow namespace', () => {
    const out = render(parseSchema([SQL]));
    assert.match(out, /^\/\/ GENERATED/);
    assert.match(out, /declare namespace DbRow \{/);
    assert.match(out, /interface Widgets \{\n        a: string;\n        b: string \| null;/);
    assert.match(out, /created_at: Date;/);
});

test('tsType', () => {
    assert.equal(tsType('timestamp without time zone'), 'Date');
    assert.equal(tsType('integer[]'), 'number[]');
    assert.equal(tsType('bytea'), 'Buffer');
    assert.equal(tsType('geometry'), 'unknown');
});
