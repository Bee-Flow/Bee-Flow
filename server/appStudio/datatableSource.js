/**
 * App Studio — the SECOND kind of table: a model table whose rows are in a
 * STUDIO DATATABLE (`model.tables[].source = {kind:'datatable', …}`).
 *
 * ── WHY THIS IS ITS OWN DECISION ────────────────────────────────────
 * An ordinary app table lives in the database OF THE APP. That database belongs to the
 * owner, and who may see anything in it is decided by the app entirely itself
 * (rlsGateway + the `access` block of the table). A Studio datatable belongs to nobody
 * in particular: it sits in the organisation, is shared with automations and with other
 * apps, and carries its own permission ladder (auth/datatableAccess — viewer < editor < owner).
 *
 * An app that reads such a table is therefore a SECOND DOOR to data that already has a
 * lock. The app may not replace that lock; it may only add one more. Everything below
 * follows from that.
 *
 * ── RULE 1: THE GRADE IS THAT OF THE VIEWER, NEVER THAT OF THE AUTHOR ─
 * `gradeForPrincipal` is determined for the PRINCIPAL OF THE VIEWER: his organisation,
 * his groups, his orgRole, fresh from the database. The app owner is not the one asking.
 * Were the grade determined for the owner, every shared app would be a dispensing point
 * for the rights of its maker: one screen with a table binding, and everyone who may open
 * the app reads the owner's HR table.
 *
 * ── RULE 2: EFFECTIVE = MINIMUM, NEVER THE UNION ───────────────────
 * There are three answers to "what may this read do":
 *   a) the grade of the VIEWER on the datatable
 *   b) the grade of the APP OWNER on that same datatable
 *   c) what the APP ROLE of the viewer may do on this model table (the `access` block)
 * The effective grade is the MINIMUM of those three.
 *
 * a) and b) go through `auth/datatableAccess.effectiveGradeForRun` — the rule that was
 * already written out there in advance, literally (datatableAccess.js:311-317):
 *
 *     const a = gradeForPrincipal(table, grants, principal);
 *     if (!onBehalfOfPrincipal || onBehalfOfPrincipal.userId === principal.userId) return a;
 *     const b = gradeForPrincipal(table, grants, onBehalfOfPrincipal);
 *     if (!a || !b) return null;
 *     return rank(a) <= rank(b) ? a : b;
 *
 * WHY A UNION WOULD BE A LEAK HERE. A union adds two grades together: if the viewer may
 * read and the owner may write, the union yields write rights that NEITHER OF THEM HAD
 * ALONE. Applied to this door that is not theoretical — it is precisely the attack: the
 * viewer has nothing on the datatable, the owner has everything, and the union makes
 * "I may open this app" the same as "I am the owner". The MIN does the reverse: an app can
 * never hand out more than its viewer already had himself, and never more than its maker
 * had. `if (!a || !b) return null` thereby turns UNKNOWN into a refusal rather than the
 * lowest grade — "no grade" and "the lowest grade" remain different values.
 *
 * c) is the third MIN and is below in `appRoleGrade`.
 *
 * ── RULE 3: `mode:'read'` CAPS AT viewer ───────────────────────────
 * A link that says 'read' may not, even via the grade, produce write rights. The cap is
 * not symbolic: `owner` short-circuits in core/dataEngine/accessFilter.resolveScope to
 * 'all' and skips every row filter, so without the cap a `row_scope:'own'` table reached
 * through a read link would show ALL rows to whoever happened to have owner grade. With
 * the cap, everyone who comes through this door sees what a viewer sees.
 *
 * ── WHAT A READER GETS PER ROUTE ──────────────────────────────────
 * routes/studioAppData.js (logged in, `ctx.viewerId` = the session user):
 *   the viewer gets HIS OWN grade on the datatable, lowered to that of the app owner and
 *   to what his app role may do on this table. No grade on the datatable (other
 *   organisation, no grant, not in the publication audience, or someone else's personal
 *   table) = 403, not an empty list.
 *
 * routes/studioAppPublic.js (public, `ctx.role` = the reserved role `public` and
 * `ctx.viewerId` = an anonymous, server-minted visitor id):
 *   ALWAYS a refusal. An anonymous visitor is not a principal — he has no organisation,
 *   no groups and no orgRole — and the only grade left to borrow is that of the author.
 *   That is exactly what may not happen, so this path ends here with 403 and a reason. A
 *   public form that must show organisation data does that via a table of the app itself.
 *
 * ── UNKNOWN NARROWS, BUT SAYS WHY ─────────────────────────────────
 * No branch below falls back to 'viewer', and no branch gives an empty list. If the grade
 * cannot be determined — the identity cannot be read, the table is gone, the link is not
 * sound — then that is a refusal that tells WHAT could not be determined. An empty list
 * would give the same screen as "there are no rows", and that difference is the only thing
 * someone can act on. See also readError.js: a refusal is never a 404, because the runtime
 * client degrades that to "empty".
 *
 * ── READING AND WRITING, ONE DECISION ──────────────────────────────
 * `resolveDatatableRead` (dataReadRunner) and `resolveDatatableWrite` (actionExecutor/
 * records.js) are two entries to ONE body. There was briefly a second module here for the
 * write path (`datatableBinding.js`, with MIN(app owner, app role, mode) and WITHOUT the
 * viewer's own grade); it was removed as soon as it turned out to be two answers to the
 * same question. The broader of the two was not chosen: an app that writes on behalf of
 * someone who himself may do nothing on the table is precisely the door that rule 1 keeps
 * shut.
 *
 * What a WRITE adds on top of that, and nothing more:
 *   • `mode:'read'` is a REFUSAL with a reason, not a cap that happens to yield 403
 *     further on. A link saved as a read that nevertheless gets a write step must say so —
 *     a silent no-op looks to the user like a successful action, and the row that never
 *     appeared is only missed days later.
 *   • the grade must be at least `editor` (`gradeAtLeast`) — the COARSE check that
 *     core/dataEngine/accessFilter.js mentions in its module doc: the compiled predicate
 *     is NOT a write-rights check and must never pass for one.
 *   • both `access` blocks are queried PER ACTION. `appRoleGrade` below folds
 *     create/update/delete into one upper bound; a role that may add but not delete
 *     would thereby still be allowed to delete. `assertCanWrite` on the MODEL table (the
 *     app role) and on the DATATABLE (the grade) asks the question again for precisely
 *     this action.
 */

'use strict';

// Pure modules: de vocabulaire en de compiler-helft van de access-laag.
const {
    PUBLIC_ROLE_KEY,
    // The source grammar comes FROM the vocabulary, never from a copy here.
    // There was a second list ('datatable', 'read'|'readwrite') written out literally in the
    // shapeOk below; that quietly drifted out of step with validate/refs.js and
    // dataModel/modelValidate.js when a third kind or a third mode came along, and those
    // would accept it. The direction of that drift is safe (this module refuses), but it only
    // surfaces once a user opens the app.
    TABLE_SOURCE_KINDS,
    TABLE_SOURCE_MODES,
    WRITABLE_TABLE_SOURCE_MODE,
} = require('../core/dataEngine/dataModel/vocabulary');
const { resolveScope, assertCanWrite } = require('../core/dataEngine/accessFilter');
// The permission ladder itself. Deliberately NOT injectable: this is the decision, not
// a dependency of it.
const {
    GRADES,
    narrowGrade,
    gradeAtLeast,
    gradeForPrincipal,
    effectiveGradeForRun,
    synthesizeAccess,
    datatableScopesFor,
    resolveDatatablePrincipalForUser,
} = require('../auth/datatableAccess');
const { ANON_VIEWER_PREFIX } = require('./publicAccess');
const { readError } = require('./readError');

/**
 * The source of a model table, or null if the app owns its rows itself.
 *
 * `null` and `undefined` both mean "own storage" — the kind that always existed. Anything
 * that IS there is judged, even if it is not an object: quietly reading a broken link as
 * "own storage" would land on the app's database, where that table does not exist.
 */
function tableSource(table) {
    const s = table ? table.source : null;
    return (s === undefined || s === null) ? null : s;
}

/** Does this model table fetch its rows from a Studio datatable? */
function isDatatableBacked(table) {
    return tableSource(table) !== null;
}

/**
 * The MINIMUM of two grades — or null as soon as one of them is unknown.
 *
 * The arithmetic itself is `auth/datatableAccess.narrowGrade`: one implementation of
 * "narrow, never add", shared with effectiveGradeForRun. What is here around it is the
 * VOCABULARY CHECK. narrowGrade rejects a falsy value, but a truthy non-grade ('admin', a
 * role name from the app) gets `rank() === -1` and then wins as the smallest — then a
 * string comes out that is not a grade. Downstream that is closed (`resolveScope` knows
 * only viewer/editor and gives 'none'), but a grade that is not a grade should not get
 * through the door: here that is a refusal.
 */
function minGrade(a, b) {
    if (!GRADES.includes(a) || !GRADES.includes(b)) return null;
    return narrowGrade(a, b);
}

/**
 * The grade that the viewer's APP ROLE allows at most — the third MIN.
 *
 * The app role says what someone may do with THIS table in THIS app; that is in the
 * `access` block of the model table and is the mapping the author set up. If that role
 * may change the table, then 'editor' is the upper bound; otherwise 'viewer'. The app owner
 * himself (role 'owner') is not lowered here — his own grade on the datatable is then the
 * only limit that counts.
 *
 * Whether the role may READ the table at all has already been answered here:
 * dataReadRunner.requireReadableTable ran `rlsGateway.canRead(table, role)` and otherwise
 * gave 403. This function is only concerned with the upper bound.
 *
 * No role = no grade. That is the viewer who appears nowhere in the role mapping; he does
 * not get past this function, not even with a grant on the datatable — the app is then not
 * the door through which he comes in.
 */
function appRoleGrade(table, role) {
    if (typeof role !== 'string' || !role) return null;
    if (role === 'owner') return 'owner';
    const mayWrite = resolveScope(table, role, 'update') !== 'none'
        || resolveScope(table, role, 'delete') !== 'none'
        || resolveScope(table, role, 'create') === true;
    return mayWrite ? 'editor' : 'viewer';
}

/**
 * The row rule that the author attached to THIS app role for THIS model table.
 *
 * Only a non-empty string or an AST counts; anything else is not a rule. It is not validated
 * here: `PUT /api/studio-apps/:id/schema` checks every rowFilter with
 * `rlsGateway.validateRowFilter` before saving, and a rule that got past that anyway makes
 * `rowFilterToSql` fail on the read path — a refusal, never a wider read.
 */
function rowFilterForRole(table, role) {
    if (typeof role !== 'string' || !role || role === 'owner') return null;
    const rules = table && table.access && table.access.rowFilters;
    if (!rules || typeof rules !== 'object') return null;
    const rule = rules[role];
    if (typeof rule === 'string') return rule.trim() ? rule : null;
    // An AST is an object — a LIST is not. `[]` is truthy and of type 'object', and without this
    // check it would slip through as a "rule".
    return (rule && typeof rule === 'object' && !Array.isArray(rule)) ? rule : null;
}

/**
 * The principal of one user, fresh from the database — or a refusal.
 *
 * `resolveDatatablePrincipalForUser` itself swallows a failed user read
 * (`try { … } catch (_) { }`) and then delivers a principal without organisation, without
 * orgRole and without groups. That degrades to "no grade", and that is fine as an ANSWER
 * (unknown narrows) but wrong as a MESSAGE: it would tell the viewer that he has no access
 * while in reality nobody could check it. Hence a failure here gets its own refusal, with the
 * same reasoning as `datatable_identity_unavailable` in
 * core/automationRunner/datatableResolve.js.
 *
 * THREE WAYS IN WHICH THIS GOES WRONG, and all three come out here as 503. The resolver can
 * break down; it can return nothing; and — the case that was invisible for a long time — it
 * can have swallowed the user read internally and return a principal WITH a userId but
 * WITHOUT org, orgRole and groups. That last one degrades further down to "no grade" and
 * would come out as a 403 while it was a 503. Since `resolveDatatablePrincipal` REPORTS failed
 * reads (`principal.identityError`, additive, following the example of `ctx.identityError` in
 * core/automationRunner/datatableResolve.js), that branch too is visible, and here it is
 * refused instead of being handled silently as a grade that is too low.
 */
async function principalFor(userId, resolve, unavailable) {
    let principal = null;
    try {
        principal = await resolve(userId);
    } catch (_) {
        // The cause stays inside: `safe` messages go literally to the client, and a database error
        // is nothing for that side of the line.
        principal = null;
    }
    if (!principal || !principal.userId || principal.identityError) {
        throw readError(503, unavailable);
    }
    return principal;
}

/** De acties die op een gekoppelde tabel bestaan. `read` is de vierde. */
const WRITE_ACTIONS = Object.freeze(['create', 'update', 'delete']);

/**
 * Everything that ONE READ or ONE WRITE of a datatable-linked model table needs.
 * One body, two entries — see the header of this file.
 *
 * @param {object} ctx   the context ({app, viewerId, role, viewer, …}) — the read path passes
 *   the one from dataReadRunner, the write path builds the same shape
 * @param {object} table the MODEL table (with `source`), not the datatable
 * @param {object} [deps] injectable edges (stores, principal resolver) for tests
 * @param {'read'|'create'|'update'|'delete'} [action]
 * @returns {Promise<{tableMeta, grade, scopeKey, viewer, dialect, datatable}>}
 * @throws  a client-safe refusal (readError) with a reason
 */
async function resolveDatatableSource(ctx, table, deps = {}, action = 'read') {
    const isWrite = WRITE_ACTIONS.includes(action);
    if (!isWrite && action !== 'read') {
        // A caller that invents an action should not silently be treated as a reader — that would
        // skip the mode refusal below.
        throw readError(422, 'This screen asked for something a linked Studio table cannot do.');
    }
    // Lazy require, just as core/automationRunner/datatableResolve.js does it: these two pull in
    // the pg pool, and this module must stay loadable in suites that stub the database.
    const datatableStore = deps.datatableStore || require('../stores/datatableStore');
    const datatableDbStore = deps.datatableDbStore || require('../stores/datatableDbStore');
    const resolvePrincipal = deps.resolveDatatablePrincipalForUser || resolveDatatablePrincipalForUser;

    // ── de koppeling zelf ───────────────────────────────────────────
    const source = tableSource(table);
    const shapeOk = source && typeof source === 'object' && !Array.isArray(source)
        && TABLE_SOURCE_KINDS.includes(source.kind)
        && typeof source.datatableId === 'string' && source.datatableId
        // Only the modes from the vocabulary. A value that is not in it, read silently as 'read',
        // would turn a typo into a permission; anything that is not a mode is a broken link — not
        // a narrower one.
        && TABLE_SOURCE_MODES.includes(source.mode);
    if (!shapeOk) {
        throw readError(422, 'This screen reads a linked Studio table, but the link is not valid.');
    }

    // ── a `read` link does not write, and says so ─────────────
    // Before anything that touches a database: this answer does not depend on who you are or
    // on whether the table is still there, and a refusal that falls only AFTER the lookup can
    // still turn into a failure. The cap at 'viewer' further on also stays — that is the second
    // lock for a caller who someday brings in a write as `action:'read'`.
    if (isWrite && source.mode !== WRITABLE_TABLE_SOURCE_MODE) {
        throw readError(403, 'This screen is linked to a Studio table for reading only, so it cannot change rows.');
    }

    // ── RULE 1: who reads — the viewer, never the author ─────────────
    // Two independent gates for the same answer on the public route: the reserved role (what
    // the app finds of him) and the anonymous visitor id (who he is). One of them would be
    // enough; two ensure that a future route which sets only one does not pass silently.
    if (ctx && ctx.role === PUBLIC_ROLE_KEY) {
        throw readError(403, `A public page cannot ${isWrite ? 'change rows in' : 'read'} a linked Studio table.`);
    }
    const viewerId = ctx ? ctx.viewerId : null;
    if (typeof viewerId !== 'string' || !viewerId || viewerId.startsWith(ANON_VIEWER_PREFIX)) {
        throw readError(403, 'Reading a linked Studio table needs a signed-in account.');
    }
    const ownerId = ctx && ctx.app ? ctx.app.userId : null;
    if (typeof ownerId !== 'string' || !ownerId) {
        throw readError(503, 'Could not check who owns this app, so access to the linked Studio table cannot be decided.');
    }

    const viewerPrincipal = await principalFor(
        viewerId, resolvePrincipal,
        'Could not check who you are, so access to the linked Studio table cannot be decided.',
    );
    // The same principal? Then no second round: the app owner who views his own app is one
    // person, and effectiveGradeForRun also settles it that way further on.
    const ownerPrincipal = ownerId === viewerId
        ? viewerPrincipal
        : await principalFor(
            ownerId, resolvePrincipal,
            'Could not check who the app owner is, so access to the linked Studio table cannot be decided.',
        );

    // ── the table, in the scopes of the OWNER ──────────────────────
    // The author set up this link, so the table is in his organisation or his personal scope.
    // Never search globally and check afterwards — that is guessing a tenant
    // (core/automationRunner/datatableResolve.js, refusal 1). The VIEWER's scopes are not the
    // question here: that could yield a same-named table from another tenant.
    let datatable = null;
    let scope = null;
    try {
        for (const s of datatableScopesFor(ownerPrincipal)) {
            datatable = await datatableStore.getDatatable(source.datatableId, s);
            if (datatable) { scope = s; break; }
        }
    } catch (_) {
        throw readError(503, 'Could not reach the linked Studio table.');
    }
    if (!datatable) {
        // 422, not 404: a 404 becomes an empty list in the runtime client, and "the linked table no
        // longer exists" is not worth an empty screen.
        throw readError(422, 'The Studio table this screen reads is no longer available to the app owner.');
    }

    // ── REGEL 2: de graden, en het MINIMUM ervan ────────────────────
    let grants;
    try {
        grants = await datatableStore.listGrants(datatable.id);
    } catch (_) {
        // Without the grants every grade is a guess downward that comes out as the answer "no access".
        // That is the right DIRECTION but the wrong MESSAGE — see principalFor.
        throw readError(503, 'Could not check who may read the linked Studio table.');
    }

    // Calculated separately, purely so that it can say WHAT went wrong. The decision comes out
    // below from effectiveGradeForRun; these two are the reason in the refusal.
    const viewerGrade = gradeForPrincipal(datatable, grants, viewerPrincipal);
    const ownerGrade = gradeForPrincipal(datatable, grants, ownerPrincipal);
    if (!viewerGrade) {
        throw readError(403, 'You do not have access to the Studio table this screen reads.');
    }
    if (!ownerGrade) {
        throw readError(403, 'The app owner no longer has access to the Studio table this screen reads.');
    }

    // MIN(kijker, eigenaar) — nooit de unie. Zie de kop van dit bestand.
    const shared = effectiveGradeForRun(datatable, grants, viewerPrincipal, ownerPrincipal);
    // MIN met de app-rol (regel 2c) en met de koppelingsmodus (regel 3).
    const roleCap = appRoleGrade(table, ctx.role);
    const modeCap = source.mode === WRITABLE_TABLE_SOURCE_MODE ? 'owner' : 'viewer';
    const grade = minGrade(minGrade(shared, roleCap), modeCap);
    if (!grade) {
        // Reachable via `roleCap === null` — a viewer who appears nowhere in the role mapping of the
        // app. In the read path that is caught today by dataReadRunner.requireReadableTable
        // (`canRead(table, null)` is false), so this is the second brake on the same slope. It stays
        // too because a fourth MIN that someone adds later would otherwise pass `null` silently as a
        // grade, and `resolveScope(meta, null, 'read')` turns that into 'none': an empty list instead
        // of a refusal.
        throw readError(403, 'This screen may not read the Studio table behind it.');
    }

    // ── de tabelbeschrijving, mét het access-blok van de datatabel ──
    let meta = null;
    try {
        meta = await datatableStore.getTableMeta(scope, datatable.id);
    } catch (_) {
        throw readError(503, 'Could not read the layout of the linked Studio table.');
    }
    if (!meta) {
        throw readError(422, 'The Studio table this screen reads has no columns yet.');
    }
    const tableMeta = { ...meta, access: synthesizeAccess(datatable) };
    // ── the ROW RULE of the app role, on top of the grade ────────────
    //
    // `synthesizeAccess` translates the permission ladder of the DATATABLE (viewer /
    // editor, row_scope 'own'|'all'); the row filters of the MODEL fell outside it until now,
    // because the access block was replaced in its entirety. A role "only supplier X" was
    // thereby ignored without a single error message: it stored fine, validated fine, and
    // filtered nothing.
    //
    // It comes in now, UNDER the GRADE — that is the key by which the compiler searches below,
    // because `viewer.role` is the grade here. NARROW ONLY: the predicate is AND-ed by
    // accessFilter with that of the grade, so a row rule can never show more rows than the
    // ladder already allowed. `role === 'owner'` skips row filters (accessFilter), so the owner
    // of the table keeps seeing everything — exactly as with an app-owned table.
    const roleRule = rowFilterForRole(table, ctx.role);
    if (roleRule && grade !== 'owner') {
        tableMeta.access = { ...tableMeta.access, rowFilters: { [grade]: roleRule } };
    }

    // ── wat een SCHRIJVING er bovenop krijgt ────────────────────────
    if (isWrite) {
        // The coarse check. `assertCanWrite` below would also refuse a viewer (synthesizeAccess gives
        // viewer update:'none'), but core/dataEngine/accessFilter.js says in so many words that a
        // gradeAtLeast must never be removed because "the filter catches it anyway": the predicate
        // answers WHICH ROWS, not WHETHER.
        if (!gradeAtLeast(grade, 'editor')) {
            throw readError(403, 'You do not have permission to change rows in the Studio table behind this screen.');
        }
        // Two `access` blocks, PER ACTION — `appRoleGrade` folded them into one upper bound, and that is
        // too coarse for a role that may add but not delete.
        //   1. the MODEL table × the app role  — what the author allowed this role in THIS app
        //   2. the DATATABLE  × the grade     — what the table's permission ladder allows
        // Both narrow; leaving out one of the two is the leak.
        try {
            assertCanWrite(table, ctx.role, action);
            assertCanWrite(tableMeta, grade, action);
        } catch (e) {
            // AccessError carries a client-safe message but not the `safe` flag; here it gets it, so that
            // the write path knows one kind of refusal.
            throw readError(e && e.status === 400 ? 422 : 403,
                (e && e.message) || 'You do not have permission to perform this action');
        }
    }

    return {
        datatable,
        scope,
        // Never paste `${kind}:${id}` together yourself — the key is parsed by the store, and a
        // hand-made variant hashes to a DIFFERENT schema (stores/datatableDbStore.js,
        // "THE TENANT IS A SCOPE KEY").
        scopeKey: datatableDbStore.scopeKey(scope),
        // synthesizeAccess translates the grade ladder into the `access` block that the compiler reads
        // (viewer/editor + row_scope 'own'|'all'). The access block of the MODEL table belongs to the
        // app's storage and says nothing about these rows; it has already been handled above as the
        // upper bound.
        tableMeta,
        grade,
        // The viewer for the row filter. `id` is what 'own' scope compares against `created_by`. `role`
        // is deliberately the GRADE here and not the app role: within the access block of the
        // datatable the grade is the role, and a row filter that ever reads `viewer.role` must get
        // the same answer as the compiler.
        viewer: { ...(ctx.viewer || {}), id: viewerId, role: grade },
        // Datatables ALWAYS live in Postgres (see stores/datatableDbStore.js); the process-wide
        // STUDIO_APP_ENGINE concerns the app's own storage and says nothing here. A compile under the
        // wrong dialect is not a crash but silently different SQL, so the dialect is spelled out here.
        dialect: 'pg',
    };
}

/**
 * The Studio datatables that this user can reach, as a list of ids.
 *
 * The AUTHOR-TIME twin of the read above: `validate.js` checks
 * `model.tables[].source.datatableId` against this, so that the publication gate sees the
 * same tables as the runtime. Both scopes (organisation and personal) — sending only the
 * personal ones would reject a working app.
 *
 * → `null` as soon as the identity or the store cannot be read. "No list" and "an empty
 * list" are different answers: the first makes checkTableSource report the id BY NAME as a
 * warning, the second would reject every linked table on the basis of a question that
 * nobody could answer.
 */
async function listOwnerDatatableIds(ownerId, deps = {}) {
    if (typeof ownerId !== 'string' || !ownerId) return null;
    const datatableStore = deps.datatableStore || require('../stores/datatableStore');
    const resolvePrincipal = deps.resolveDatatablePrincipalForUser || resolveDatatablePrincipalForUser;
    try {
        const principal = await resolvePrincipal(ownerId);
        // A principal that was only partly readable may be missing exactly the organisation in which
        // the table sits. Then rather no list than a half one.
        if (!principal || !principal.userId || principal.identityError) return null;
        const ids = new Set();
        for (const scope of datatableScopesFor(principal)) {
            for (const dt of await datatableStore.listDatatablesForScope(scope)) {
                if (dt && typeof dt.id === 'string') ids.add(dt.id);
            }
        }
        return [...ids];
    } catch (_) {
        return null;
    }
}

/** Eén LEZING — de ingang van dataReadRunner.readPlan. */
function resolveDatatableRead(ctx, table, deps = {}) {
    return resolveDatatableSource(ctx, table, deps, 'read');
}

/**
 * One WRITE — the entry point of actionExecutor/records.js.
 *
 * The same body, the same three MINs, plus the mode refusal, `gradeAtLeast` and the two
 * `access` blocks per action. What the caller then still does is compile and execute; no
 * permission decision falls outside this function any more.
 *
 * @param {'create'|'update'|'delete'} action
 */
function resolveDatatableWrite(ctx, table, action, deps = {}) {
    return resolveDatatableSource(ctx, table, deps, action);
}

/**
 * A datatable's fields as a LINKED model table would carry them.
 *
 * Pure. A relation field on a datatable names its target by DATATABLE id (a
 * Nextcloud mirror pointing at the mirror of another table). In the model,
 * a relation names a MODEL table — so when this app links the target too, the
 * field is re-pointed at that model table; when it does not, the field is
 * degraded to `text` (the row id is still readable) and reported, so the
 * author can link the target and get the relation back.
 *
 * @returns {{ fields:Array, warnings:string[] }}
 */
function projectFieldsForModel(datatableFields, model) {
    const byDatatableId = new Map();
    for (const t of (model && Array.isArray(model.tables) ? model.tables : [])) {
        const src = t && t.source && typeof t.source === 'object' ? t.source : null;
        if (src && src.kind === 'datatable' && typeof src.datatableId === 'string') byDatatableId.set(src.datatableId, t.id);
    }
    const warnings = [];
    const fields = (Array.isArray(datatableFields) ? datatableFields : []).map((f) => {
        if (!f || f.type !== 'relation' || !f.relation || typeof f.relation.table !== 'string') return f;
        const modelTableId = byDatatableId.get(f.relation.table);
        if (modelTableId) return { ...f, relation: { ...f.relation, table: modelTableId, fk: false } };
        warnings.push(`"${f.name || f.key}" links to a Studio table this app does not link (${f.relation.table}); it is carried as text until that table is linked too.`);
        const { relation, ...rest } = f;
        return { ...rest, type: 'text' };
    });
    return { fields, warnings };
}

module.exports = {
    isDatatableBacked,
    listOwnerDatatableIds,
    projectFieldsForModel,
    resolveDatatableRead,
    resolveDatatableWrite,
    WRITE_ACTIONS,
    // test-only — de pure helften van de beslissing
    _tableSource: tableSource,
    _minGrade: minGrade,
    _appRoleGrade: appRoleGrade,
};

/**
 * @typedef {import('./actionExecutor/shared').DataModel} DataModel
 * @typedef {import('./actionExecutor/shared').DataTable} DataTable
 * @typedef {{ kind?: string, datatableId?: string, mode?: string }} TableSource  `table.source` of a linked model table
 * @typedef {import('../auth/datatableAccess').DatatablePrincipal} DatatablePrincipal
 * @typedef {NonNullable<Awaited<ReturnType<typeof import('../stores/datatableStore').getDatatable>>>} DatatableRow
 * @typedef {ReturnType<typeof datatableScopesFor>[number]} DatatableScope
 * @typedef {NonNullable<Awaited<ReturnType<typeof import('../stores/datatableStore').getTableMeta>>>} DatatableMeta
 * @typedef {{ tableMeta: DatatableMeta & { access?: unknown }, grade: string, scopeKey: string, viewer: Record<string, unknown>, dialect: 'pg', datatable: DatatableRow, scope: DatatableScope }} DatatableSourcePlan  everything one read or write of a linked table needs
 */
