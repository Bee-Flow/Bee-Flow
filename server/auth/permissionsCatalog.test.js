// @typecheck strict
// The permission catalogue names admin_security the way the role editor does:
// it opens the Privacy Shield, sign-in, people and Access, not the shield
// alone, so neither copy calls it "Privacy Shield" any more.
const { test } = require('node:test');
const assert = require('node:assert/strict');
// Through auth/permissions, which wires the catalogue's dependencies (a split module alone throws).
const { SYSTEM_PERMISSIONS } = require('./permissions');

test('admin_security is labelled for everything it opens', () => {
    const entry = SYSTEM_PERMISSIONS.find((p) => p.id === 'admin_security');
    assert.ok(entry, 'admin_security is in the catalogue');
    assert.equal(entry.name, 'Security settings');
    assert.match(entry.description, /Privacy Shield/);
    assert.match(entry.description, /sign-in/);
});

test('every catalogue entry has an id, a name and a group, once', () => {
    const ids = SYSTEM_PERMISSIONS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of SYSTEM_PERMISSIONS) {
        assert.ok(p.id && p.name && p.group, `complete entry: ${p.id}`);
    }
});
