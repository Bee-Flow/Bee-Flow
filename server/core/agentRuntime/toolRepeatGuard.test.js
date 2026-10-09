const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolRepeatGuard } = require('./toolRepeatGuard');

test('identical read-only call is a repeat, regardless of key order', () => {
    const g = createToolRepeatGuard({ readOnlyTools: ['search'] });
    assert.equal(g.isRepeat('search', { q: 'a', k: 1 }), false);
    assert.equal(g.isRepeat('search', { k: 1, q: 'a' }), true);
    assert.equal(g.isRepeat('search', { q: 'b', k: 1 }), false);
});

test('tools outside readOnlyTools are never a repeat', () => {
    const g = createToolRepeatGuard({ readOnlyTools: ['search'] });
    assert.equal(g.isRepeat('write', { x: 1 }), false);
    assert.equal(g.isRepeat('write', { x: 1 }), false);
});

test('filterNewChunks drops seeded and previously returned chunks', () => {
    const g = createToolRepeatGuard();
    g.seedChunks([{ chunk_id: 'a' }, { title: 'T', content: 'hello' }]);
    const out = g.filterNewChunks([
        { chunk_id: 'a' }, { title: 'T', content: 'hello' },
        { chunk_id: 'b' }, { chunk_id: 'b' },
    ]);
    assert.deepEqual(out, [{ chunk_id: 'b' }]);
    assert.deepEqual(g.filterNewChunks([{ chunk_id: 'b' }]), []);
});

test('chunk key falls back to title and the first 80 chars of content', () => {
    const g = createToolRepeatGuard();
    const long = 'x'.repeat(80);
    g.seedChunks([{ title: 'T', content: long + 'one' }]);
    assert.equal(g.filterNewChunks([{ title: 'T', content: long + 'two' }]).length, 0);
    assert.equal(g.filterNewChunks([{ title: 'U', content: long }]).length, 1);
});

test('forget lets a tool be called again', () => {
    const g = createToolRepeatGuard({ readOnlyTools: ['read'] });
    assert.equal(g.isRepeat('read', {}), false);
    g.forget('read');
    assert.equal(g.isRepeat('read', {}), false);
    assert.equal(g.isRepeat('read', {}), true);
});
