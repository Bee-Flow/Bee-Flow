/**
 * creationGate: the one question the skill-creating doors ask, and the
 * removal exemption on the /api/skills mount.
 *
 * Run: cd server && node --test core/skills/creationGate.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canCreateSkills, skillsLockedBody, exceptRemoval, SKILLS_LOCKED_MESSAGE } = require('./creationGate');
const { tagGate, readGate } = require('../../auth/gateMeta');

test('asks for the skills capability with the caller context it was given', async () => {
    const calls = [];
    const hasCapability = async (capId, ctx) => { calls.push({ capId, ctx }); return true; };
    const session = { user: { id: 'u1' } };
    const ok = await canCreateSkills({ userId: 'u1', orgId: 'o1', session }, { hasCapability });
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].capId, 'skills');
    assert.deepEqual(calls[0].ctx, { userId: 'u1', orgId: 'o1', session, req: null });
});

test('answers false when the capability is not granted', async () => {
    assert.equal(await canCreateSkills({ userId: 'u1', orgId: 'o1' }, { hasCapability: async () => false }), false);
});

test('fails closed when the resolver throws', async () => {
    const hasCapability = async () => { throw new Error('db down'); };
    assert.equal(await canCreateSkills({ userId: 'u1', orgId: 'o1' }, { hasCapability }), false);
});

test('only a real true grants: a truthy non-boolean is not a yes', async () => {
    assert.equal(await canCreateSkills({}, { hasCapability: async () => 'yes' }), false);
});

test('the refusal is readable and still machine-readable', () => {
    const body = skillsLockedBody();
    assert.equal(body.code, 'feature_locked');
    assert.equal(body.feature, 'skills');
    assert.equal(body.required, 'enterprise');
    // `error` is the sentence a client shows as-is, never the code.
    assert.equal(body.error, SKILLS_LOCKED_MESSAGE);
    assert.notEqual(body.error, 'feature_locked');
    assert.match(body.error, /Enterprise/);
    // No em dash in user-facing copy.
    assert.doesNotMatch(body.error, /—/);
});

test('each call returns a fresh body, so a caller cannot mutate the next one', () => {
    const a = skillsLockedBody();
    a.error = 'changed';
    assert.equal(skillsLockedBody().error, SKILLS_LOCKED_MESSAGE);
});

// ── exceptRemoval: the /api/skills mount ────────────────────────────

function run(gate, method, path) {
    return new Promise((resolve) => {
        const req = { method, path };
        const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ blocked: true, code: this.code, body: b }); } };
        gate(req, res, () => resolve({ blocked: false }));
    });
}

const lockedGate = () => tagGate((req, res) => res.status(403).json({ error: 'feature_locked' }),
    { axis: 'capability', id: 'skills', kind: 'beta', licenseFeature: 'skills' });

test('removing one skill passes without the capability', async () => {
    const gate = exceptRemoval(lockedGate());
    assert.deepEqual(await run(gate, 'DELETE', '/sk-1'), { blocked: false });
    assert.deepEqual(await run(gate, 'DELETE', '/sk-1/'), { blocked: false });
});

test('everything else under the mount still needs Skills, reading included', async () => {
    const gate = exceptRemoval(lockedGate());
    for (const [method, path] of [
        ['GET', '/'], ['GET', '/sk-1'], ['POST', '/'], ['PUT', '/sk-1'],
        ['POST', '/sk-1/test'], ['POST', '/ai/draft'],
        // A removal deeper in the tree is not a skill being removed.
        ['DELETE', '/sk-1/examples/e1'], ['DELETE', '/'],
    ]) {
        const out = await run(gate, method, path);
        assert.equal(out.blocked, true, `${method} ${path} must stay gated`);
        assert.equal(out.code, 403);
    }
});

test('a granted capability still lets everything through', async () => {
    const open = (req, res, next) => next();
    const gate = exceptRemoval(open);
    assert.deepEqual(await run(gate, 'POST', '/'), { blocked: false });
});

test('the wrapper keeps the capability tag for the route walk, plus the exemption', () => {
    const meta = readGate(exceptRemoval(lockedGate()));
    assert.equal(meta.axis, 'capability');
    assert.equal(meta.id, 'skills');
    assert.equal(meta.licenseFeature, 'skills');
    assert.equal(meta.exempt, 'DELETE /:id');
});
