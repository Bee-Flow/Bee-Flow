// @typecheck
/**
 * Who may read and write the rows of a datatable — ONE implementation, two
 * callers.
 *
 * The HTTP API asks on behalf of a signed-in person; the automation runner asks
 * on behalf of a run. If those two ever answered differently, an automation could
 * write rows its author cannot see. So both go through `gradeForPrincipal`, and
 * the middleware below is a thin Express wrapper over it — not a second copy of
 * the rules.
 *
 * The same applies one level down, to the principal itself:
 * `resolveDatatablePrincipal` is the only place an HTTP caller may get "which
 * org, which role, which groups" from. Three routers each hand-rolled that and
 * each read it off `req.session.user`, where it is absent for nearly every
 * signed-in person — see the note on the resolver.
 *
 * ── THE GRADE LADDER ────────────────────────────────────────────────
 * Deliberately the vocabulary that already ships: auth/projectAccess.js's
 * `ROLE_ORDER = { viewer: 0, editor: 1, owner: 2 }`. This product already has
 * four names for a reusable sub-flow; it does not need a fifth pair of words
 * for "can read" and "can write".
 *
 *   viewer  run find_rows; read rows in the UI
 *   editor  + every write operation
 *   owner   + schema, sharing, retention, erase, delete
 *
 * `owner` is DERIVED (the creator, or an org admin of that same org) and is
 * never stored as a grant — datatable_grants only carries viewer/editor.
 *
 * ── PERSONAL TABLES ARE DENY-BY-DEFAULT ─────────────────────────────
 * A table whose scope is `('user', <userId>)` grades `owner` for that account
 * and `null` for everyone else — org admins and super-admins included. That is
 * RULE 0 below, and it RETURNS rather than falling through, so no later rule
 * can widen it. A personal table cannot be published or granted either; the
 * routes refuse both with `personal_table_not_shareable`, which is what keeps
 * this rule from being reachable-but-pointless.
 *
 * ── READ AND WRITE ARE TWO DIFFERENT MECHANISMS ─────────────────────
 * `shared_groups: []` means ENTIRE ORG, not "nobody" — auth/audience.js:52, and
 * the same rule is repeated at execFlow.js:452 and studioAppStore.js:757. If
 * one column governed both, publishing a table to the organisation would
 * silently make it org-WRITABLE. So a write is never inferred from
 * `shared_groups`: it comes from an explicit grant, or from the table opting in
 * with `write_mode: 'audience'`, which is a separate auditable act on a
 * separate column.
 *
 * ── WHY THIS DOES NOT JUST CALL canSeePublished FOR EVERYTHING ──────
 * `auth/audience.canSeePublished` grants a super-admin (`orgIds === null`)
 * access to every entity. That is right for a support tool browsing app
 * metadata and wrong for the rows of a tenant's HR table in a privacy product,
 * so org isolation is checked FIRST here and a cross-org principal is refused
 * before any other rule runs. See the open question in the design notes: this
 * means Bee Flow support cannot read a customer's datatable without being a
 * member of that organisation, which is the intended trade.
 */

'use strict';

const { ROLE_ORDER } = require('./projectAccess');
const { isOrgAdminRole } = require('./permissions');
const { canSeePublished, resolveAudienceContext } = require('./audience');
const userStore = require('../stores/userStore');
const { orgScope, userScope } = require('../stores/datatableStore');

/** Grades, weakest first. Re-exported so callers compare through one order. */
const GRADES = Object.freeze(['viewer', 'editor', 'owner']);

function rank(grade) {
    return Object.hasOwn(ROLE_ORDER, grade) ? ROLE_ORDER[grade] : -1;
}

/** Does `grade` meet `minGrade`? A null/unknown grade never does. */
function gradeAtLeast(grade, minGrade) {
    return rank(grade) >= 0 && rank(grade) >= rank(minGrade);
}

function parseSharedGroups(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
    }
    return [];
}

/**
 * The grade a principal holds on a table.
 *
 * @param {object} table    a `datatables` row
 * @param {Array}  grants   the `datatable_grants` rows for THAT table
 * @param {object} principal
 *   @param {string}   principal.userId
 *   @param {string}   principal.orgId          the RUN's organisation (ctx.orgId), or the session's
 *   @param {string[]} principal.groupIds       fresh from the DB, never req.session.user.groups
 *   @param {string}   principal.orgRole        users."orgRole"
 *   @param {string}   principal.organizationId the user's HOME organisation
 * @returns {'owner'|'editor'|'viewer'|null}
 */
function gradeForPrincipal(table, grants, principal) {
    if (!table || !principal || !principal.userId) return null;

    // 0. A PERSONAL table belongs to one account and to nobody else.
    //
    //    Evaluated before everything, and it returns rather than falls through:
    //    an org admin, a super-admin, a group grant and a published flag are all
    //    irrelevant here. "Personal, except an administrator can read it" is not
    //    personal, and n8n's Personal project — the shape this copies — says the
    //    same in as many words. There is no way to reach this branch and come
    //    back with a grade unless you ARE the account.
    if (table.scope_kind === 'user') {
        return (table.scope_id && table.scope_id === principal.userId) ? 'owner' : null;
    }

    // 1. Org isolation is structural and comes first — before ownership, before
    //    org-admin, before any audience rule. No principal of any kind reaches
    //    the rows of another organisation's table.
    if (!table.organization_id || table.organization_id !== principal.orgId) return null;

    // 2. The creator.
    if (principal.userId === table.owner_user_id) return 'owner';

    // 3. An org admin OF THIS ORGANISATION.
    //
    //    The second conjunct is not optional. users."orgRole" is a global
    //    column, and the house anchors it to users."organizationId"
    //    (permissions.js _evalOrgAdmin). principal.orgId is the RUN's org.
    //    Without the anchor, someone whose employer changed would carry an
    //    org-B admin role into an org-A table.
    if (isOrgAdminRole(principal.orgRole) && principal.organizationId === table.organization_id) {
        return 'owner';
    }

    // 4. The strongest explicit grant.
    let best = null;
    const groupIds = Array.isArray(principal.groupIds) ? principal.groupIds : [];
    for (const g of (Array.isArray(grants) ? grants : [])) {
        if (!g || !GRADES.includes(g.grade)) continue;
        const matches = (g.grantee_type === 'user' && g.grantee_id === principal.userId)
            || (g.grantee_type === 'group' && groupIds.includes(g.grantee_id));
        if (matches && rank(g.grade) > rank(best)) best = g.grade;
    }
    if (best === 'editor') return 'editor';

    // The audience rules below need the same shape canSeePublished expects.
    // orgIds is a one-element Set, never null: null is its super-admin bypass
    // and rule 1 has already decided that question.
    const audience = {
        userId: principal.userId,
        orgIds: new Set([principal.orgId]),
        userGroups: groupIds,
    };
    // canSeePublished treats `owner_id`/`tenant_id` as ownership; a datatable's
    // owner column is neither, and rule 2 covered it, so pass a shape that
    // cannot accidentally match.
    const entity = {
        is_published: !!table.is_published,
        organization_id: table.organization_id,
        shared_groups: parseSharedGroups(table.shared_groups),
    };

    // 5. Write-by-audience — the explicit opt-in. Never inferred from sharing.
    if (table.write_mode === 'audience' && canSeePublished(entity, audience)) return 'editor';

    // 6. A viewer grant, or the read audience.
    if (best === 'viewer') return 'viewer';
    if (canSeePublished(entity, audience)) return 'viewer';

    return null;
}

/**
 * The principal, built fresh from the database — the ONE resolver every HTTP
 * caller uses. Nothing here reads `organizationId`, `orgRole` or `groups` off
 * `req.session.user`.
 *
 * That is not caution, it is the whole point. auth/sessionShapes.contract.test.js
 * freezes the login shapes, and only two of them (the connector JWT and the
 * auto-login straight after password signup) ever put `organizationId` on the
 * session. Password login, OPAQUE, every OAuth callback and the x-session-token
 * bridge build `{id, displayName, role, avatar, avatarType, isAdmin}` and
 * nothing more. So a session-derived org is null for essentially every
 * RETURNING user, member or not — which is why the datatables list came back
 * empty, the builder's table picker came back empty, and creating a table
 * answered 400 "this account is not in one".
 *
 * It is a security defect the other way round too: `orgRole` off a session is a
 * role the user may have been stripped of three months ago, and rule 3 below
 * turns an org-admin role into `owner` on every table in the org.
 *
 * The runner does its own fresh read for the same three fields — see
 * `core/automationRunner/execution.js` (runUserOrgRole / runUserHomeOrgId /
 * runUserGroupIds). The two must keep agreeing: if they drift, an automation can
 * write rows its author cannot see.
 *
 * @returns {Promise<{userId, orgId, organizationId, orgRole, groupIds, orgIds}>}
 *   `orgId` is the tenant being acted in and is what `gradeForPrincipal` isolates
 *   on; `organizationId` is the user's HOME org and is what anchors an org-admin
 *   role. They differ for a member who reaches an org only through a group — and
 *   keeping them apart is what stops such a member's stale `orgRole` from
 *   granting owner in an org they were never made an admin of.
 */
async function resolveDatatablePrincipal(req) {
    if (req && req._dtPrincipal) return req._dtPrincipal;

    const userId = req?.session?.user?.id || null;
    const audience = await resolveAudienceContext(req);

    // Een MISLUKTE lezing wordt gemeld, niet alleen verdragen.
    //
    // Verdragen blijft het gedrag: `user` blijft null, de principal degradeert
    // naar "geen org, niet in een groep, geen orgRole" en dat VERSMALT — de
    // goede richting. Maar het is als BOODSCHAP fout. Elke degradatie wijst
    // dezelfde kant op ("je hoort er niet bij"), dus de weigering die erop volgt
    // ziet eruit als een beleidskeuze terwijl in werkelijkheid niemand het kon
    // nagaan. Dezelfde redenering als `ctx.identityError` in
    // core/automationRunner/datatableResolve.js, waar het een aparte foutklasse
    // krijgt in plaats van `datatable_forbidden`.
    //
    // ADDITIEF: alleen een extra veld op de principal. `gradeForPrincipal` leest
    // het niet, en de routers die de principal gebruiken evenmin — die houden
    // exact het gedrag dat ze hadden. De ene lezer is
    // appStudio/datatableSource.js, waar een app die een Studio-tabel toont er
    // een 503 van maakt in plaats van een 403.
    let user = null;
    let identityError = null;
    try {
        user = userId ? await userStore.getUser(userId) : null;
    } catch (e) {
        identityError = `the account could not be read (${e && e.message})`;
    }

    // Truthiness, never `IS NOT NULL`: stores/user/users.js createUser writes
    // `organizationId || ''`, so an org-less account holds the EMPTY STRING.
    // A null check would hand '' on as if it were a real tenant key.
    const homeOrgId = user?.organizationId || null;

    // Same fallback as routes/studioApps.resolveOwnerOrgId, deliberately not
    // resolvePrimaryOrgId/resolveUserOrgIds: those return null for a
    // super-admin, and a super-admin who IS a member of an org still has to
    // reach that org's tables.
    let orgId = homeOrgId;
    if (!orgId) {
        const groups = Array.isArray(user?.groups) ? user.groups
            : (() => { try { return JSON.parse(user?.groups || '[]'); } catch { return []; } })();
        if (groups.length > 0) {
            try {
                const allGroups = await userStore.getAllGroups();
                const g = (allGroups || []).find(x => x && groups.includes(x.id) && x.organizationId);
                orgId = g?.organizationId || null;
            } catch (e) {
                // Ook hier: verdragen én melden. Deze tak is de enige manier
                // waarop een org-loos account zijn organisatie vindt, dus een
                // storing hier laat hem als tenantloos gelden.
                identityError = identityError || `the groups could not be read (${e && e.message})`;
            }
        }
    }

    const principal = {
        userId,
        orgId,
        organizationId: homeOrgId,
        orgRole: user?.orgRole || null,
        groupIds: Array.isArray(audience.userGroups) ? audience.userGroups : [],
        // Every org the caller can reach (null = super-admin, audience.js's
        // bypass). Not used for tenancy here — kept so the org picker has it.
        orgIds: audience.orgIds,
        // null = alles is echt gelezen. Een string zegt WAT er niet gelezen kon
        // worden, zodat een aanroeper "ik weet het niet" kan onderscheiden van
        // "je mag het niet". Zie de catch-takken hierboven.
        identityError,
    };
    // Memoised per request: a route chain resolves the principal in the gate and
    // again in the handler, and this costs three user reads.
    if (req) { try { req._dtPrincipal = principal; } catch (_) { /* frozen req */ } }
    return principal;
}

/**
 * Dezelfde principal, maar voor een consument die GEEN sessie heeft.
 *
 * De webpagina-brug draait in een sandbox-iframe zonder cookie: wie er kijkt
 * staat in de `v`-claim van het preview-token, niet in `req.session`. Alles
 * wat `resolveDatatablePrincipal` uitrekent komt sowieso uit een VERSE
 * databaselezing (home-org, orgRole, groepen) — de sessie levert alleen het
 * gebruikers-id — dus dit is geen tweede implementatie maar dezelfde, met een
 * minimale drager voor dat ene id.
 *
 * Bewust ZONDER de super-admin-vlaggen (`session.isAdmin` /
 * `session.user.role`): die zetten `orgIds` op null (de bypass van audience.js).
 * Zonder sessie is die claim niet te controleren, en onbekend moet versmallen —
 * een super-admin krijgt hier dus gewoon zijn eigen organisaties. `orgIds`
 * speelt in `gradeForPrincipal` geen rol, dus de graad blijft identiek.
 */
async function resolveDatatablePrincipalForUser(userId) {
    if (typeof userId !== 'string' || !userId) {
        return {
            userId: null, orgId: null, organizationId: null, orgRole: null,
            groupIds: [], orgIds: new Set(), identityError: null,
        };
    }
    return resolveDatatablePrincipal({ session: { user: { id: userId } } });
}

/**
 * Every scope this caller may address, organisation first.
 *
 * ORDER MATTERS for the id lookups that walk it: the organisation is where a
 * shared table lives and is by far the common case, so it is tried first and a
 * personal table costs a second round trip rather than the other way round.
 *
 * Both entries are always offered when both exist. Listing only the "current"
 * scope would hide a personal table from someone who later joined an
 * organisation — their own rows, invisible, with no way to reach or erase them.
 */
function datatableScopesFor(principal) {
    const out = [];
    if (principal?.orgId) out.push(orgScope(principal.orgId));
    if (principal?.userId) out.push(userScope(principal.userId));
    return out;
}

/**
 * Where a NEW table goes when the caller does not say.
 *
 * An organisation if there is one, the account otherwise — never a guess
 * between two organisations. A member of several picks explicitly from the
 * `orgIds` the resolver already returns.
 */
function defaultCreateScope(principal) {
    if (principal?.orgId) return orgScope(principal.orgId);
    if (principal?.userId) return userScope(principal.userId);
    return null;
}

/**
 * DE graadrekenkunde: twee graden versmallen tot één. Het MINIMUM, nooit de unie.
 *
 * Eén implementatie, want dit is de regel die stilletjes uit elkaar loopt. Een
 * unie zou twee graden OPTELLEN: mag de één lezen en de ander schrijven, dan
 * levert de unie schrijfrecht op dat geen van beiden alleen had — precies het
 * lek dat de moduledoc bovenaan noemt ("an automation could write rows its author
 * cannot see").
 *
 * De null-tak is strenger dan het minimum alleen. `rank` geeft -1 voor alles wat
 * geen graad is en dat zou hier ook al het kleinste zijn, maar het ANTWOORD moet
 * `null` blijven en niet een graadnaam: "geen graad" en "de laagste graad" zijn
 * verschillende waarden, en alleen de eerste is een weigering. De test loopt op
 * `rank(...) < 0` en niet op `!a || !b`, zodat een naam die geen graad IS
 * ('admin', 'member') ook versmalt in plaats van zichzelf terug te geven —
 * `gradeForPrincipal` levert die nooit, maar de app-kant rekent zijn plafond
 * zelf uit en dan moet "onbekend versmalt" letterlijk waar zijn.
 *
 * Twee aanroepers, en het is opzet dat het er één functie voor is:
 *   effectiveGradeForRun   — een run namens iemand anders (de runner × de
 *                            opdrachtgever).
 *   appStudio/datatableSource — een app die een Studio-tabel toont: de graad
 *                            van de KIJKER × die van de app-eigenaar, daarna
 *                            versmald met de app-rol en met de mode van de
 *                            koppeling. Lezen en schrijven delen die ene body.
 */
function narrowGrade(a, b) {
    if (rank(a) < 0 || rank(b) < 0) return null;
    return rank(a) <= rank(b) ? a : b;
}

/**
 * The grade for a run, which may be acting on behalf of someone else.
 *
 * `ctx.resourceOwnerUserId` already marks "this run is on behalf of a non-owner"
 * (execAi.js). When it is set and differs from the runner, the effective grade
 * is the MINIMUM of the two principals' grades — never the union. Writing the
 * rule now, while automation sharing is still unmounted, is how it avoids being
 * got wrong later.
 */
function effectiveGradeForRun(table, grants, principal, onBehalfOfPrincipal) {
    const a = gradeForPrincipal(table, grants, principal);
    if (!onBehalfOfPrincipal || onBehalfOfPrincipal.userId === principal.userId) return a;
    const b = gradeForPrincipal(table, grants, onBehalfOfPrincipal);
    return narrowGrade(a, b);
}

/**
 * The grade, expressed as the `tableMeta.access` descriptor the data engine
 * consumes (core/dataEngine/accessFilter.resolveScope reads
 * access.roles[role][action], values 'none'|'own'|'all', boolean for create).
 *
 * A table set to `row_scope: 'own'` restricts everyone below owner to the rows
 * they created — compiled to `created_by = ?viewer` by compileAccessFilter, and
 * stamped on insert by compileInsert.
 */
function synthesizeAccess(table) {
    const s = table && table.row_scope === 'own' ? 'own' : 'all';
    return {
        default: 'none',
        roles: {
            viewer: { read: s, create: false, update: 'none', delete: 'none' },
            editor: { read: s, create: true, update: s, delete: s },
        },
    };
}

module.exports = {
    ROLE_ORDER,
    GRADES,
    gradeAtLeast,
    gradeForPrincipal,
    resolveDatatablePrincipal,
    resolveDatatablePrincipalForUser,
    datatableScopesFor,
    defaultCreateScope,
    narrowGrade,
    effectiveGradeForRun,
    synthesizeAccess,
};
