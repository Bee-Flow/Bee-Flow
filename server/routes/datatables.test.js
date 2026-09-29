/**
 * The /api/datatables gate chain, asserted against the router source and the
 * mount.
 *
 * ── THIS FILE IS NOT COVERAGE ───────────────────────────────────────
 * "because standing up the real app needs a database" was the original reason
 * and is no longer one: @electric-sql/pglite is a devDependency and
 * `routes/datatables.integration.test.js` drives these very handlers against a
 * real Postgres. A source regex passes because the code says the right words —
 * it cannot see a row_count that drifted, a probe row that leaked into a
 * response or a DDL that never ran. Rules belong here; effects belong there.
 *
 * So what stays here is the class of property a request cannot show you: one
 * that has to hold at EVERY call site in the folder, including the ones no
 * test drives, and whose absence is silent. Anything that is a plain value —
 * the licence gates, which are two fields of a module — is asked of the module
 * instead.
 *
 * The properties worth pinning are the ones whose absence fails quietly:
 *   - no route accepts SQL;
 *   - a caller with no grade gets 404, not 403 — existence is not probeable;
 *   - sharing is licence-gated but reading and row writes are NOT (the drain
 *     exemption: a lapse must never strand a running routine);
 *   - every compile on this path states dialect 'pg' explicitly.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The router is a FOLDER: routes/datatables/index.js plus one module per
// resource group. "The router source" is therefore the WHOLE folder read as
// one text — a scan of index.js alone would still pass while covering almost
// nothing. The READING ORDER is the folder map in index.js's own header,
// which is the order the groups are registered in: several assertions below
// slice between two definitions, so that order is what makes such a slice
// mean what it says. Taken from the map rather than repeated here, and the
// test right below asserts the map covers every file in the folder.
const DIR = path.join(__dirname, 'datatables');
const ENTRY = fs.readFileSync(path.join(DIR, 'index.js'), 'utf8');
const MODULES = ['index.js', ...[...ENTRY.matchAll(/^ \* {3}(\w+\.js)\b/gm)].map(m => m[1])];
const RAW = MODULES.map(f => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n');
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test("index.js's folder map names every module, and this file reads them all", () => {
    // The fail-open this guards: a module added to the folder and left out of
    // the map drops out of SRC silently, and every assertion about it goes on
    // passing while asserting nothing.
    const onDisk = fs.readdirSync(DIR).filter(f => f.endsWith('.js') && !f.endsWith('.test.js')).sort();
    assert.deepStrictEqual([...MODULES].sort(), onDisk,
        'the folder map in routes/datatables/index.js and the folder itself disagree — add the module to the map, in the order index.js registers it');
});

// The body of one route handler, from its router.<verb>( to the next one.
// The routes sit inside each module's register(router), so the next
// registration is indented — the boundary is the same one, one level in.
function routeBody(verb, pathStr) {
    const needle = `router.${verb}('${pathStr}'`;
    const i = SRC.indexOf(needle);
    assert.ok(i > -1, `route ${verb.toUpperCase()} ${pathStr} not found`);
    const rest = SRC.slice(i + needle.length);
    const next = rest.search(/\n[ \t]*router\.(get|post|put|delete|use)\(/);
    return next === -1 ? rest : rest.slice(0, next);
}

test('the router is mounted on its own path, not under /api/automation', () => {
    assert.match(INDEX, /app\.use\('\/api\/datatables'/);
    // automation.routetable.test.js freezes the automation router's table.
    assert.doesNotMatch(SRC, /\/api\/automation/);
});

test('the mount carries module, auth and licence gates', () => {
    const line = INDEX.split('\n').find(l => l.includes("app.use('/api/datatables'"));
    assert.match(line, /requireModule\('automation'\)/);
    assert.match(line, /requireAuthedUser/);
    assert.match(line, /requireLicenseFeature\('automations'\)/);
});

test('the router chain matches the automation router: beta, active-org, rate limit', () => {
    assert.match(SRC, /router\.use\(requireBetaFeature\('automations'\)\)/);
    assert.match(SRC, /router\.use\(requireActiveOrgForMutations\(\)\)/);
    assert.match(SRC, /router\.use\(perUserRateLimit\(/);
});

test('no route accepts SQL — the refusal is explicit and by name', () => {
    assert.match(SRC, /router\.use\(rejectSqlKeys\)/);
    for (const k of ['sql', 'query', 'rawSql', 'rawQuery']) {
        assert.match(SRC, new RegExp(`'${k}'`), `${k} must be refused by name`);
    }
    assert.match(SRC, /code: 'sql_not_accepted'/);
    // and nothing here builds SQL itself
    assert.doesNotMatch(SRC, /SELECT .* FROM/i);
    assert.doesNotMatch(SRC, /INSERT INTO/i);
});

test('every compile states the Postgres dialect explicitly', () => {
    // Rows live in a pg schema while the App Studio engine flag may say sqlite;
    // compiling under that global emits LIKE for ILIKE and a TEXT timestamp.
    assert.match(SRC, /const PG = \{ dialect: 'pg' \}/);
    const compiles = SRC.match(/queryCompiler\.compile\w+\([\s\S]{0,400}?\);/g) || [];
    assert.ok(compiles.length >= 3, 'expected several compile sites');
    for (const c of compiles) {
        assert.ok(/dialect: 'pg'|PG\b/.test(c), `a compile without an explicit dialect:\n${c}`);
    }
});

test('a caller with no grade gets 404, and too low a grade gets 403', () => {
    const gate = SRC.slice(SRC.indexOf('function requireDatatableGrade'), SRC.indexOf('async function metaAndFilter'));
    assert.match(gate, /if \(!grade\) return res\.status\(404\)/,
        'the existence of a colleague\'s table must not be probeable');
    assert.match(gate, /gradeAtLeast\(grade, minGrade\)[\s\S]{0,120}status\(403\)/);
    assert.match(gate, /tagGate\(/, 'an identity-dependent middleware must be tagged or accessRegistry.drift fails');
});

test('the grade check uses the shared resolver, not a local copy of the rules', () => {
    assert.match(SRC, /require\('\.\.\/\.\.\/auth\/datatableAccess'\)/);
    assert.match(SRC, /gradeForPrincipal\(table, grants, principal\)/);
    // no ad-hoc ownership or sharing logic in the router
    assert.doesNotMatch(SRC, /owner_user_id ===/);
    assert.doesNotMatch(SRC, /shared_groups\.includes/);
});

test('the org, the role and the groups all come from a fresh DB read', () => {
    // Not just staleness. auth/sessionShapes.contract.test.js freezes the login
    // shapes, and only two of them ever put organizationId on the session — so
    // a session-derived org was null for every returning member and this whole
    // surface answered empty. One resolver, in auth/datatableAccess.
    assert.match(SRC, /resolveDatatablePrincipal\(req\)/);
    assert.doesNotMatch(SRC, /session\.user\.groups/,
        'req.session.user.groups is stale until re-login — auth/projectAccess exists because seven call sites forgot this');
    assert.doesNotMatch(SRC, /\.user\.organizationId/);
    assert.doesNotMatch(SRC, /\.user\.orgRole/);
});

test('the list covers BOTH tenancies and says which one a new table joins', () => {
    // A blank grid on an account that cannot own a table here is what sent
    // BFSF-412 round twice — the Studio kept offering "New table". The account
    // has a PERSONAL scope now, so the list walks every scope the caller can
    // address and the response names the default one.
    const body = routeBody('get', '/');
    assert.match(body, /datatableScopesFor\(principal\)/);
    assert.match(body, /for \(const scope of scopes\)/);
    assert.match(body, /scopeDescriptor\(defaultCreateScope\(principal\)\)/);
    // The last-resort branch survives for a request with no session at all.
    assert.match(body, /reason: 'no_scope'/);
});

test('a personal table can be neither published nor granted', () => {
    // Deny-by-default is only worth anything if it cannot be turned off: the
    // grade rule says an org admin gets nothing, and these say the owner cannot
    // hand it to one either.
    assert.match(SRC, /code: 'personal_table_not_shareable'/);
    for (const [verb, pth] of [['put', '/:id/sharing'], ['post', '/:id/grants']]) {
        assert.match(routeBody(verb, pth), /refuseWhenPersonal/, `${verb} ${pth}`);
    }
    // Removing access must always work, so the refusal deliberately stops short
    // of the DELETE.
    assert.doesNotMatch(routeBody('delete', '/:id/grants/:grantId'), /refuseWhenPersonal/);
});

test('sharing is licence-gated', () => {
    for (const [verb, p] of [['put', '/:id/sharing'], ['post', '/:id/grants']]) {
        const body = routeBody(verb, p);
        assert.match(body, /requireCapability\('automation_sharing'\)/, `${verb} ${p} must be gated`);
        assert.match(body, /requireManageForOrgScope\(\)/);
    }
});

test('manage_datatables is enforced for org scope and skipped for personal', () => {
    // config/orgRoles.json grants it under org_admin/agent_admin only, so
    // requiring it on a personal table would 403 the very account BFSF-412 was
    // filed from — before the scope was even looked at.
    const fn = SRC.slice(SRC.indexOf('function requireManageForOrgScope'),
        SRC.indexOf('function refuseWhenPersonal'));
    assert.match(fn, /req\.datatableScope\?\.kind === 'user'/);
    assert.match(fn, /requirePermission\(Permissions\.MANAGE_DATATABLES\)\(req, res, next\)/);
    assert.match(fn, /tagGate\(/, 'an identity-dependent middleware must be tagged or accessRegistry.drift fails');
    // Every owner-only route goes through it — none may fall back to the bare
    // permission middleware, which is what would lock a consumer out.
    for (const [verb, p] of [['put', '/:id/schema'], ['post', '/:id/repair'], ['delete', '/:id']]) {
        const body = routeBody(verb, p);
        assert.match(body, /requireManageForOrgScope\(\)/, `${verb} ${p}`);
        assert.doesNotMatch(body, /requirePermission\(Permissions\.MANAGE_DATATABLES\)/, `${verb} ${p}`);
    }
});

test('sharing validates the group ids against the organisation', () => {
    assert.match(routeBody('put', '/:id/sharing'), /validateSharedGroupsForOrg/);
    assert.match(routeBody('post', '/:id/grants'), /validateSharedGroupsForOrg/);
});

test('reads and row writes are NOT licence-gated — the drain exemption', () => {
    for (const [verb, p] of [['get', '/:id/rows'], ['post', '/:id/rows'], ['get', '/:id']]) {
        const body = routeBody(verb, p);
        assert.doesNotMatch(body, /requireCapability\('automation_sharing'\)/,
            `${verb} ${p} must keep working on a lapsed licence — a routine writing nightly must not silently stop`);
    }
});

test('removing a grant is ungated — taking access away must always work', () => {
    const body = routeBody('delete', '/:id/grants/:grantId');
    assert.doesNotMatch(body, /requireCapability/);
});

test('creating an ORG table needs manage_datatables; a personal one does not', () => {
    const body = routeBody('post', '/');
    // Both checks live inside the org branch, and both come before the write.
    assert.match(body, /hasPermission\(principal\.userId, Permissions\.MANAGE_DATATABLES/);
    assert.match(body, /assertUserCanUseOrg\(req, scope\.id\)/);
    assert.match(body, /code: 'no_organisation'/);
    assert.match(body, /code: 'bad_scope'/, 'an unknown scope word must be refused, never defaulted');
    assert.ok(body.indexOf('hasPermission(principal.userId') < body.indexOf('createDatatable('),
        'the permission check has to come before the write, not after it');
    // And it is NOT a route-level gate any more: as one it would run before the
    // scope was known and 403 the account with no organisation.
    assert.doesNotMatch(body.slice(0, body.indexOf('async (req, res)')),
        /requirePermission/, 'the gate must be inside the handler, under the org branch');
});

test('creating a table demands a description — it is the Art. 30 purpose', () => {
    // The demand lives in the request schema now, which is what makes the
    // refusal for an ABSENT description the same sentence as for a blank one —
    // zod answers a missing field with the bare word "Required" otherwise.
    assert.match(SRC, /const CreateBody = bodyOf\(\{[\s\S]*?description: tablePurpose\(\)/,
        'the create body must demand the purpose, not default it to empty');
    assert.match(SRC, /PURPOSE_TEXT = '[^']*processing record/);
    assert.match(routeBody('post', '/'), /validate\(\{ body: CreateBody \}\)/);
});

test('the row list slices off the cursor probe row', () => {
    const body = routeBody('get', '/:id/rows');
    assert.match(body, /\.slice\(0, limit\)/,
        'compileRecordList returns limit+1 as a cursor probe; stepDataSource documents the leak when a caller forgets');
    assert.match(body, /hasMore/);
    // …and it PRODUCES the cursor it has always accepted. Without this, page 2
    // was unreachable through the API.
    assert.match(body, /nextCursor: /);
    assert.match(body, /queryCompiler\.encodeCursor\(last\[compiled\.primaryField\], last\.id\)/);
});

test('the list descriptor is CLOSED — resolved against the table, never passed through', () => {
    // `filters`/`sort`/`q` are new client-controlled input on a path whose
    // whole promise is that no client SQL exists. The invariant is not that the
    // filter works; it is that a field name can only ever be one of THIS
    // table's declared columns and an operator can only be one of the
    // compiler's own. The behavioural half is asserted on the compiled SQL in
    // routes/datatables.integration.test.js.
    const fn = SRC.slice(SRC.indexOf('function readFilters'), SRC.indexOf('function readListDescriptor'));
    assert.match(fn, /filterableKeys\(meta\)/, 'field keys come from the table, not from the caller');
    assert.match(fn, /dataModel\.FILTER_OPS\.includes\(f\.op\)/, "operators come from the compiler's own list");
    assert.match(fn, /'unknown_filter_field'/);
    assert.match(fn, /'unknown_sort_field'/);
    // `q` builds its own column list server-side; the caller never names one.
    assert.match(fn, /SEARCHABLE_TYPES\.has\(f\.type\)/);
    // And the descriptor never reaches the compiler as a raw object.
    assert.doesNotMatch(SRC, /filters: req\.query\.filters/);
});

test("the page size is the compiler's clamp, not a second one that disagrees", () => {
    // `Math.min(Number(-5) || 50, MAX)` is -5: the SQL then ran at the
    // compiler's own default of 50 and the route sliced rows.slice(0, -5).
    const body = routeBody('get', '/:id/rows');
    assert.match(body, /limit: req\.query\.limit, maxLimit: ROWS_PAGE_MAX/);
    assert.match(body, /const limit = compiled\.limit/);
    assert.doesNotMatch(body, /Math\.min\(Number\(req\.query\.limit\)/);
    assert.match(SRC, /const ROWS_PAGE_MAX = 500/,
        'a 100k table at 50 a page is 2,000 requests against a 120/minute limiter');
});

test('a row can be read, edited and deleted, each at the right grade', () => {
    assert.match(SRC, /router\.get\('\/:id\/rows\/:rowId', requireDatatableGrade\('viewer'\)/);
    assert.match(SRC, /router\.put\('\/:id\/rows\/:rowId', requireDatatableGrade\('editor'\)/);
    assert.match(SRC, /router\.delete\('\/:id\/rows\/:rowId', requireDatatableGrade\('editor'\)/);
    const body = routeBody('put', '/:id/rows/:rowId');
    // The optimistic token is REQUIRED. compileUpdate has carried it from the
    // start and every read returns updated_at, so a client cannot fail to have
    // one — while a save without it is last-write-wins on a surface two
    // colleagues can have open at once. It is the schema that demands it now,
    // which is also what puts the refusal structurally BEFORE the write: a
    // validate() runs as middleware, so there is no ordering left to get wrong.
    assert.match(body, /validate\(\{ body: UpdateBody/);
    assert.match(SRC, /const UpdateBody = bodyOf\(\{[\s\S]*?expectedUpdatedAt: idText\(UPDATED_AT_TEXT\),[\s\S]*?\}\);/,
        'expectedUpdatedAt must be required on the update body, never optional');
    assert.match(body, /code: 'row_conflict'/);
    assert.match(body, /assertCanWrite\(meta, req\.datatableGrade, 'update'\)/);
});

test('the bulk import gets its own body limit, and the export streams', () => {
    // A route-local express.json() cannot work: body-parser sets req._body once
    // it has read the stream, so a second json() lower down is a no-op and the
    // 256 kb refusal has already happened.
    assert.match(SRC, /const BULK_PATH_RE = /);
    assert.match(SRC, /jsonBulk = express\.json\(\{ limit: '2mb' \}\)/);
    assert.match(SRC, /jsonStandard = express\.json\(\{ limit: '256kb' \}\)/);
    assert.match(SRC, /BULK_PATH_RE\.test\(req\.path\) \? jsonBulk\(req, res, next\) : jsonStandard\(/);

    const bulk = routeBody('post', '/:id/rows/bulk');
    assert.match(bulk, /datatableDbStore\.batch\(/, 'one transaction per chunk, not one per row');
    assert.match(bulk, /errors\.push\(\{ line: i \+ 1/, 'a bad row is reported by line, not as one refusal for the file');

    const csv = routeBody('get', '/:id/rows.csv');
    assert.match(csv, /res\.write\(/, 'a 100k-row export is streamed, never assembled in memory first');
    assert.match(csv, /cursor = queryCompiler\.encodeCursor\(/, 'paged with the keyset cursor');
    // A leading =, + or - makes Excel treat an exported cell as a FORMULA when
    // the file is opened — a datatable column running as code on a colleague's
    // machine. csvCell prefixes those with a quote.
    const cell = SRC.slice(SRC.indexOf('function csvCell'), SRC.indexOf('/:id/rows.csv'));
    assert.match(cell, /test\(text\)\) text = /);
    assert.match(cell, /replace\(\/"\/g, '""'\)/, 'and RFC4180 quoting for the ordinary case');
});

test('quota refusals use the frozen 409 contract', () => {
    assert.match(SRC, /code: 'quota_exceeded', limit, used/);
    // The COLUMN cap is this router's own — one table's shape, decided here.
    assert.match(SRC, /MAX_FIELDS_PER_TABLE/);
    // The STORAGE envelope is not. It used to spend DATA_LIMITS'
    // MAX_TABLES_PER_APP — a constant named, documented and sized for one App
    // Studio app — as a per-organisation cap, and it enforced the row cap only
    // here, so a routine wrote past it for as long as it liked.
    // core/dataEngine/datatableLimits is the one check both callers run.
    assert.doesNotMatch(SRC, /MAX_TABLES_PER_APP/,
        'a per-app constant must not be spent as a per-organisation cap');
    assert.doesNotMatch(SRC, /DATA_LIMITS\.MAX_ROWS_PER_TABLE/,
        'the row cap lives in datatableLimits so the runner enforces the same number');
    assert.match(SRC, /assertDatatableQuota\(/);
    // limit/used have to survive the answer, or "full" carries no number.
    assert.match(SRC, /e\.limit !== undefined && e\.used !== undefined/);
});

test('the table count is taken under the model row\'s lock, not before it', () => {
    // It used to list every table in the organisation OUTSIDE any transaction
    // and compare the length: two replicas could both see 49 and both create
    // the 50th. createDatatable takes the FOR UPDATE first and hands the usage
    // to this callback.
    const body = routeBody('post', '/');
    assert.match(body, /assertQuota: \(usage\) => assertDatatableQuota\(scope, \{ addTables: 1, usage \}\)/);
    assert.doesNotMatch(body, /listDatatablesForScope/,
        'counting outside the lock is the race this moved inside it');
    // De store is een FACADE met zijn onderdelen in stores/datatableStore/;
    // createDatatable woont in datatables.js. Lees de hele module als één
    // tekst, anders is de slice hieronder leeg en bewijst dit niets meer.
    const storeDir = path.join(__dirname, '..', 'stores', 'datatableStore');
    const store = fs.readdirSync(storeDir)
        .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map(f => fs.readFileSync(path.join(storeDir, f), 'utf8'))
        .join('\n');
    const fn = store.slice(store.indexOf('async function createDatatable'), store.indexOf('async function saveModel'));
    assert.ok(fn.indexOf('FOR UPDATE') < fn.indexOf('await assertQuota('),
        'the lock has to be held before the count is taken');
    assert.ok(fn.indexOf('await assertQuota(') < fn.indexOf('INSERT INTO datatables'),
        'and the refusal has to come before the write');
});

test('a schema save is optimistic and reports a conflict rather than clobbering', () => {
    const body = routeBody('put', '/:id/schema');
    assert.match(body, /expectedVersion/);
    assert.match(body, /code: 'version_conflict'/);
});

test('the optimistic lock is MANDATORY — a missing version is refused, never defaulted', () => {
    // The default is the whole point: `expectedVersion === undefined ? null :
    // Number(...)` against saveModel's `if (expectedVersion !== null)` meant a
    // client that forgot the field skipped the check entirely. Nothing here may
    // turn an absent version into "no check".
    const body = routeBody('put', '/:id/schema');
    assert.match(body, /code: 'version_required'/);
    assert.doesNotMatch(body, /expectedVersion\s*===\s*undefined\s*\?\s*null/,
        'an absent version must refuse, not fall back to an unchecked save');
    assert.ok(body.indexOf("code: 'version_required'") < body.indexOf('saveModel('),
        'the refusal has to come before the write, not after it');
    // And a MALFORMED one is refused by the schema rather than coerced.
    // `Number()` alone accepts true (→1), [] (→0) and '' (→0), and each of
    // those came back as a 409 telling the person a colleague was editing.
    assert.match(SRC, /expectedVersion: z\.union\(\[[\s\S]*?z\.number\(\)\.int\(VERSION_TEXT\)[\s\S]*?\/\^\\d\+\$\//,
        'a version is a number or the digits of one, and nothing else');
});

test('both write paths put the model and the DDL in ONE transaction', () => {
    // They used to be two, metadata first: a create left a table the picker
    // listed and every read 500'd on, and a schema save left model_version
    // bumped for a column Postgres does not have — permanently, because
    // migrationPlan step 4 skips a field whose id is already in `oldIds`.
    for (const [verb, p] of [['post', '/'], ['put', '/:id/schema']]) {
        const body = routeBody(verb, p);
        assert.match(body, /db\.withTransaction\(async \(client\) =>/, `${verb.toUpperCase()} ${p}`);
        assert.match(body, /applyPhysical: async \(c,/, `${verb.toUpperCase()} ${p} must own the DDL callback`);
        assert.match(body, /applyMigration\([^)]*\{ client: c/s,
            `${verb.toUpperCase()} ${p} must apply the DDL on the transaction's own client`);
    }
});

test('every plan a write path builds is scoped to the table it is touching', () => {
    // One model document per organisation, so an unscoped diff carries out
    // whatever else two versions of it disagree about — a concurrent editor's
    // half-finished DROP COLUMN included.
    for (const [verb, p] of [['post', '/'], ['put', '/:id/schema'], ['post', '/:id/repair']]) {
        assert.match(routeBody(verb, p), /onlyTableIds: \[/, `${verb.toUpperCase()} ${p}`);
    }
    // And so is the delete, one level down in the store. Bewust brontekst,
    // zoals de bestandskop hierboven beargumenteert: dit moet op ELKE
    // planbouw-plek gelden, ook op plekken die geen test aandrijft, en het
    // ontbreken van de scope is stil — precies de klasse van eigenschap
    // waarvoor dit bestand kiest voor tekst boven gedrag.
    const store = fs.readFileSync(path.join(__dirname, '..', 'stores', 'datatableDbStore.js'), 'utf8');
    assert.match(store, /onlyTableIds: \[datatableId\]/);
});

test('the drift pair exists and is owner-only', () => {
    // getSchemaStamp was exported and never called: the model and Postgres
    // could disagree with nothing anywhere able to say so.
    assert.match(SRC, /router\.get\('\/:id\/health', requireDatatableGrade\('owner'\)/);
    assert.match(SRC, /router\.post\('\/:id\/repair',\s*requireDatatableGrade\('owner'\)/);
    assert.match(SRC, /getSchemaStamp\(/);
});

test('both write paths normalise the columns before they enter the model', () => {
    // Not style: the migration planner matches fields by id, so a field written
    // to the model without one is invisible to it — the column is never created
    // in Postgres and the route still answers 200. See dataModel/datatableFields.
    for (const [verb, p] of [['post', '/'], ['put', '/:id/schema']]) {
        const body = routeBody(verb, p);
        assert.match(body, /normalizeFields\(/, `${verb.toUpperCase()} ${p} must normalise`);
        assert.match(body, /norm\.ok/, `${verb.toUpperCase()} ${p} must refuse a bad column list`);
    }
    // The stored list is the identity baseline on an edit — passing [] there
    // would mint fresh ids and turn every save into DROP COLUMN + ADD COLUMN.
    // It is captured BEFORE t.fields is replaced, because it is also what the
    // breaking-change guard diffs against.
    const body = routeBody('put', '/:id/schema');
    assert.match(body, /const storedFields = Array\.isArray\(t\.fields\) \? t\.fields : \[\]/);
    assert.match(body, /normalizeFields\(fields, storedFields\)/);
    assert.ok(body.indexOf('const storedFields') < body.indexOf('t.fields = norm.fields'),
        'captured after the replacement it would describe the NEW columns, so no drop is ever seen');
});

test('a column drop that breaks a routine is refused unless the caller confirms', () => {
    // listUsageForColumn is described in the store as "the destructive-change
    // guard" and had no caller: the commit message for the feature claimed the
    // destructive actions read it before they ask, and on the server they did
    // not. A dropped column breaks somebody else's routine silently, at 3am.
    const body = routeBody('put', '/:id/schema');
    assert.match(body, /breakingColumnUsage\(/);
    assert.match(body, /code: 'breaking_change'/);
    assert.match(body, /confirmedBreaking\(req\)/);
    // Diffed by id, like the migration planner: a RENAME keeps the id and is
    // not a drop, so matching on key would refuse renames and miss nothing.
    const fn = SRC.slice(SRC.indexOf('async function breakingColumnUsage'), SRC.indexOf('function rejectSqlKeys'));
    assert.match(fn, /keptIds/);
    assert.match(fn, /listUsageForColumn\(/);
});

test('deleting a table asks the same question, one level up', () => {
    const body = routeBody('delete', '/:id');
    assert.match(body, /listUsage\(/);
    assert.match(body, /code: 'in_use'/);
    assert.match(body, /confirmedBreaking\(req\)/);
});

test('deleting a table drops its rows in the SAME transaction as its metadata', () => {
    // It used to commit the metadata and only THEN compute and run the DROP, and
    // answer {ok:true} without checking it ran — so a lock timeout left a table
    // full of personal data that nothing described and no UI could reach.
    const body = routeBody('delete', '/:id');
    assert.match(body, /datatableDbStore\.dropDatatable\(/);
    assert.doesNotMatch(body, /applyMigration/,
        'the DDL must ride the metadata transaction, not follow its commit');
});

test('deleting a row that is not there is a 404 and does not move row_count', () => {
    // bumpAfterWrite clamps at zero, so N unconditional decrements walk a full
    // table's row_count down to 0 and the quota check then passes forever.
    const body = routeBody('delete', '/:id/rows/:rowId');
    assert.match(body, /out\?\.changes/, 'read what the engine actually changed');
    assert.match(body, /status\(404\)/);
    assert.ok(body.indexOf('status(404)') < body.indexOf('bumpAfterWrite'),
        'the counter must only move after a row really went');
});

test('a bulk delete is editor-gated, capped, access-filtered, and moves the counter by what went', () => {
    const body = routeBody('post', '/:id/rows/bulk-delete');
    assert.match(body, /requireDatatableGrade\('editor'\)/);
    assert.match(body, /assertCanWrite\(meta, req\.datatableGrade, 'delete'\)/);
    // The same compiled statement as the single delete — the access predicate
    // rides inside it, so an invisible row is neither deleted nor counted.
    assert.match(body, /queryCompiler\.compileDelete\(meta, id, filter, PG\)/);
    assert.match(body, /metaAndFilter\(req, 'delete'\)/);
    // Bounded: it is a selection on screen, not an import.
    assert.match(SRC, /const BULK_DELETE_MAX_IDS = 200;/);
    assert.match(body, /code: 'too_many_ids'/);
    assert.match(body, /status\(413\)/);
    // A selection that is not a list of ids is refused by the schema, before
    // a single compileDelete is built.
    assert.match(body, /validate\(\{ body: BulkDeleteBody/);
    assert.match(SRC, /const BulkDeleteBody = bodyOf\(\{[\s\S]*?ids: z\.array\(idText\(IDS_TEXT\)/);
    // One engine batch (one transaction), and the counter follows Postgres's
    // count of rows gone — never the number of ids asked for.
    assert.match(body, /datatableDbStore\.batch\(req\.datatableScopeKey, req\.datatableScopeKey,/);
    assert.match(body, /r\?\.changes/);
    assert.match(body, /if \(deleted > 0\) await datatableStore\.bumpAfterWrite\(req\.datatable\.id, req\.datatableScope, -deleted\)/);
    assert.doesNotMatch(body, /bumpAfterWrite\([^)]*ids\.length/, 'the counter must not move by what was requested');
});

test('the list carries usageCount from ONE grouped read, not a usage read per table', () => {
    const body = routeBody('get', '/');
    assert.match(body, /listUsageCounts\(all\.map\(t => t\.id\)\)/);
    assert.match(body, /usageCount: usageByTable\.get\(t\.id\) \|\| 0/);
    assert.doesNotMatch(body, /listUsage\(/, 'per-table usage reads in a list handler are the N+1 this avoids');
});

test('a schema save leads with an idempotent CREATE TABLE', () => {
    // The repair path for a table whose columns were stored without ids: it
    // has no usable physical table, so its ALTERs would fail on a missing
    // relation. ddlForTable emits CREATE TABLE IF NOT EXISTS, so this is a
    // no-op in the ordinary case.
    const body = routeBody('put', '/:id/schema');
    assert.match(body, /ddlForTable\(t,/);
    assert.match(body, /\[ensure,\s*\.\.\.plan\]/);
});

test('featureMap declares both the Community mount and the Enterprise sharing route', () => {
    // Asked of the map, not of its source: it is a plain module, and the two
    // gate names are what the licence layer reads out of it.
    const featureMap = require('../license/featureMap');
    assert.strictEqual(featureMap['/api/datatables'].gate, 'automations',
        'the mount itself is Community — a lapse must never strand a running routine');
    assert.strictEqual(featureMap['/api/datatables/*/sharing'].gate, 'automation_sharing',
        'and publishing or granting a datatable is the paid line');
});

test('every list read is narrowed to a tenant', () => {
    assert.match(routeBody('get', '/'), /listDatatablesForScope\(scope\)/);
    // The unscoped form does not exist any more, in either spelling. (POST /
    // no longer lists at all — it counts under the model row's lock; see the
    // test above.)
    assert.doesNotMatch(SRC, /listDatatablesForScope\(\)/);
    assert.doesNotMatch(SRC, /listDatatablesForOrg/);
});

test('the engine is addressed by a SCOPE KEY, never by a bare organisation id', () => {
    // `(orgId, orgId)` used to be the tenant handle. A bare id now hashes to a
    // schema nobody's rows are in, and applyMigration's CREATE SCHEMA IF NOT
    // EXISTS would mint it empty beside the real one.
    const calls = SRC.match(/datatableDbStore\.(query|exec|applyMigration|getSchemaStamp|schema)\(([^,]+), ([^,]+),/g) || [];
    assert.ok(calls.length >= 5, 'expected several engine call sites');
    for (const c of calls) {
        assert.match(c.replace(/\s+/g, ' '),
            /\( ?(scopeKey|req\.datatableScopeKey), (scopeKey|req\.datatableScopeKey)[,)]/,
            `an engine call that is not scope-keyed:\n${c}`);
    }
    assert.doesNotMatch(SRC, /datatableDbStore\.\w+\(organizationId, organizationId/);
});

test('the projection never leaks the access rules to the client', () => {
    const fn = SRC.slice(SRC.indexOf('function publicTable'), SRC.indexOf('router.get(\'/\''));
    assert.doesNotMatch(fn, /\baccess\b/);
    assert.doesNotMatch(fn, /rowFilters/);
});
