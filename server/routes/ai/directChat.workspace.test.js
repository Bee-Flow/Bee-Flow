/**
 * PUT /direct/conversations/:id/workspace — the caller identity must reach the
 * store, and the store's validation errors must not become 500s.
 *
 * WHY THIS IS A SOURCE TEST. routes/ai/directChat.js cannot be required in a
 * unit test: it pulls the whole chat runtime in at module load and blocks on
 * infrastructure. directChat.scope.test.js next door exists for the same
 * reason and reads the source too. The store side of this contract IS covered
 * behaviourally, in stores/agent/sharedWrite.test.js, which drives the real
 * updateDirectConversationWorkspace against a fake pool and asserts a
 * non-owner writes zero rows. What that cannot see is whether the ROUTE
 * actually hands the store a caller id — and that is precisely what broke.
 *
 * WHAT BROKE. updateDirectConversationWorkspace is owner-only: it takes the
 * caller's userId as a 4th argument and throws CALLER_USER_ID_REQUIRED without
 * one, deliberately, so that a scoped call can never silently degrade into an
 * unscoped one. The route was still calling it with 3. Every save therefore
 * threw into the handler's blanket catch and answered 500 — including the
 * owner's own saves. And the SPA does not surface it: authFetch
 * (agent-hub/src/utils/helpers.js) does not throw on a non-2xx, so
 * AgentHub.saveNotebook's try/catch never fired. The user saw the optimistic
 * update, and the notebook came back empty on reload. A closed security hole
 * that eats the owner's data is not a fix.
 *
 * The 400/413 mapping is part of the same contract: the store distinguishes
 * INVALID_WORKSPACE_CONTENT and WORKSPACE_CONTENT_TOO_LARGE, and a blanket
 * catch flattens both into 500 — which the client, again, silently swallows.
 *
 * Run: cd server && node --test routes/ai/directChat.workspace.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'directChat', 'conversationRoutes.js'), 'utf8');

/**
 * The body of the PUT .../workspace handler: from its router.put line to the
 * closing `});` at column 0 that ends the route.
 */
function workspaceHandler() {
    const start = SRC.indexOf("router.put('/direct/conversations/:id/workspace'");
    assert.ok(start > 0, 'PUT /direct/conversations/:id/workspace handler not found');
    const end = SRC.indexOf('\n});', start);
    assert.ok(end > start, 'could not find the end of the workspace handler');
    return SRC.slice(start, end);
}

test('the workspace save passes the caller userId to the store', () => {
    const body = workspaceHandler();
    const call = body.match(/updateDirectConversationWorkspace\(([^;]*?)\);/s);
    assert.ok(call, 'handler does not call updateDirectConversationWorkspace');

    // Argument count, counted at depth 0 so the ternary and `content || ''`
    // inside argument 2 and 3 do not split.
    const args = [];
    let depth = 0;
    let current = '';
    for (const ch of call[1]) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    if (current.trim()) args.push(current.trim());

    assert.strictEqual(args.length, 4,
        `updateDirectConversationWorkspace is owner-only and needs the caller id as a 4th argument; got ${args.length}: ${args.join(' | ')}`);
    assert.strictEqual(args[3], 'userId',
        `the 4th argument must be the session-derived userId, got \`${args[3]}\``);
});

test('the caller id comes from the session, never from the request', () => {
    const body = workspaceHandler();
    assert.match(body, /const userId = req\.session\.user\.id;/,
        'userId must be read from req.session.user.id');
    // A body/param-supplied id would make the owner predicate meaningless —
    // the caller would just name the owner. Guard against that shape landing
    // here later.
    const call = body.match(/updateDirectConversationWorkspace\([^;]*?\);/s)[0];
    assert.doesNotMatch(call, /req\.body/, 'the caller id must not come from req.body');
    assert.doesNotMatch(call, /req\.params\.userId/, 'the caller id must not come from req.params');
});

test('store validation errors map to 400 and 413, not a blanket 500', () => {
    const body = workspaceHandler();

    const invalid = body.match(/INVALID_WORKSPACE_CONTENT[\s\S]{0,120}?status\((\d{3})\)/);
    assert.ok(invalid, 'handler does not handle INVALID_WORKSPACE_CONTENT');
    assert.strictEqual(invalid[1], '400', 'INVALID_WORKSPACE_CONTENT must answer 400');

    const tooLarge = body.match(/WORKSPACE_CONTENT_TOO_LARGE[\s\S]{0,120}?status\((\d{3})\)/);
    assert.ok(tooLarge, 'handler does not handle WORKSPACE_CONTENT_TOO_LARGE');
    assert.strictEqual(tooLarge[1], '413', 'WORKSPACE_CONTENT_TOO_LARGE must answer 413');

    // Both must be answered BEFORE the catch-all 500, or they never fire.
    assert.ok(body.indexOf('INVALID_WORKSPACE_CONTENT') < body.indexOf('Failed to update workspace'),
        'the validation branches must precede the catch-all 500');
});

test('the store still refuses a call with no caller id', () => {
    // Reading the store's source rather than requiring it: directConversations
    // pulls in ../../db at load. The point is that the two halves of this
    // contract stay in step — if the guard is ever relaxed to a default, the
    // route test above stops meaning anything.
    const store = fs.readFileSync(
        path.join(__dirname, '..', '..', 'stores', 'agent', 'directConversations.js'), 'utf8');
    const fn = store.slice(store.indexOf('async function updateDirectConversationWorkspace'));
    assert.match(fn.slice(0, 600), /CALLER_USER_ID_REQUIRED/,
        'updateDirectConversationWorkspace must throw rather than default the caller id');
    assert.doesNotMatch(fn.slice(0, 600), /userId\s*=\s*null\s*\)/,
        'a defaulted caller id turns a scoped write back into an unscoped one');
});
