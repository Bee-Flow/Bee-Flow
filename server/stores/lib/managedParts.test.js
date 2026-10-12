/**
 * The managed-write guard (stores/lib/managedParts.js), with its dependencies
 * injected: which project is a stage (cached and fresh) and which deployment
 * is active. No database, no module mocking.
 *
 * Pinned:
 *   - an unmanaged part is never refused;
 *   - an allow-listed change goes through without a capability; anything
 *     else needs an active deployment of exactly this stage project;
 *   - switching an automation on without a live copy needs the capability even
 *     though isActive is allow-listed (it would publish the working copy);
 *   - before refusing, the guard re-reads the stage uncached, so a detach
 *     elsewhere lets the write through;
 *   - the refusal is 409 managed_part with errorClass, expose and details;
 *   - changedKeysOf sees only the fields whose value differs.
 *
 * Run: cd server && node --test stores/lib/managedParts.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { makeManagedParts, changedKeysOf, managedPartError, storeError, ALLOWED } = require('./managedParts');

const STAGE = { solutionId: 'dev1', stage: 'prd', projectId: 'stage1' };

/** A guard over a fixed world; `calls` records what it asked. */
function guard({ cached = { stage1: STAGE }, fresh = { stage1: STAGE }, active = { dep_ok: 'stage1' }, kb = {} } = {}) {
    const calls = { fresh: 0, active: [] };
    const parts = makeManagedParts({
        stageOfProject: async (id) => cached[id] || null,
        stageOfProjectFresh: async (id) => { calls.fresh++; return fresh[id] || null; },
        isActiveDeployment: async (dep, projectId, client) => { calls.active.push([dep, projectId, client ?? null]); return active[dep] === projectId; },
        kbStageInfo: async (kbId) => kb[kbId] || null,
    });
    return { parts, calls };
}

const isManagedPart = (err) => {
    assert.strictEqual(err.status, 409);
    assert.strictEqual(err.code, 'managed_part');
    assert.strictEqual(err.errorClass, 'managed_part');
    assert.strictEqual(err.expose, true);
    assert.deepStrictEqual(err.details, { solutionId: 'dev1', stage: 'prd' });
    return true;
};

test('an unmanaged part is never refused and never re-read', async () => {
    const { parts, calls } = guard();
    assert.deepStrictEqual(await parts.assertManagedWrite({ kind: 'automation', projectId: 'other', changedKeys: ['definition'] }), { managed: false });
    assert.deepStrictEqual(await parts.assertManagedWrite({ kind: 'app', projectId: null, changedKeys: ['definition'] }), { managed: false });
    assert.strictEqual(calls.fresh, 0);
});

test('allow-listed keys pass on a managed part without a capability', async () => {
    const { parts, calls } = guard();
    assert.deepStrictEqual(
        await parts.assertManagedWrite({ kind: 'automation', projectId: 'stage1', changedKeys: ['isDraft', 'nextRunAt', 'folderId'], liveVersion: 4 }),
        { managed: true, via: 'allowlist' },
    );
    assert.deepStrictEqual(await parts.assertManagedWrite({ kind: 'datatable', projectId: 'stage1', changedKeys: ['retentionDays'] }),
        { managed: true, via: 'allowlist' });
    assert.deepStrictEqual(await parts.assertManagedWrite({ kind: 'automation', projectId: 'stage1', changedKeys: [] }),
        { managed: true, via: 'allowlist' });
    assert.strictEqual(calls.fresh, 0);
});

test('a change outside the allow-list is refused with 409 managed_part', async () => {
    const { parts, calls } = guard();
    await assert.rejects(parts.assertManagedWrite({ kind: 'automation', projectId: 'stage1', changedKeys: ['isDraft', 'definition'], liveVersion: 2 }), isManagedPart);
    await assert.rejects(parts.assertManagedWrite({ kind: 'agent', projectId: 'stage1', changedKeys: ['systemPrompt'] }), isManagedPart);
    await assert.rejects(parts.assertManagedWrite({ kind: 'project', projectId: 'stage1', changedKeys: ['knowledgeBaseIds'] }), isManagedPart);
    assert.strictEqual(calls.fresh, 3, 'every refusal re-read the stage first');
});

test('ownership is on no allow-list', () => {
    for (const keys of Object.values(ALLOWED)) {
        assert.ok(!keys.includes('ownerId') && !keys.includes('userId'));
    }
});

test("a deployment's capability lets any change through, only for its own stage and only while active", async () => {
    const { parts, calls } = guard({ active: { dep_ok: 'stage1', dep_other: 'stage2' } });
    const client = { query: async () => ({ rows: [] }) };
    assert.deepStrictEqual(
        await parts.assertManagedWrite({ kind: 'app', projectId: 'stage1', changedKeys: ['definition'], managedWrite: { deploymentId: 'dep_ok' }, client }),
        { managed: true, via: 'capability' },
    );
    // The capability check runs on the caller's client (the commit transaction).
    assert.deepStrictEqual(calls.active[0], ['dep_ok', 'stage1', client]);
    await assert.rejects(parts.assertManagedWrite({ kind: 'app', projectId: 'stage1', changedKeys: ['definition'], managedWrite: { deploymentId: 'dep_other' } }), isManagedPart);
    await assert.rejects(parts.assertManagedWrite({ kind: 'app', projectId: 'stage1', changedKeys: ['definition'], managedWrite: { deploymentId: 'dep_done' } }), isManagedPart);
    await assert.rejects(parts.assertManagedWrite({ kind: 'app', projectId: 'stage1', changedKeys: ['definition'], managedWrite: {} }), isManagedPart);
    assert.strictEqual(await parts.hasCapability({ managedWrite: null, projectId: 'stage1' }), false);
});

test('switching an automation on without a live copy needs the capability', async () => {
    const { parts } = guard();
    // With a value: isActive true and no live copy → refused.
    await assert.rejects(parts.assertManagedWrite({ kind: 'automation', projectId: 'stage1', changedKeys: { isActive: true, isDraft: false }, liveVersion: null }), isManagedPart);
    // Keys only (no values to read): counts as switching on.
    await assert.rejects(parts.assertManagedWrite({ kind: 'automation', projectId: 'stage1', changedKeys: ['isActive'], liveVersion: undefined }), isManagedPart);
    // Keys with their values: off is fine.
    assert.deepStrictEqual(
        await parts.assertManagedWrite({ kind: 'automation', projectId: 'stage1', changedKeys: ['isActive'], updates: { isActive: false }, liveVersion: null }),
        { managed: true, via: 'allowlist' },
    );
    // With a live copy, on is an allow-listed toggle.
    assert.deepStrictEqual(
        await parts.assertManagedWrite({ kind: 'automation', projectId: 'stage1', changedKeys: { isActive: true }, liveVersion: 3 }),
        { managed: true, via: 'allowlist' },
    );
    // And a deploy may do it.
    assert.deepStrictEqual(
        await parts.assertManagedWrite({ kind: 'automation', projectId: 'stage1', changedKeys: { isActive: true }, liveVersion: null, managedWrite: { deploymentId: 'dep_ok' } }),
        { managed: true, via: 'capability' },
    );
});

test('a refusal re-reads the stage uncached: a detach elsewhere lets the write through', async () => {
    // The cache still says stage; the fresh read says it was detached.
    const { parts, calls } = guard({ fresh: {} });
    assert.deepStrictEqual(
        await parts.assertManagedWrite({ kind: 'webpage', projectId: 'stage1', changedKeys: ['name'] }),
        { managed: true, via: 'detached' },
    );
    assert.strictEqual(calls.fresh, 1);
});

test('managedInfo and managedInfoForKb', async () => {
    const { parts } = guard({ kb: { kb1: { stageProjectId: 'stage1', ref: 'kb_1', contentMode: 'carry' }, kb2: { stageProjectId: 'gone', ref: null, contentMode: 'shell' } } });
    assert.deepStrictEqual(await parts.managedInfo('stage1'), { solutionId: 'dev1', stage: 'prd', stageProjectId: 'stage1' });
    assert.strictEqual(await parts.managedInfo('other'), null);
    assert.strictEqual(await parts.managedInfo(''), null);
    assert.deepStrictEqual(await parts.managedInfoForKb('kb1'),
        { solutionId: 'dev1', stage: 'prd', stageProjectId: 'stage1', ref: 'kb_1', contentMode: 'carry' });
    assert.strictEqual(await parts.managedInfoForKb('kb2'), null);
    assert.strictEqual(await parts.managedInfoForKb('kb3'), null);
    // Carry mode keeps only publish and audience.
    await assert.rejects(parts.assertManagedWrite({ kind: 'knowledge_base_carry', projectId: 'stage1', changedKeys: ['documents'] }), isManagedPart);
    assert.deepStrictEqual(await parts.assertManagedWrite({ kind: 'knowledge_base', projectId: 'stage1', changedKeys: ['documents'] }),
        { managed: true, via: 'allowlist' });
});

test('an unknown kind is a caller bug', async () => {
    const { parts } = guard();
    await assert.rejects(parts.assertManagedWrite({ kind: 'spreadsheet', projectId: 'stage1', changedKeys: [] }), TypeError);
});

test('changedKeysOf sees only the fields whose value differs', () => {
    const row = {
        name: 'Agent', description: null, system_prompt: 'Be brief', embed_enabled: false,
        shared_groups: ['g1', 'g2'], config: { a: 1, b: { c: 2 } }, updated_at: new Date('2026-10-01T00:00:00Z'), rev: 4,
    };
    const map = {
        name: 'name', description: 'description', systemPrompt: 'system_prompt', embedEnabled: 'embed_enabled',
        sharedGroups: { col: 'shared_groups', transform: (v) => JSON.stringify(v) }, config: 'config', rev: 'rev',
    };
    // The route sends every field: only what really changed counts.
    assert.deepStrictEqual(changedKeysOf(row, {
        name: 'Agent', description: '', systemPrompt: 'Be brief', embedEnabled: true,
        sharedGroups: ['g1', 'g2'], config: { b: { c: 2 }, a: 1 }, rev: '4', unknownKey: undefined,
    }, map), ['embedEnabled']);
    assert.deepStrictEqual(changedKeysOf(row, { systemPrompt: 'Be thorough', config: '{"a":1,"b":{"c":3}}' }, map), ['systemPrompt', 'config']);
    // A key without a column in the row counts as changed; without a map, keys are columns.
    assert.deepStrictEqual(changedKeysOf(row, { persona: 'x' }, map), ['persona']);
    assert.deepStrictEqual(changedKeysOf(row, { name: 'Agent', updated_at: '2026-10-01T00:00:00.000Z' }), []);
    assert.deepStrictEqual(changedKeysOf(null, { name: 'x' }), ['name']);
});

test('the error shapes', () => {
    const err = managedPartError({ solutionId: 's', stage: 'uat' });
    assert.ok(err instanceof Error);
    assert.match(err.message, /Change it in Dev and deploy/);
    assert.deepStrictEqual({ ...err }, { status: 409, code: 'managed_part', errorClass: 'managed_part', expose: true, details: { solutionId: 's', stage: 'uat' } });
    const other = storeError(400, 'x_bad', 'Bad');
    assert.deepStrictEqual({ ...other }, { status: 400, code: 'x_bad', errorClass: 'x_bad', expose: true });
});
