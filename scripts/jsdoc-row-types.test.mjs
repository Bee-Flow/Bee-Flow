import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRowTypes, run, tableFor } from './jsdoc-row-types.mjs';

const ROWS = `declare namespace DbRow {
    interface Tasks {
        created_at: Date;
        id: string;
        title: string | null;
        user_id: string;
    }
    interface TaskRuns {
        created_at: Date;
        id: string;
        task_id: string;
        title: string | null;
        user_id: string;
        status: string;
    }
}
`;

test('parseRowTypes reads interfaces and their columns', () => {
    const t = parseRowTypes(ROWS);
    assert.deepEqual([...t.keys()], ['Tasks', 'TaskRuns']);
    assert.deepEqual([...t.get('Tasks')].sort(), ['created_at', 'id', 'title', 'user_id']);
});

test('tableFor: all columns present, the smallest table wins, a tie or too few columns gives nothing', () => {
    const t = parseRowTypes(ROWS);
    assert.equal(tableFor(new Set(['id', 'title', 'user_id']), t), 'Tasks');
    assert.equal(tableFor(new Set(['id', 'status', 'task_id']), t), 'TaskRuns');
    assert.equal(tableFor(new Set(['id', 'title']), t), null, 'two columns say too little');
    assert.equal(tableFor(new Set(['id', 'title', 'nope']), t), null);
    assert.equal(tableFor(new Set(['id', 'a', 'b']), new Map([['X', new Set(['id', 'a', 'b'])], ['Y', new Set(['id', 'a', 'b'])]])), null);
});

function sandbox(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'row-types-'));
    mkdirSync(path.join(dir, 'types'));
    mkdirSync(path.join(dir, 'stores'));
    writeFileSync(path.join(dir, 'jsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'es2023', lib: ['es2023'], module: 'node20', moduleResolution: 'node16', allowJs: true, checkJs: true, noEmit: true, strict: false, types: [] },
        include: ['stores/*.js', 'types/*.d.ts'],
    }));
    writeFileSync(path.join(dir, 'types/rows.d.ts'), ROWS);
    for (const [n, t] of Object.entries(files)) writeFileSync(path.join(dir, n), t);
    return dir;
}

test('a mapper with a loose or missing row type gets the table type; null when it guards on the row', () => {
    const dir = sandbox({
        'stores/a.js': "/** @param {import('pg').QueryResultRow | null} r */\nfunction rowToTask(r) {\n    if (!r) return null;\n    return { id: r.id, user: r.user_id, title: r.title };\n}\nmodule.exports = { rowToTask };\n",
        'stores/b.js': 'function mapRow(row) {\n    return { id: row.id, user: row.user_id, title: row.title };\n}\nmodule.exports = { mapRow };\n',
        'stores/c.js': "/**\n * Maps a run.\n */\nfunction rowToRun(r) {\n    return { id: r.id, status: r.status, task: r.task_id };\n}\nmodule.exports = { rowToRun };\n",
        'stores/e.js': '/** Maps a row. */\nfunction mapRow(row) {\n    return { id: row.id, user: row.user_id, title: row.title };\n}\nmodule.exports = { mapRow };\n',
        'stores/d.js': '/** @param {{ id: string }} r */\nfunction rowToX(r) {\n    return { id: r.id, a: r.user_id, b: r.title };\n}\nmodule.exports = { rowToX };\n',
    });
    try {
        const files = ['a', 'b', 'c', 'd', 'e'].map((n) => path.join(dir, `stores/${n}.js`));
        const report = run({ files, write: true, serverDir: dir });
        const text = (n) => readFileSync(path.join(dir, `stores/${n}.js`), 'utf8');
        assert.match(text('a'), /@param \{DbRow\.Tasks \| null\} r/);
        assert.match(text('b'), /^\/\*\* @param \{DbRow\.Tasks\} row \*\/\nfunction mapRow/);
        assert.match(text('c'), /Maps a run\.\n \* @param \{DbRow\.TaskRuns\} r\n \*\/\nfunction rowToRun/);
        assert.match(text('d'), /@param \{\{ id: string \}\} r/, 'a typed parameter is left alone');
        assert.equal(text('e'), '/**\n * Maps a row.\n * @param {DbRow.Tasks} row\n */\nfunction mapRow(row) {\n    return { id: row.id, user: row.user_id, title: row.title };\n}\nmodule.exports = { mapRow };\n');
        assert.equal(report.reduce((n, r) => n + r.kept, 0), 4);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
