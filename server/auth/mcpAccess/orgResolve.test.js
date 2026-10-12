'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMcpOrgs, resolveMcpOrgId } = require('./orgResolve');

const GROUPS = [
    { id: 'g1', organizationId: 'orgA' },
    { id: 'g2', organizationId: 'orgB' },
    { id: 'g3', organizationId: 'orgA' },
    { id: 'g4' },
];
const deps = { getAllGroups: async () => GROUPS };

test('a home org comes first and is the primary', async () => {
    assert.deepEqual(await resolveMcpOrgs({ organizationId: 'home', groups: ['g1'] }, deps), { primary: 'home', all: ['home', 'orgA'] });
});

test('a member with no home org (the empty string) gets the org of their groups, in the order of their own list', async () => {
    assert.deepEqual(await resolveMcpOrgs({ organizationId: '', groups: ['g2', 'g1', 'g3'] }, deps), { primary: 'orgB', all: ['orgB', 'orgA'] });
    assert.equal(await resolveMcpOrgId({ organizationId: '', groups: ['g1'] }, deps), 'orgA');
});

test('groups given as a JSON string, unknown groups and groups without an org are skipped', async () => {
    assert.deepEqual(await resolveMcpOrgs({ organizationId: null, groups: '["nope","g4","g1"]' }, deps), { primary: 'orgA', all: ['orgA'] });
});

test('no org at all resolves to nothing, without reading the groups when there are none', async () => {
    let reads = 0;
    const counting = { getAllGroups: async () => { reads++; return GROUPS; } };
    assert.deepEqual(await resolveMcpOrgs({ organizationId: '', groups: [] }, counting), { primary: null, all: [] });
    assert.deepEqual(await resolveMcpOrgs(null, counting), { primary: null, all: [] });
    assert.equal(reads, 0);
});

test('a group read that fails throws: the caller must deny, not fall back to no org', async () => {
    await assert.rejects(resolveMcpOrgs({ organizationId: '', groups: ['g1'] }, { getAllGroups: async () => { throw new Error('db down'); } }), /db down/);
});
