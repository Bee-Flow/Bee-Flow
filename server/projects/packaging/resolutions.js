/**
 * What the INSTALLER supplies that the Blueprint deliberately did not carry.
 *
 * ── Why there is a second input to an install at all ───────────────────────
 *
 * scrub.js empties three things on the way OUT, each because it names a row in
 * one organisation: an `http_request` step's `auth.connectionId`, an approval
 * step's seats, and a `datatable` step's `datatableId` (the author's own
 * `datatableKey` is left standing, because it is a slug rather than an id and
 * it is the only thing that lets the far side re-link instead of guessing).
 *
 * Until now nothing put them back. An installed Solution arrived with steps
 * that could not run and no screen that said which ones — which is the failure
 * the install wizard exists to end. `resolutions` is what its Connect step
 * collects, and this module is the only place that turns it into definition
 * edits.
 *
 * ── The one rule that makes this safe ──────────────────────────────────────
 *
 * A RESOLUTION ONLY EVER FILLS A HOLE. It never overwrites a step that already
 * names a connection, a table or an approver. That is `rebindDatatables`' rule
 * 1 generalised to the other two kinds, and it is what stops a hand-edited
 * manifest plus a crafted resolution from quietly RE-POINTING a write that the
 * file appeared to have wired up. What the reader saw on step 1 of the wizard
 * is what installs.
 *
 * ── What this module does NOT check, and why that is right ─────────────────
 *
 * It does not verify that the installer may use the connection, the table or
 * the seat they picked. An id here is a POINTER, not a grant, and every use of
 * one is authorised at run time against whoever the run belongs to:
 *
 *   - connections → integrationConnectionStore.authorizeConnectionUse, called
 *     from core/automationRunner/httpAuth.js before a header is ever rendered;
 *   - tables      → gradeForPrincipal, called from
 *     core/automationRunner/datatableResolve.js on every step;
 *   - seats       → the approval routes resolve the seat against the run.
 *
 * Re-implementing those here would be a second opinion about permissions that
 * could drift from the first, and the first is the one that decides. A pointer
 * the installer may not follow produces a named run-time refusal, which is the
 * behaviour a wrong pick should have.
 *
 * What IS enforced here is shape: anything this module does not recognise is
 * DROPPED rather than passed along, so a request body cannot smuggle a fourth
 * kind of edit into a definition by inventing a key.
 *
 * ── There is no `slug` row, deliberately ──────────────────────────────────
 *
 * The plan lists one. The product has nowhere to put it: `webpages` has no
 * slug column (stores/webpage/webpages.js createWebpage), and the one slug an
 * automation can have is its inbound webhook's, which the server generates and
 * nobody picks. A wizard row that collected a slug would collect it into
 * nothing, so the wizard does not offer one.
 */

'use strict';

const { walkAllSteps } = require('../../automation/portability');

/** The four seat fields scrub.js empties. Kept in step with AUTOMATION_SEAT_FIELDS. */
const SEAT_FIELDS = ['assignee', 'approvers', 'escalateTo', 'finalApprover'];

function str(v) {
    return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}

function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * One approval seat: exactly one person or exactly one group.
 *
 * The same shape automation/validate/stepRules.js `seatShapeOk` accepts, and
 * rebuilt key by key rather than passed through — a seat object carrying extra
 * fields would land in a definition that the validator then refuses, and the
 * install would have written something nobody can save.
 */
function normalizeSeat(raw) {
    if (!isObject(raw)) return null;
    const userId = str(raw.userId);
    if (userId) return { userId };
    const groupId = str(raw.groupId);
    if (groupId) return { groupId };
    return null;
}

/**
 * Read a resolutions body into the three shapes install acts on.
 *
 * Fail-closed by construction: `out` is built from a fixed key set, so a body
 * naming `grants`, `slugs` or anything else invented later contributes nothing
 * instead of arriving unexamined at a store.
 */
function normalizeResolutions(raw) {
    const out = { tables: [], connections: [], approvers: [] };
    if (!isObject(raw)) return out;

    const seenTableKeys = new Set();
    for (const row of (Array.isArray(raw.tables) ? raw.tables : [])) {
        if (!isObject(row)) continue;
        const key = str(row.key);
        // Two rows for one key is a contradiction, not a preference: the first
        // one wins and the rest are dropped, the same way rebindDatatables
        // refuses to choose between two tables with the same key.
        if (!key || seenTableKeys.has(key)) continue;
        const datatableId = str(row.datatableId);
        if (datatableId) { seenTableKeys.add(key); out.tables.push({ key, datatableId }); continue; }
        if (row.create === true) { seenTableKeys.add(key); out.tables.push({ key, create: true }); }
    }

    for (const row of (Array.isArray(raw.connections) ? raw.connections : [])) {
        if (!isObject(row)) continue;
        const ref = str(row.ref);
        const stepId = str(row.stepId);
        const connectionId = str(row.connectionId);
        if (!ref || !stepId || !connectionId) continue;
        out.connections.push({ ref, stepId, layerKey: str(row.layerKey), connectionId });
    }

    for (const row of (Array.isArray(raw.approvers) ? raw.approvers : [])) {
        if (!isObject(row)) continue;
        const ref = str(row.ref);
        const stepId = str(row.stepId);
        const seat = normalizeSeat(row.seat);
        if (!ref || !stepId || !seat) continue;
        out.approvers.push({ ref, stepId, layerKey: str(row.layerKey), seat });
    }

    return out;
}

/** A step's address inside one bundled routine. `null` layer = the root graph. */
function addressOf(stepId, layerKey) {
    return `${layerKey || ''}\u0000${stepId}`;
}

function indexByAddress(rows, ref) {
    const byAddress = new Map();
    for (const row of rows) {
        if (row.ref !== ref) continue;
        const key = addressOf(row.stepId, row.layerKey);
        if (!byAddress.has(key)) byAddress.set(key, row);
    }
    return byAddress;
}

/**
 * Put the installer's connections and approvers into ONE bundled routine.
 *
 * Runs on the definition BEFORE `rekeyDefinition`, because the addresses in a
 * resolution are the step ids the wizard read off the manifest and rekeying
 * replaces every one of them.
 *
 * Mutates `definition`, and reports every row it did and did not use — an
 * unused resolution means the wizard and the file disagreed about what is in
 * there, and that is worth a sentence rather than a silent no-op.
 *
 * @returns {{applied: Array<object>, ignored: Array<object>}}
 */
function applyStepResolutions(definition, ref, resolutions) {
    const applied = [];
    const ignored = [];
    const connections = indexByAddress(resolutions.connections || [], ref);
    const approvers = indexByAddress(resolutions.approvers || [], ref);
    if (!isObject(definition) || (connections.size === 0 && approvers.size === 0)) {
        return { applied, ignored };
    }

    const used = new Set();
    walkAllSteps(definition, (step, layerKey, isTrigger) => {
        if (isTrigger || !isObject(step)) return;
        const address = addressOf(str(step.id), layerKey);

        const connection = connections.get(address);
        if (connection) {
            used.add(connection);
            // Only a hole is filled. `auth: null` is exactly what scrub.js
            // leaves behind when it removes a connection, and `undefined` is a
            // step that never had one; anything else is a step that already
            // names a credential and must not be re-pointed.
            if (step.type === 'http_request' && (step.auth === null || step.auth === undefined)) {
                step.auth = { connectionId: connection.connectionId };
                applied.push({ kind: 'connection', ref, stepId: connection.stepId, layerKey: connection.layerKey });
            } else {
                ignored.push({
                    kind: 'connection', ref, stepId: connection.stepId, layerKey: connection.layerKey,
                    why: step.type !== 'http_request' ? 'not_an_http_step' : 'already_connected',
                });
            }
        }

        const approver = approvers.get(address);
        if (approver) {
            used.add(approver);
            const config = step.approval;
            if (step.type !== 'approval' || !isObject(config)) {
                ignored.push({
                    kind: 'approver', ref, stepId: approver.stepId, layerKey: approver.layerKey,
                    why: 'not_an_approval_step',
                });
            } else if (SEAT_FIELDS.some(f => config[f] !== undefined && config[f] !== null)) {
                // The file already names somebody. Filling a seat here would
                // add a second decision-maker to a step that has one.
                ignored.push({
                    kind: 'approver', ref, stepId: approver.stepId, layerKey: approver.layerKey,
                    why: 'already_seated',
                });
            } else {
                // `assignee` and nothing else: a single approver is the only
                // seat shape that needs no second choice from the installer,
                // and stepRules refuses assignee together with a panel.
                config.assignee = { ...approver.seat };
                applied.push({ kind: 'approver', ref, stepId: approver.stepId, layerKey: approver.layerKey });
            }
        }
    });

    for (const row of [...connections.values(), ...approvers.values()]) {
        if (used.has(row)) continue;
        ignored.push({
            kind: row.connectionId ? 'connection' : 'approver',
            ref, stepId: row.stepId, layerKey: row.layerKey, why: 'no_such_step',
        });
    }

    return { applied, ignored };
}

module.exports = {
    SEAT_FIELDS,
    normalizeSeat,
    normalizeResolutions,
    applyStepResolutions,
};
