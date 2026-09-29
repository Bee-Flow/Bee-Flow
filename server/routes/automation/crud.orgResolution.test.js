/**
 * The organisation a routine route acts for must come from the database, and
 * every call site must await it.
 *
 * ── WHY THIS IS PINNED AT ALL ───────────────────────────────────────
 * `orgOf` was `req.session.user.organizationId`. auth/sessionShapes.contract.test.js
 * freezes the seven login shapes and only two of them — the connector JWT and
 * password SIGNUP — ever write that field. So for every returning member it was
 * undefined, and four separate surfaces quietly acted as if the person had no
 * organisation: a created routine was stamped NULL, its datatable usage index
 * was written against no org, its folders landed in the shared no-org bucket,
 * and the org form-pages list came back for the wrong scope.
 *
 * ── WHY THE `await` IS THE PART WORTH A TEST ────────────────────────
 * Making `orgOf` async fixed the read but introduced a sharper failure mode
 * than the one it replaced. A forgotten `await` does not throw: the Promise is
 * passed straight into `createAutomation({ organizationId })` and
 * `listFolders(organizationId)`, where it is neither null nor an id. It reaches
 * the driver as a parameter no WHERE clause can ever match — so a routine is
 * created belonging to nothing, and every later "which routines are in this
 * org" read silently omits it. Nothing logs, and no existing test notices,
 * because each handler still answers 200.
 *
 * Source-level rather than behavioural on purpose: the property is "no call
 * site anywhere in this file forgets", which is a statement about the file, not
 * about one request.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(path.join(__dirname, 'crud.js'), 'utf8');
// Strip comments before asserting, the way routes/datatables.test.js does: the
// header comment explains the bug by NAMING the session field it replaced, and
// a naive scan reads that explanation as the bug itself.
const CRUD = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('orgOf resolves from the database, never from the session', () => {
    assert.match(CRUD, /const orgOf = async \(req\) =>/,
        'orgOf must be async — it reads `users`, not the session object');
    assert.match(CRUD, /resolveDatatablePrincipal/,
        'it must go through the one shared resolver, not a local DB read');
    assert.doesNotMatch(CRUD, /req\.session\.user\.organizationId/,
        'only 2 of the 7 frozen login shapes write this field — reading it is the bug');
});

test('every orgOf call site awaits it', () => {
    const calls = CRUD.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\borgOf\(req\)/.test(line) && !/const orgOf =/.test(line));

    assert.ok(calls.length >= 5, `expected several call sites, found ${calls.length}`);
    for (const { line, n } of calls) {
        assert.match(line, /await orgOf\(req\)/,
            `crud.js:${n} calls orgOf without await — that passes a Promise as an organisation id, `
            + `which matches no row and is never reported:\n  ${line.trim()}`);
    }
});

test('the org-scoped surfaces all go through it, not around it', () => {
    // Each of these took the session value before, and each was wrong for the
    // same reason. Naming them keeps a later edit from quietly reverting one.
    for (const callee of ['createAutomation', 'listFolders', 'createFolder', 'listFormPagesForOrg']) {
        const i = CRUD.indexOf(callee);
        assert.ok(i > -1, `${callee} call site not found`);
    }
    // The usage index is the one whose failure is invisible: reconcileUsage's
    // INSERT has a WHERE EXISTS on the org, so a wrong org writes zero rows and
    // the "used by" tab simply stays empty rather than erroring. It now runs
    // through automation/datatableUsageSync (create, import and update all write
    // a definition), so the property to pin is that every call site still feeds
    // it an org that came from orgOf.
    const syncCalls = [...CRUD.matchAll(/syncDatatableUsage\(\s*([^,]+),\s*([^,]+),/g)];
    assert.ok(syncCalls.length >= 3,
        `create, import and update each persist a definition — found ${syncCalls.length} call site(s)`);
    for (const [, , orgArg] of syncCalls) {
        assert.match(orgArg.trim(), /^(await orgOf\(req\)|organizationId)$/,
            `syncDatatableUsage was handed "${orgArg.trim()}" as the organisation`);
    }
    assert.match(CRUD, /const organizationId = await orgOf\(req\)/,
        'the create paths hoist the resolved org rather than re-reading it');
});
