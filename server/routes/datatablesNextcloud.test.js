/**
 * The linking router, read as text — the same technique routes/datatables.
 * test.js uses, for the same reason: these gates are the kind of thing that
 * rots silently when a helper hides them.
 *
 * Run: cd server && node --test routes/datatablesNextcloud.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(path.join(__dirname, 'datatablesNextcloud.js'), 'utf8');
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

test('the sub-router is mounted on /nextcloud BEFORE any /:id route, after the SQL refusal', () => {
    const mount = PARENT.indexOf("router.use('/nextcloud'");
    const firstId = PARENT.indexOf("router.get('/:id'");
    const sqlGate = PARENT.indexOf('router.use(rejectSqlKeys)');
    assert.ok(mount > -1, 'mounted');
    assert.ok(mount < firstId, "'nextcloud' would otherwise be read as a table id");
    assert.ok(sqlGate < mount, 'the SQL refusal comes first');
    // Bewust brontekst, zoals de bestandskop zegt: dezelfde techniek en reden
    // als routes/datatables.test.js.
    assert.match(PARENT, /require\('\.\.\/datatablesNextcloud'\)\(\{ publicTable \}\)/, 'built with the parent projection, not a copy');
});

test('linking carries no feature flag of its own — it is a capability of the Nextcloud connection', () => {
    assert.doesNotMatch(SRC, /requireBetaFeature/);
    // Bewust brontekst: een afwezige feature-vlag is een eigenschap van de
    // code, niet van gedrag dat aanroepen kan laten zien.
    assert.doesNotMatch(PARENT, /nextcloud_datatables/);
});

test('every route resolves the principal and the scope through the same chain POST / spells out', () => {
    for (const [verb, p] of [['get', '/linkable'], ['get', '/describe'], ['post', '/link']]) {
        const body = routeBody(verb, p);
        assert.match(body, /resolveDatatablePrincipal\(req\)/, `${p}: principal`);
        assert.match(body, /resolveScope\(req, res, principal/, `${p}: scope`);
    }
    const scope = SRC.slice(SRC.indexOf('async function resolveScope'), SRC.indexOf('function makeNextcloudRouter'));
    assert.match(scope, /assertUserCanUseOrg\(req, principal\.orgId\)/);
    assert.match(scope, /hasPermission\(principal\.userId, Permissions\.MANAGE_DATATABLES, req\.session\)/);
    assert.match(scope, /code: 'bad_scope'/);
    assert.match(scope, /code: 'no_organisation'/);
});

test('the router builds no SQL and touches no engine', () => {
    assert.doesNotMatch(SRC, /SELECT .* FROM/i);
    assert.doesNotMatch(SRC, /datatableDbStore/);
    assert.doesNotMatch(SRC, /queryCompiler/);
});

test('a link answers 201, a partial link 207, and every engine refusal by status and code', () => {
    const body = routeBody('post', '/link');
    assert.match(body, /out\.partial \? 207 : 201/);
    assert.match(body, /publicTable\(t, 'owner'\)/);
    const answer = SRC.slice(SRC.indexOf('function answer'), SRC.indexOf('async function resolveScope'));
    assert.match(answer, /isNextcloudSourceError\(e\)/);
    assert.match(answer, /body\.code = e\.code/);
    assert.match(answer, /body\.ncTableId/);
    assert.match(answer, /body\.datatableId/);
});

test('the per-table mirror routes sit in the parent, at the right grades, and refuse a non-mirror as 404', () => {
    const at = (verb, p) => { const i = PARENT.indexOf(`router.${verb}('${p}'`); assert.ok(i > -1, `${verb} ${p}`); return PARENT.slice(i, i + 400); };
    assert.match(at('get', '/:id/nextcloud'), /requireDatatableGrade\('viewer'\), requireMirror/);
    assert.match(at('post', '/:id/nextcloud/refresh'), /requireDatatableGrade\('editor'\), requireMirror/);
    // the pulse: viewer grade, and the re-check AFTER the answer went out
    const pulse = at('get', '/:id/nextcloud/pulse');
    assert.match(pulse, /requireDatatableGrade\('viewer'\), requireMirror/);
    assert.ok(pulse.indexOf('res.json(') < pulse.indexOf("kickStale(req.datatable, { reason: 'live', delayMs: 0 })"));
    assert.match(at('put', '/:id/nextcloud'), /requireDatatableGrade\('owner'\),\s*requireManageForOrgScope\(\),\s*requireMirror/);
    assert.match(at('put', '/:id/nextcloud/relations'), /requireDatatableGrade\('owner'\),\s*requireManageForOrgScope\(\),\s*requireMirror/);
    assert.match(at('post', '/:id/nextcloud/relink'), /requireDatatableGrade\('owner'\),\s*requireManageForOrgScope\(\),\s*requireMirror/);
    // Bewust brontekst: moet op ELKE mirror-route gelden, ook een die geen
    // test aandrijft — zie de bestandskop.
    assert.match(PARENT, /function requireMirror\(req, res, next\) \{\s*if \(!sources\.isSourceMirror\(req\.datatable\)\) return res\.status\(404\)/);
});

test('the row writes branch to the mirror engine AFTER the pinned refusals and BEFORE the compile', () => {
    const body = (verb, p) => { const i = PARENT.indexOf(`router.${verb}('${p}'`); const rest = PARENT.slice(i); const n = rest.search(/\nrouter\.(get|post|put|delete|use)\(/); return n === -1 ? rest : rest.slice(0, n); };
    const put = body('put', '/:id/rows/:rowId');
    assert.ok(put.indexOf("code: 'expected_updated_at_required'") < put.indexOf('mirrorWrites().updateRow'));
    assert.ok(put.indexOf("code: 'no_values'") < put.indexOf('mirrorWrites().updateRow'));
    assert.ok(put.indexOf('mirrorWrites().updateRow') < put.indexOf('queryCompiler.compileUpdate('));
    const post = body('post', '/:id/rows');
    assert.ok(post.indexOf('assertQuota(req, { addRows: 1 })') < post.indexOf('mirrorWrites().insertRow'));
    assert.ok(post.indexOf('mirrorWrites().insertRow') < post.indexOf('queryCompiler.compileInsert('));
    const del = body('delete', '/:id/rows/:rowId');
    assert.ok(del.indexOf("assertCanWrite(meta, req.datatableGrade, 'delete')") < del.indexOf('mirrorWrites().deleteRow'));
    assert.ok(del.indexOf('mirrorWrites().deleteRow') < del.indexOf('queryCompiler.compileDelete('));
    // the mirror never calls bumpAfterWrite from the route: the engine does
    for (const b of [put, post, del]) {
        const branch = b.slice(b.indexOf('sources.isSourceMirror(req.datatable)'), b.indexOf('queryCompiler.compile'));
        assert.doesNotMatch(branch, /bumpAfterWrite/);
    }
});

test('the schema route refuses a source-managed table before it parses anything; PATCH refuses retention and own-scope', () => {
    const schema = PARENT.slice(PARENT.indexOf("router.put('/:id/schema'"), PARENT.indexOf("router.get('/:id/health'"));
    assert.ok(schema.indexOf("code: 'schema_from_source'") < schema.indexOf('normalizeFields('));
    const patch = PARENT.slice(PARENT.indexOf("router.patch('/:id'"), PARENT.indexOf("router.put('/:id/schema'"));
    assert.match(patch, /'mirror_no_retention'/);
    assert.match(patch, /'mirror_row_scope'/);
    const managed = PARENT.slice(PARENT.indexOf("router.post('/managed'"), PARENT.indexOf("router.get('/:id'"));
    assert.match(managed, /code: 'kind_needs_link'/);
});

test('the projection ships source and sync, never the column map or the instance id', () => {
    const fn = PARENT.slice(PARENT.indexOf('function publicSource'), PARENT.indexOf('function scopeDescriptor'));
    assert.doesNotMatch(fn, /columnMap/);
    assert.doesNotMatch(fn, /ncInstanceId/);
    assert.match(fn, /relations:/);
    const table = PARENT.slice(PARENT.indexOf('function publicTable'), PARENT.indexOf('function publicSource'));
    // the kind rides along so a form's answers table (no registry entry)
    // gets its own projection — the mirror half is unchanged
    assert.match(table, /source: publicSource\(t\.source, t\.managedKind\)/);
    assert.match(table, /sync: t\.syncState \|\| null/);
});

test('the rows list kicks a stale mirror behind its answer', () => {
    const i = PARENT.indexOf("router.get('/:id/rows'");
    const body = PARENT.slice(i, PARENT.indexOf("router.get('/:id/rows/:rowId'"));
    assert.ok(body.indexOf('res.json({') < body.indexOf("kickStale(req.datatable, { reason: 'view' })"));
});
