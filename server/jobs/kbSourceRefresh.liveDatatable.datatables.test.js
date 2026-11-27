/**
 * "Live", the datatables half: the write path that calls the hook
 * (jobs/kbSourceRefresh.js onDatatableChanged) is datatableStore's, which is the
 * datatables module's. The hook and the backstop are kbSourceRefresh.liveDatatable.test.js.
 *
 * Run: cd server && node --test jobs/kbSourceRefresh.liveDatatable.datatables.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ../stores/datatableStore has, since the split, been a FACADE with its parts in stores/datatableStore/.
// The assertions below are about the CALLER, so read the whole module as one text — reading only the facade
// would empty every slice and make these file assertions silently green.
function datatableStoreSource() {
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const facade = require.resolve('../stores/datatableStore');
    const dir = facade.replace(/\.js$/, '');
    const parts = fs.readdirSync(dir)
        .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map(f => fs.readFileSync(nodePath.join(dir, f), 'utf8'));
    return [...parts, fs.readFileSync(facade, 'utf8')].join('\n');
}

test('the write path debounces, so 400 row writes are one pass', async () => {
    // Not a claim about this function — about the caller. datatableStore holds
    // one timer per table and drops every bump inside it.
    const src = datatableStoreSource();
    // To the END of the function, not n characters along: the body grows (since W3 step 4 a second listener
    // hangs on the same notification) and a fixed window would then miss something that is there.
    const start = src.indexOf('function notifyDatatableChanged');
    const end = src.indexOf('\n}', start);
    const fn = src.slice(start, end);
    assert.match(fn, /_liveTimers\.has\(datatableId\)\) return/, 'a bump inside a pending window is dropped');
    assert.match(fn, /unref/, 'and a pending refresh never holds the process open');
});

test('both write paths notify, including the retention sweep', () => {
    // The sweep matters MORE than an ordinary write: rows it removed are rows
    // a knowledge base must stop answering from, and a purge that leaves its
    // copies searchable has not purged anything.
    const src = datatableStoreSource();
    const bump = src.slice(src.indexOf('async function bumpAfterWrite'), src.indexOf('async function bumpAfterWrite') + 800);
    const setCount = src.slice(src.indexOf('async function setRowCount'), src.indexOf('async function setRowCount') + 800);
    assert.match(bump, /notifyDatatableChanged\(id\)/);
    assert.match(setCount, /notifyDatatableChanged\(id\)/);
});
