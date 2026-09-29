/**
 * The spreadsheet linking router, read as text — the same technique
 * routes/datatablesNextcloud.test.js uses, for the same reason: the mount
 * order and the gate chain rot silently when a helper hides them. The
 * handlers themselves dispatch to the adapter's link module; the behaviour
 * behind them is proven in core/dataEngine/sources/spreadsheetFile/link.test.js
 * and routes/datatables.spreadsheet.integration.test.js.
 *
 * Run: cd server && node --test routes/datatablesSpreadsheets.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(path.join(__dirname, 'datatablesSpreadsheets.js'), 'utf8');
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
// The parent router is a FOLDER now: routes/datatables/index.js plus one
// module per resource group. Read the whole folder as one text, in the
// reading order its own header documents — the mount order asserted below
// lives in index.js, the `/:id` routes it is compared against live in the
// sibling modules, and a scan of index.js alone would assert neither.
const PARENT_DIR = path.join(__dirname, 'datatables');
const PARENT_ENTRY = fs.readFileSync(path.join(PARENT_DIR, 'index.js'), 'utf8');
const PARENT_FILES = ['index.js', ...[...PARENT_ENTRY.matchAll(/^ \* {3}(\w+\.js)\b/gm)].map(m => m[1])];
const PARENT = PARENT_FILES.map(f => fs.readFileSync(path.join(PARENT_DIR, f), 'utf8')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function routeBody(verb, pathStr) {
    const needle = `router.${verb}('${pathStr}'`;
    const i = SRC.indexOf(needle);
    assert.ok(i > -1, `route ${verb.toUpperCase()} ${pathStr} not found`);
    const rest = SRC.slice(i + needle.length);
    const next = rest.search(/\n\s*router\.(get|post|put|delete|use)\(/);
    return next === -1 ? rest : rest.slice(0, next);
}

test('the sub-router is mounted on /spreadsheets right after /nextcloud and BEFORE any /:id route', () => {
    const nc = PARENT.indexOf("router.use('/nextcloud'");
    const mount = PARENT.indexOf("router.use('/spreadsheets'");
    const firstId = PARENT.indexOf("router.get('/:id'");
    assert.ok(mount > -1, 'mounted');
    assert.ok(nc < mount, 'after the Nextcloud mount');
    assert.ok(mount < firstId, "'spreadsheets' would otherwise be read as a table id");
    // Bewust brontekst, zoals de bestandskop zegt: dezelfde techniek en reden
    // als routes/datatablesNextcloud.test.js / routes/datatables.test.js.
    assert.match(PARENT, /require\('\.\.\/datatablesSpreadsheets'\)\(\{ publicTable \}\)/, 'built with the parent projection, not a copy');
});

test('every route resolves the principal and the scope through the same chain POST / spells out', () => {
    for (const [verb, p] of [['get', '/providers'], ['get', '/browse'], ['get', '/describe'], ['post', '/link']]) {
        const body = routeBody(verb, p);
        assert.match(body, /resolveDatatablePrincipal\(req\)/, `${p}: principal`);
        assert.match(body, /resolveScope\(req, res, principal/, `${p}: scope`);
        assert.match(body, /adapter\(\)\.link\./, `${p}: dispatches to the adapter`);
    }
    const scope = SRC.slice(SRC.indexOf('async function resolveScope'), SRC.indexOf('function makeSpreadsheetsRouter'));
    assert.match(scope, /assertUserCanUseOrg\(req, principal\.orgId\)/);
    assert.match(scope, /hasPermission\(principal\.userId, Permissions\.MANAGE_DATATABLES, req\.session\)/);
    assert.match(scope, /code: 'bad_scope'/);
    assert.match(scope, /code: 'no_organisation'/);
});

test('browse and describe mount the engine\'s ONE storage bucket; link spends it in the engine, so it carries none here; the id spellings pass through', () => {
    // One bucket for browse, describe, link AND relink: the engine's
    // (link.js), so a relink — whose route lives in datatables.js — shares
    // it. A second `perUserRateLimit(…)` in this file would be a second budget.
    assert.match(SRC, /const storageLimiter = \(req, res, next\) => adapter\(\)\.link\.storageLimiter\(req, res, next\)/);
    assert.doesNotMatch(SRC, /perUserRateLimit/, 'the bucket is the engine\'s, not a second one');
    assert.match(SRC, /router\.get\('\/browse', storageLimiter,/);
    assert.match(SRC, /router\.get\('\/describe', storageLimiter,/);
    assert.doesNotMatch(SRC, /router\.get\('\/providers', storageLimiter/, 'the cheap probe is not limited beyond the parent');
    assert.doesNotMatch(SRC, /router\.post\('\/link', storageLimiter/, 'linkSpreadsheets spends the bucket itself — mounting it here too would charge a link twice');
    const describe = routeBody('get', '/describe');
    assert.match(describe, /driveId: q\.driveId, path: q\.path/);
});

test('the engine really exposes that bucket: thirty a minute, and spendStorageBudget spends the SAME one storageLimiter does', async () => {
    // Called for real instead of read as text — this also proves the numbers
    // (30 / 60s), which a regex on the literal could only assume were live.
    const { storageLimiter, spendStorageBudget } = require('../core/dataEngine/sources/spreadsheetFile/link');
    const userId = `rl-test-${Date.now()}-${Math.random()}`;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        // Thirty spends through the engine-function path succeed…
        for (let i = 0; i < 30; i++) await spendStorageBudget({ userId });
        // …and the THIRTY-FIRST, one bucket later, is refused — whether it
        // arrives through spendStorageBudget or through the middleware
        // directly, because there is only the one bucket to spend from.
        await assert.rejects(spendStorageBudget({ userId }), /rate_limited|429|Too many/i);
        const req = { session: { user: { id: userId } }, ip: 'test' };
        let status = null;
        const res = { set() { return res; }, status(c) { status = c; return res; }, json() { return res; } };
        let nextCalled = false;
        storageLimiter(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false, 'the middleware sees the same exhausted bucket spendStorageBudget just spent');
        assert.strictEqual(status, 429);

        // A fresh user's own bucket is unaffected…
        const other = `rl-test-other-${Date.now()}-${Math.random()}`;
        await spendStorageBudget({ userId: other }); // does not throw

        // …and this user's own bucket clears at exactly the 60-second mark,
        // not a moment before: 59_999ms in it is still the same window (a
        // shorter windowMs would wrongly clear here), and only at 60_000ms
        // does it open again (a longer windowMs would wrongly still deny).
        now += 59_999;
        await assert.rejects(spendStorageBudget({ userId }), /rate_limited|429|Too many/i,
            'still inside the window one ms short of 60s');
        now += 1;
        await spendStorageBudget({ userId }); // does not throw — the window is exactly 60_000ms
    } finally {
        Date.now = realNow;
    }
});

test('the router builds no SQL, touches no engine, and names no provider client', () => {
    assert.doesNotMatch(SRC, /SELECT .* FROM/i);
    assert.doesNotMatch(SRC, /datatableDbStore/);
    assert.doesNotMatch(SRC, /queryCompiler/);
    assert.doesNotMatch(SRC, /googleapis|msGraph|webdav/i);
    assert.doesNotMatch(SRC, /requireBetaFeature/);
});

test('a link answers 201, a partial link 207, and every refusal by status, code, ref, datatableId, reason, detail, header and key', () => {
    const body = routeBody('post', '/link');
    assert.match(body, /out\.partial \? 207 : 201/);
    assert.match(body, /publicTable\(t, 'owner'\)/);
    const answer = SRC.slice(SRC.indexOf('function answer'), SRC.indexOf('async function resolveScope'));
    assert.match(answer, /isSourceError\(e\)/);
    assert.match(answer, /body\.code = e\.code/);
    assert.match(answer, /body\.ref = e\.ref/);
    assert.match(answer, /body\.datatableId/);
    // The client builds its sentence from these fields (sourceMirrors.js
    // ssErrorMessage reads body.detail / body.header / body.key); a field
    // left off the wire is a garbled or duplicated sentence.
    assert.match(answer, /body\.reason = e\.reason/);
    assert.match(answer, /body\.detail = e\.detail/);
    assert.match(answer, /body\.header = e\.header/);
    assert.match(answer, /body\.key = e\.key/);
    // and a SQLSTATE is never echoed as a code
    assert.match(answer, /!\/\^\\d\/\.test\(e\.code\)/);
});

test('answer(): the wire body carries detail, header, key and reason; a unique-violation on the technical name is 409 key_taken; a SQLSTATE never leaks', () => {
    const make = require('./datatablesSpreadsheets');
    const { SpreadsheetSourceError } = require('../core/dataEngine/sources/spreadsheetFile/errors');
    // answer() is module-private; drive it through the /link handler with a stubbed adapter.
    const registry = require('../core/dataEngine/sources');
    const original = registry.adapterFor;
    const router = make({ publicTable: (t) => t });
    const handler = router.stack.find(l => l.route && l.route.path === '/link').route.stack.at(-1).handle;
    const fakeRes = () => { const r = { headers: {} }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; return r; };
    // resolveDatatablePrincipal answers a pre-resolved `_dtPrincipal` as is; a personal scope needs only a userId.
    const req = { _dtPrincipal: { userId: 'u1', orgId: null }, session: { user: { id: 'u1' } }, body: { scope: 'personal', tables: [{}] } };
    const run = async (thrown) => {
        registry.adapterFor = () => ({ link: { linkSpreadsheets: async () => { throw thrown; } } });
        const res = fakeRes();
        await handler(req, res);
        return res;
    };
    return (async () => {
        try {
            let res = await run(new SpreadsheetSourceError(422, 'key_not_unique', '"Stad" cannot be the key: 1 rows repeat a value ("Delft").', { ref: { provider: 'google_drive', fileId: 'f1', sheet: 'S' }, detail: '1 rows repeat a value ("Delft")', header: 'Stad' }));
            assert.strictEqual(res.statusCode, 422);
            assert.deepStrictEqual(res.body, { error: '"Stad" cannot be the key: 1 rows repeat a value ("Delft").', code: 'key_not_unique', ref: { provider: 'google_drive', fileId: 'f1', sheet: 'S' }, detail: '1 rows repeat a value ("Delft")', header: 'Stad' });

            res = await run(new SpreadsheetSourceError(409, 'key_taken', 'There is already a table with the technical name "facturen" here.', { key: 'facturen' }));
            assert.strictEqual(res.statusCode, 409);
            assert.deepStrictEqual(res.body, { error: 'There is already a table with the technical name "facturen" here.', code: 'key_taken', key: 'facturen' });

            res = await run(new SpreadsheetSourceError(403, 'provider_not_connected', 'Renew Google', { detail: 'needs_reauth' }));
            assert.strictEqual(res.body.detail, 'needs_reauth');

            res = await run(new SpreadsheetSourceError(409, 'spreadsheet_write_unsupported', 'read-only', { reason: 'not_owned' }));
            assert.strictEqual(res.body.reason, 'not_owned');

            // the pg unique violation two racing links hit: 409 key_taken, no SQLSTATE on the wire
            const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "uq_datatables_scope_key"'), { code: '23505', constraint: 'uq_datatables_scope_key' });
            res = await run(pgErr);
            assert.strictEqual(res.statusCode, 409);
            assert.deepStrictEqual(res.body, { error: 'A table with this technical name already exists here', code: 'key_taken' });

            // any other pg error is a 500 without its SQLSTATE
            res = await run(Object.assign(new Error('boom'), { code: '42P01', status: 500 }));
            assert.strictEqual(res.statusCode, 500);
            assert.strictEqual(res.body.code, undefined);

            // a 429 from the engine's storage bucket carries Retry-After
            const limited = new SpreadsheetSourceError(429, 'rate_limited', 'Too many requests');
            limited.retryAfter = 17;
            res = await run(limited);
            assert.strictEqual(res.statusCode, 429);
            assert.strictEqual(res.headers['Retry-After'], '17');
        } finally {
            registry.adapterFor = original;
        }
    })();
});

test('the four handlers are mounted in order, and the factory refuses to run without the parent projection', async () => {
    const make = require('./datatablesSpreadsheets');
    assert.throws(() => make({}), /parent projection/);
    const router = make({ publicTable: (t) => t });
    const routes = router.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
    assert.deepStrictEqual(routes, ['get /providers', 'get /browse', 'get /describe', 'post /link']);
});
