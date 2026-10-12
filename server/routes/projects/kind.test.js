'use strict';

/**
 * PUT /api/projects/:id/kind (routes/projects/kind.js), served with injected
 * fakes behind a real express app and the real terminal error handler — no
 * module mocking. The role fake answers like auth/projectAccess: 401 without
 * a session, 404 for a non-member, 403 for a role that is too low.
 *
 * Proven:
 *   - the owner classifies a legacy project once; a second attempt is 409
 *     KIND_ALREADY_SET and changes nothing;
 *   - a kind the backfill only GUESSED is the owner's to correct, once (a
 *     legacy project full of chats that the backfill made a Solution can be
 *     brought back to the Projects page);
 *   - a project that holds items the target refuses is refused with 409
 *     KIND_HOLDS_OTHER_CONTENT and the counts per section, and nothing is
 *     written or announced: an app filed in it would otherwise stay readable
 *     to every member of the new workspace with no screen listing it;
 *   - only the owner: an editor 403, a stranger 404, no session 401;
 *   - a closed schema; a project that vanished is a 404; a race lost to
 *     another tab is a 409.
 *
 * Run: cd server && node --test routes/projects/kind.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { makeKindRouter } = require('./kind');

const OWNER = { id: 'alice', organizationId: 'org1' };
const EDITOR = { id: 'bob', organizationId: 'org1' };
const STRANGER = { id: 'carol', organizationId: 'org1' };
const ROLES = { alice: 'owner', bob: 'editor' };
const ORDER = { viewer: 0, editor: 1, owner: 2 };

const fx = { projects: {}, held: {}, checked: [], written: [], recorded: [], loseRace: false, deleteOnCheck: false };
function reset() {
    fx.projects = {
        legacy: { id: 'legacy', name: 'Legacy', kind: null, kindGuessed: false },
        guessed: { id: 'guessed', name: 'Team', kind: 'solution', kindGuessed: true },
        decided: { id: 'decided', name: 'Decided', kind: 'workspace', kindGuessed: false },
    };
    fx.held = {};
    fx.checked.length = 0;
    fx.written.length = 0;
    fx.recorded.length = 0;
    fx.loseRace = false;
    fx.deleteOnCheck = false;
}

const router = makeKindRouter({
    requireProjectRole: (minRole) => function requireProjectRoleMw(req, res, next) {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const role = fx.projects[req.params.id] ? ROLES[userId] : null;
        if (!role) return res.status(404).json({ error: 'Not found' });
        if (ORDER[role] < ORDER[minRole]) return res.status(403).json({ error: 'Insufficient permissions' });
        req.projectRole = role;
        return next();
    },
    store: {
        async getProject(id) { return fx.projects[id] ? { ...fx.projects[id] } : null; },
        async setProjectKind(id, kind) {
            fx.written.push([id, kind]);
            const p = fx.projects[id];
            if (!p || fx.loseRace || (p.kind !== null && !p.kindGuessed)) return null;
            Object.assign(p, { kind, kindGuessed: false });
            return { ...p };
        },
    },
    kindChange: {
        async refusedContent(project, kind) {
            fx.checked.push([project.id, kind]);
            // Deleted by its owner in another tab, right after this check.
            if (fx.deleteOnCheck) delete fx.projects[project.id];
            return fx.held[kind] || {};
        },
    },
    recordProjectChange: async (projectId, actorId, action, details) => { fx.recorded.push([projectId, actorId, action, details]); },
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    req.session = who && who !== 'none' ? { user: JSON.parse(who) } : {};
    next();
});
app.use('/api/projects', router);
app.use(terminalErrorHandler);
const server = http.createServer(app);
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
test.beforeEach(reset);

async function put(id, body, user = OWNER) {
    await ready;
    const headers = { 'content-type': 'application/json', 'x-test-user': user === null ? 'none' : JSON.stringify(user) };
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${id}/kind`, {
        method: 'PUT', headers, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test('the owner classifies a legacy project once; a second attempt is a 409', async () => {
    const first = await put('legacy', { kind: 'workspace' });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.kind, 'workspace');
    assert.deepStrictEqual(fx.checked, [['legacy', 'workspace']], 'what it holds was checked first');
    assert.deepStrictEqual(fx.recorded, [['legacy', 'alice', 'kind_set', { kind: 'workspace' }]]);

    const again = await put('legacy', { kind: 'solution' });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, 'KIND_ALREADY_SET');
    assert.deepStrictEqual(again.body.details, { kind: 'workspace' });
    assert.strictEqual(fx.projects.legacy.kind, 'workspace', 'unchanged');
    assert.strictEqual(fx.recorded.length, 1);
});

test('a kind the backfill guessed is the owner\'s to correct, once', async () => {
    const corrected = await put('guessed', { kind: 'workspace' });
    assert.strictEqual(corrected.status, 200, JSON.stringify(corrected.body));
    assert.strictEqual(corrected.body.kind, 'workspace');
    assert.strictEqual(corrected.body.kindGuessed, false);

    const back = await put('guessed', { kind: 'solution' });
    assert.strictEqual(back.status, 409);
    assert.strictEqual(back.body.code, 'KIND_ALREADY_SET');
    assert.deepStrictEqual(fx.checked, [['guessed', 'workspace']], 'the refused second change reads nothing');
});

test('an owner\'s own choice is never re-opened', async () => {
    const res = await put('decided', { kind: 'solution' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'KIND_ALREADY_SET');
    assert.deepStrictEqual(fx.checked, []);
    assert.deepStrictEqual(fx.written, []);
});

test('a project holding items the target refuses is refused, with the counts, and nothing changes', async () => {
    // A legacy project with a published app and an automation in it: as a
    // workspace it would hide them from every screen while every member
    // could still open the app.
    fx.held.workspace = { apps: 1, automations: 2 };
    const res = await put('legacy', { kind: 'workspace' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'KIND_HOLDS_OTHER_CONTENT');
    assert.deepStrictEqual(res.body.details, { kind: 'workspace', held: { apps: 1, automations: 2 } });
    assert.match(res.body.error, /Take them out first/);
    assert.deepStrictEqual(fx.written, [], 'not classified');
    assert.deepStrictEqual(fx.recorded, [], 'not announced');
    assert.strictEqual(fx.projects.legacy.kind, null);

    // The other way round: chats and documents keep a project out of Studio.
    fx.held.solution = { conversations: 30, documents: 2 };
    const sol = await put('guessed', { kind: 'solution' });
    assert.strictEqual(sol.status, 409);
    assert.deepStrictEqual(sol.body.details.held, { conversations: 30, documents: 2 });
    assert.strictEqual(fx.projects.guessed.kindGuessed, true, 'the guess can still be corrected later');
});

test('only the owner classifies: an editor 403, a stranger 404, no session 401', async () => {
    assert.strictEqual((await put('legacy', { kind: 'solution' }, EDITOR)).status, 403);
    assert.strictEqual((await put('legacy', { kind: 'solution' }, STRANGER)).status, 404);
    assert.strictEqual((await put('legacy', { kind: 'solution' }, null)).status, 401);
    assert.deepStrictEqual(fx.checked, []);
    assert.deepStrictEqual(fx.written, []);
    assert.strictEqual(fx.projects.legacy.kind, null);
});

test('classifying needs a real kind', async () => {
    assert.strictEqual((await put('legacy', { kind: 'folder' })).status, 400);
    assert.strictEqual((await put('legacy', {})).status, 400);
    assert.strictEqual((await put('legacy', { kind: 'workspace', extra: 1 })).status, 400);
    assert.deepStrictEqual(fx.written, []);
});

test('a race lost to another tab is a 409; a project deleted meanwhile a 404', async () => {
    fx.loseRace = true;
    const lost = await put('legacy', { kind: 'workspace' });
    assert.strictEqual(lost.status, 409);
    assert.strictEqual(lost.body.code, 'KIND_ALREADY_SET');
    assert.deepStrictEqual(fx.recorded, []);

    reset();
    fx.deleteOnCheck = true;
    const gone = await put('legacy', { kind: 'workspace' });
    assert.strictEqual(gone.status, 404);
    assert.deepStrictEqual(fx.recorded, []);
});
