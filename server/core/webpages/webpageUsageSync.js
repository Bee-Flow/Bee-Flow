// @typecheck
/**
 * The usage index, written from a WEBPAGE (`consumer_kind='webpage'`).
 *
 * `automation_datatable_usage` answers one question: WHO touches this table? For
 * automations it is written on every definition save, for knowledge bases on every source
 * change. The value `'webpage'` has been in `datatableStore.CONSUMER_KINDS` since W3 and
 * was written by nobody — this file is that writer.
 *
 * ── WHY THIS IS NOT COSMETIC ────────────────────────────────────────
 *
 * Three surfaces read that index, and all three believe what it says:
 *   - the "Used by" list of a table;
 *   - the gate that holds back a table deletion with 409;
 *   - the warning when a COLUMN is dropped (`columns`).
 * A page that is not in there is a page nobody sees when they are about to remove the
 * table beneath it. Missing rows are therefore not a backlog in a list but a silent gate.
 *
 * ── THREE RULES THAT MUST NOT SHIFT ─────────────────────────────────
 *
 * 1. A FAILED SCAN DELETES NOTHING. `reconcileUsageFor` is delete-then-insert on
 *    `(consumer_kind, id)`: whoever gives it an EMPTY list wipes all rows of that page.
 *    The binding scan can fail — the object store is down, an extra file cannot be
 *    fetched — and `readPageCode` says so with `readable:false` rather than with empty
 *    strings. Were that read here as "this page uses nothing", a fault would wipe the
 *    index and the 409 gate would stand open afterwards without anyone noticing.
 *    Unknown narrows: the old rows stay, and that is said loudly (`ok:false` + a line
 *    in the log), never silently.
 *
 * 2. IT RUNS ON EVERY SAVE, SO IT HANGS BESIDE IT. Never in the path of the save:
 *    `reconcileWebpageUsageDetached` is not awaited and never throws. An index is not
 *    worth an operation. Moreover it is DEBOUNCED (same shape as
 *    `datatableStore.notifyDatatableChanged`): the first save sets a timer, every save
 *    within it falls under it, and the pass reads the state only at the moment it fires —
 *    so the LAST state, not the first. An autosave sequence in the Code tab thus costs one
 *    scan instead of ten. It is idempotent by construction: `step_id` is `dt:<datatableId>`,
 *    one row per bound table. A line number as key would write a new `step_id` on every
 *    edit and let the index grow without bound.
 *
 * 3. A DELETED PAGE LEAVES NOTHING BEHIND. There is no FK from this index to `webpages`
 *    (another store), so nothing cleans up the rows. `listUsage` does a LEFT JOIN, and a
 *    leftover row tells a table owner that something he cannot see is using his table.
 *    Hence `purgeWebpageUsage` on the delete path — and, as a safety net, a reconcile that
 *    finds no page row any more and then cleans up itself instead of writing. Cancelling
 *    also covers the pass that was ALREADY RUNNING: `_purgeEpoch` counts per page how often
 *    there has been a purge, and a pass that comes back with an older number does not write
 *    any more. Without that, a pass that still saw the page row would write the rows back
 *    just after the deletion had removed them.
 *
 * ── THE SCOPE COMES FROM THE OWNER, NEVER FROM `organization_id` ────
 *
 * `webpages.organization_id` is NULL until a page is published for the first time to the
 * ORG (`setWebpagePublished` is the only writer; a clone sets it back to null, a public
 * address does not touch it). Tables of an org member, by contrast, are ORG-scoped from
 * their first row. Whoever derives the scope from that column therefore offers the
 * PERSONAL scope for every unpublished page — the INSERT of `reconcileUsageFor` is locked
 * on `(scope_kind, scope_id)` of the table, does not match, and writes zero rows during a
 * reconcile that calls itself successful. Exactly the same lesson as with the automations
 * (`routes/automation/crud.js`: "A datatable is scoped by organisation and needs it stored,
 * not derived").
 *
 * The source is therefore the OWNER: `resolveDatatablePrincipalForUser(page.userId)` →
 * `datatableScopesFor`, the same two scopes that the table routes themselves resolve for
 * him. There really are two — an org member reaches his organisation AND his personal
 * tables, and a page that binds one of each should index both. `reconcileUsageFor` takes
 * that list and reads per row the scope of the TABLE, so one transaction covers both.
 *
 * ── WHAT GOES INTO THE INDEX: THE UNION OF TWO SOURCES ─────────────
 *
 * A page reaches a table in two ways, and the index must know both:
 *
 *   the BINDING   `bridge_grants.tables` — the gate. Only through this may
 *                 `window.beeflowTables` read or write the table, and precisely that
 *                 route is invisible to a scan: a page that fetches its rows from its
 *                 own JS with `beeflowTables.query('tbl_x')` has no single `bf-*`
 *                 element. Without this source that would be the heaviest user who is
 *                 nowhere listed.
 *   the ELEMENT   `<bf-table source="…">` / `<bf-stat source="…">`, found by
 *                 `webpageBindings.collectUses`. This is what the author WROTE, even if
 *                 the binding is (still) absent.
 *
 * The gate is the upper bound: what is not bound cannot be read by the page in any way.
 * The union is therefore always wider than what is actually reachable, and that is the
 * right side to miss on — one row too many makes a deletion louder, one row too few makes
 * it silent.
 *
 * That is why `unresolved` from the scan may not block here either: a
 * `<bf-table source={id}>` whose address is built on the spot cannot be pointed at by the
 * scan — but on the other hand that table must be bound to work, and then it is already in
 * the binding.
 *
 * `mode` and `columns` come from the BINDING, because only that knows them: an element names
 * no columns, and whether the page may write is in the grant. Without a binding the answer
 * is `read` and no column at all — the narrow side.
 *
 * ── THE THIRD STATE: UNREADABLE GRANTS ──────────────────────────────
 *
 * The grants are read from the same page row as the scope; if that read falls over, a
 * half reconcile is not possible. Writing rows with an EMPTY column list would switch off
 * the column-drop warning for this page, which is exactly the same silent gate as rule 1.
 * Both sources readable, or write nothing.
 */
'use strict';
const { featureModule } = require('../featureModules');
const logger = require('../../telemetry/log');

/** The log prefix, so that an ops line names the path. */
const LABEL = 'Webpages';

/**
 * The key of one row within this page: one row per TABLE, not per element.
 * See rule 2 — stability across saves is the whole requirement.
 */
const STEP_PREFIX = 'dt:';

/** Zelfde venster als de live-tap op datatableStore, om dezelfde reden. */
const RECONCILE_DEBOUNCE_MS = 5000;

/** Waarom er niets is geschreven — in mensentaal, voor de logregel. */
const REASONS = Object.freeze({
    'no-id': 'no webpage id',
    'no-page': 'the page no longer exists',
    'no-scope': 'the page has neither an organisation nor an owner',
    'unreadable-code': 'the page files could not be read, so what it binds is unknown',
    'unreadable-page': 'the page row could not be read',
    'not-indexed': 'the tables it binds are in neither scope the owner can reach',
    superseded: 'the page was deleted while this pass was running',
    failed: 'the reconcile itself failed',
});

/**
 * The scopes in which this page may name tables — org first, then personal.
 *
 * See the heading: this goes via the OWNER and not via `page.organizationId`. Should that
 * lookup fall over (`identityError`, or it throws), the organisation is unknown, and
 * offering only the personal scope would silently leave an org page at zero rows. Unknown
 * narrows here to DOING NOTHING: an empty list back, which the caller reads as `no-scope`
 * and therefore as "leave the index as it is". The column on the page row is the last safety
 * net in that case — it is incomplete (NULL until publication) but never wrong.
 *
 * `webpages.user_id` is NOT NULL, so a page without an owner only exists if the row was
 * fetched from under us — and then an empty list is the honest answer.
 */
async function scopesForPage(page, deps = {}) {
    if (!page || !page.userId) return [];
    const datatableStore = deps.datatableStore || require('../../stores/datatableStore');
    const access = deps.datatableAccess || require('../../auth/datatableAccess');
    try {
        const principal = await access.resolveDatatablePrincipalForUser(page.userId);
        if (principal && principal.identityError) {
            // "I could not read the organisation" is something other than "he has
            // none". The column sometimes DOES know; if that is empty too, then there is
            // no scope we can vouch for.
            return page.organizationId
                ? [datatableStore.orgScope(page.organizationId), datatableStore.userScope(page.userId)]
                : [];
        }
        const scopes = access.datatableScopesFor(principal) || [];
        if (scopes.length) return scopes;
    } catch (_) {
        // Zelfde tak als identityError: geen gok op één scope.
        return page.organizationId
            ? [datatableStore.orgScope(page.organizationId), datatableStore.userScope(page.userId)]
            : [];
    }
    return [];
}

/**
 * Wat bindt deze pagina NU aan tabellen?
 *
 * @returns {Promise<{ok:boolean, reason:string, scopes?:Array, entries?:Array,
 *                    ownerId?:string|null, unresolved?:number, error?:string}>}
 *   `ok:false` betekent ALTIJD "laat de index staan" — nooit "schrijf een lege
 *   lijst". Het onderscheid staat in `reason`.
 */
async function collectWebpageUsage(webpageId, deps = {}) {
    if (!webpageId) return { ok: false, reason: 'no-id' };
    const webpageStore = deps.webpageStore || require('../../stores/webpageStore');
    const datatableStore = deps.datatableStore || require('../../stores/datatableStore');
    const bindings = deps.webpageBindings || require('./webpageBindings');

    let page;
    try {
        page = await webpageStore.getWebpageRaw(webpageId);
    } catch (e) {
        // A READ ERROR is not a vanished page. Were this read as 'no-page', a database
        // hiccup would clear the index of a page that simply exists.
        return { ok: false, reason: 'unreadable-page', error: e.message };
    }
    if (!page) return { ok: false, reason: 'no-page' };

    const scopes = await scopesForPage(page, { datatableStore, datatableAccess: deps.datatableAccess });
    if (!scopes.length) return { ok: false, reason: 'no-scope', ownerId: page.userId || null };

    // The OWNER reads, not the caller: the storage key of each slot hangs on the
    // owner's account. A clone is thus scanned under its NEW owner, and a save by an
    // administrator does not accidentally read an empty page.
    const ownerId = page.userId || null;
    let code;
    try {
        code = await bindings.readPageCode(ownerId, webpageId);
    } catch (e) {
        return { ok: false, reason: 'unreadable-code', ownerId, error: e.message };
    }
    if (!code || code.readable !== true) return { ok: false, reason: 'unreadable-code', ownerId };

    // `fallbackIds` stays empty: no table element has a fallback (only `<bf-agent>` does,
    // and that is a different family). A fallback that ever comes in here yields
    // `unknown-fallback` — the element then lands in `unresolved` instead of ending up in
    // the index with a guessed id, and the binding below covers it regardless.
    const uses = bindings.collectUses(bindings.scanBfElements(code), { fallbackIds: {} });
    const fromCode = (uses && uses.targets && Array.isArray(uses.targets.datatable))
        ? uses.targets.datatable : [];

    // De binding is de POORT en dus de bovengrens; zie de kop.
    const grants = typeof webpageStore.normalizeBridgeGrants === 'function'
        ? webpageStore.normalizeBridgeGrants(page.bridgeGrants)
        : (page.bridgeGrants || {});
    const boundById = new Map();
    for (const t of (Array.isArray(grants.tables) ? grants.tables : [])) {
        if (t && typeof t.datatableId === 'string' && t.datatableId) boundById.set(t.datatableId, t);
    }

    const ids = new Set(boundById.keys());
    for (const target of fromCode) {
        if (target && typeof target.id === 'string' && target.id) ids.add(target.id);
    }

    const entries = [...ids].map((datatableId) => {
        const bound = boundById.get(datatableId) || null;
        return {
            datatableId,
            stepId: `${STEP_PREFIX}${datatableId}`,
            // Only an explicit write grant makes 'readwrite' here; everything else —
            // no binding, an unknown value — is 'read'.
            mode: bound && bound.mode === 'readwrite' ? 'readwrite' : 'read',
            // What the page MAY read from this table. This is what the column-drop
            // warning reads, so an empty list here means "no column named" and never
            // "all columns".
            columns: bound && Array.isArray(bound.columns) ? [...bound.columns] : [],
        };
    });

    return {
        ok: true,
        reason: 'collected',
        scopes,
        ownerId,
        entries,
        // Elements that do bind something but cannot be pointed at. They block
        // nothing (see the heading) but do belong in the log line.
        unresolved: (uses && Array.isArray(uses.unresolved))
            ? uses.unresolved.filter(u => u && u.kind === 'datatable').length
            : 0,
    };
}

/**
 * Sets the index equal to what this page binds now.
 *
 * Never throws. The answer says whether ANYTHING has been written and why not:
 * `ok:false` means the existing rows have remained in place.
 */
async function reconcileWebpageUsage(webpageId, deps = {}) {
    const log = deps.log || console;
    if (!webpageId) return { ok: false, reason: 'no-id', written: 0 };
    const usageSync = deps.usageSync || featureModule('automation/datatableUsageSync');
    // See rule 3 in the heading: the number by which a pass notices that something was purged
    // during its read. Read before the first await, so every purge that comes afterwards
    // raises it.
    const epochAtStart = _purgeEpoch.get(webpageId) || 0;

    // One try for EVERYTHING. "Never throws" above is a promise to the save that calls it,
    // and that promise must not depend on whether every layer called underneath keeps its
    // own promise.
    try {
        const collected = await collectWebpageUsage(webpageId, deps);

        // The page is gone. This is the SAFETY NET behind purgeWebpageUsage, not the main
        // road: the delete route cleans up itself. If a reconcile still follows a deletion
        // (a debounced pass that was still running), then cleaning up is the right answer —
        // writing would put rows back for a page nobody can open any more.
        if (collected.reason === 'no-page') {
            const purged = await usageSync.purgeUsageFor('webpage', webpageId, { label: LABEL });
            return { ok: true, reason: 'no-page', written: 0, purged };
        }

        if (!collected.ok) {
            // Regel 1: zeggen, niet wissen.
            log.warn(`[${LABEL}] ${webpageId}: usage index left as-is — ${REASONS[collected.reason] || collected.reason}`);
            return { ok: false, reason: collected.reason, written: 0 };
        }

        // The page was deleted while this pass was reading. Writing on would put back the
        // rows that the purge has just removed — a ghost row that then holds back a table
        // deletion with 409 on behalf of a page nobody can open any more.
        if ((_purgeEpoch.get(webpageId) || 0) !== epochAtStart) {
            log.warn(`[${LABEL}] ${webpageId}: usage index left as-is — ${REASONS.superseded}`);
            return { ok: false, reason: 'superseded', written: 0 };
        }

        const written = await usageSync.syncUsageFor(
            'webpage', webpageId, collected.scopes, collected.entries, { label: LABEL },
        );
        if (written < 0) {
            // syncUsageFor logs the error itself; the reconcile runs in a transaction,
            // so the rows are still as they were.
            return { ok: false, reason: 'failed', written: 0 };
        }
        // ZERO rows on a NON-empty list is not a successful reconcile. The
        // INSERT is locked on the scope of the table, so this is precisely the shape in which
        // a wrong scope announces itself: the DELETE did run, the INSERT did not, and without
        // this branch it would be called `{ok:true, written:0}` and the 409 gate on every
        // named table would silently stand open. syncUsageFor already logs a line here itself;
        // what counts here is that the RESULT says so.
        if (written === 0 && collected.entries.length > 0) {
            log.warn(`[${LABEL}] ${webpageId}: ${collected.entries.length} table binding(s) but nothing indexed — ${REASONS['not-indexed']}`);
            return {
                ok: false,
                reason: 'not-indexed',
                written: 0,
                entries: collected.entries,
                unresolved: collected.unresolved || 0,
            };
        }
        // The heading promises that an address the scan cannot point at is REPORTED. It blocks
        // nothing, so it does not belong in `ok` — but without this line a page with ten
        // `<bf-table source={id}>` gave no signal at all, because the detached path throws away
        // the return value.
        if (collected.unresolved > 0) {
            log.warn(`[${LABEL}] ${webpageId}: ${collected.unresolved} table reference(s) the scan could not resolve — indexed ${written} row(s) from the bindings instead`);
        }
        return {
            ok: true,
            reason: 'reconciled',
            written,
            entries: collected.entries,
            unresolved: collected.unresolved || 0,
        };
    } catch (e) {
        log.warn(`[${LABEL}] ${webpageId}: usage index left as-is — ${REASONS.failed} (${e.message})`);
        return { ok: false, reason: 'failed', written: 0 };
    }
}

// ── the path that the routes use ──────────────────────────────────────
//
// Debounced per page, with the same shape as `datatableStore.notifyDatatableChanged`:
// the FIRST trigger sets the timer, every trigger within it falls under it, and the timer is
// removed when it fires — so a change that comes in afterwards simply sets a new one.
// The pass reads the state only at the moment it runs, so it sees the last save, not the first.

const _pending = new Map();

/**
 * How often this page has been purged.
 *
 * `cancelPendingReconcile` clears only a timer that has not yet fired — a pass that is
 * ALREADY READING cannot be cancelled that way. This number can: the pass reads it before
 * its first await and refuses to write if it has been raised afterwards. The key stays in
 * the map after the purge (a handful of bytes per deleted page, and an id never returns),
 * so that a pass which still comes out of it after the purge really sees it.
 */
const _purgeEpoch = new Map();

/** Cancel a running pass (the page is being deleted). */
function cancelPendingReconcile(webpageId) {
    const timer = _pending.get(webpageId);
    if (!timer) return false;
    clearTimeout(timer);
    _pending.delete(webpageId);
    return true;
}

/**
 * "This page has been saved." Never await, never throw — a save must not wait for this
 * and must not break on it.
 *
 * @param {string} webpageId
 * @param {{delayMs?:number}} [deps] otherwise the same deps as reconcileWebpageUsage
 */
function reconcileWebpageUsageDetached(webpageId, deps = {}) {
    if (!webpageId) return;
    const delayMs = Number.isFinite(deps.delayMs) ? deps.delayMs : RECONCILE_DEBOUNCE_MS;
    if (_pending.has(webpageId)) return;              // één pass dekt de reeks
    const timer = setTimeout(() => {
        _pending.delete(webpageId);
        Promise.resolve()
            .then(() => reconcileWebpageUsage(webpageId, deps))
            .catch(e => logger.warn(`[${LABEL}] usage reconcile failed for ${webpageId}: ${e.message}`));
    }, delayMs);
    // A waiting pass must not keep the process open on shutdown.
    timer.unref?.();
    _pending.set(webpageId, timer);
}

/**
 * The page has been deleted — remove its rows.
 *
 * First cancel the waiting pass: otherwise it could write the rows again just after they
 * have been cleaned up. Never throws; a deletion must not fail over an index.
 */
async function purgeWebpageUsage(webpageId, deps = {}) {
    if (!webpageId) return 0;
    cancelPendingReconcile(webpageId);
    // Before the purge itself: a pass that is reading RIGHT NOW must, on return, already see
    // a different number, even if the purge below takes a while.
    _purgeEpoch.set(webpageId, (_purgeEpoch.get(webpageId) || 0) + 1);
    try {
        const usageSync = deps.usageSync || featureModule('automation/datatableUsageSync');
        return await usageSync.purgeUsageFor('webpage', webpageId, { label: LABEL });
    } catch (e) {
        // The deletion itself has already happened; throwing here would give the
        // user a 500 about a page that IS gone. The rows then remain — a nuisance, but visible
        // in the log, and the next reconcile on that id clears them via the safety net.
        (deps.log || console).warn(`[${LABEL}] ${webpageId}: usage purge failed — ${e.message}`);
        return 0;
    }
}

module.exports = {
    collectWebpageUsage,
    reconcileWebpageUsage,
    reconcileWebpageUsageDetached,
    purgeWebpageUsage,
    cancelPendingReconcile,
    scopesForPage,
    STEP_PREFIX,
    RECONCILE_DEBOUNCE_MS,
    REASONS,
};
