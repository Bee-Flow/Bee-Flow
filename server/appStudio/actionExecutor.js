/**
 * App Studio v2 — ACTION EXECUTOR (server half of the ACTION MODEL).
 *
 * A v2 action is a { kind:'sequence', steps:[Step] } (a bare v1 action is an
 * implicit 1-step sequence). The FE coordinator (runtime/useActionRunner.js)
 * walks the steps and runs CLIENT-only kinds (navigate/toast/confirm/…, plus
 * control-flow: condition/switch/loop) in the browser. The DATA-mutating kinds
 * — the only ones that read/write persistent data — are dispatched to the
 * server ONE STEP AT A TIME and executed HERE:
 *
 *   executeDataStep(app, model, step, ctx) → { ok, result?, error?, code? }
 *     ctx = { viewerId, role, orgId, formValues, vars, item, index?, viewer? }
 *
 * Handled kinds (server-authoritative, ∈ DATA_MUTATING_STEP_KINDS):
 *   create_record / update_record — funnel through writeRecord (below), the
 *     single record-write choke point: RLS + storage quotas + queryCompiler +
 *     acts-as-owner exec + data-version/row-count bumps.
 *   delete_record — compiled by queryCompiler, scoped by rlsGateway, run
 *     acts-as-owner, then version bumped + row count decremented. Deletes are
 *     deliberately quota-free (how a full app shrinks).
 *   run_automation — owner-ownership check + executeAutomation acts-as-owner.
 *
 * SECURITY INVARIANTS
 *   • The step comes from the app DEFINITION (the route resolves it by index) —
 *     never from a client body. Only formValues/vars/item ride in from the
 *     client, and they only reach column values through authored bindings.
 *   • Column values are resolved SERVER-SIDE: `field` mappings pull from
 *     formValues, `formula` bindings are RE-EVALUATED with the shared expr
 *     engine (client-computed values are never trusted). system columns
 *     (id/created_at/updated_at/created_by/org_id) are stamped by the compiler.
 *   • RLS: assertCanWrite gates the (role, action); update/delete AND the
 *     access filter into the WHERE, so a row the viewer may not see changes 0
 *     rows and reads back as a uniform "not found" — existence never leaks.
 *   • A non-server (client-only) kind is rejected here too (defense in depth —
 *     the route already enforces DATA_MUTATING_STEP_KINDS).
 *
 * Decomposed by step family: the implementations live in ./actionExecutor/
 * (shared.js, records.js, automationBridge.js, approvalStep.js, aiSteps.js,
 * emailStep.js, fileStep.js, dispatch.js); this file re-exports the same
 * surface — same names, same function references — so every existing
 * `require('./actionExecutor')` keeps working unchanged.
 */

'use strict';

const {
    findTable, buildServerScope, resolveBinding, resolveValues,
    SERVER_SCOPE_ROOTS, SERVER_CURRENT_USER_KEYS,
} = require('./actionExecutor/shared');
const { writeRecord, writeRecordBatch, eraseRecord } = require('./actionExecutor/records');
const {
    resolveInputs, isAppTriggerAutomation, resolveAppTriggerInputs, deriveFinalOutput, deriveRunOutcome,
    MAX_FIELD_KEY_LEN, MAX_INPUT_FIELDS,
} = require('./actionExecutor/automationBridge');
const { resolveWriteMapping } = require('./actionExecutor/aiSteps');
const { executeDataStep } = require('./actionExecutor/dispatch');

module.exports = {
    executeDataStep,
    writeRecord,
    // The batch sibling — the choke point connectorSync writes every synced row
    // through, so it must be reachable from outside this module.
    writeRecordBatch,
    // Het DELETE-knooppunt. De DELETE-route compileerde zijn eigen SQL en kende
    // de tweede tabelsoort daardoor niet; nu deelt hij deze ene body met de
    // delete_record-stap.
    eraseRecord,
    // Shared with routes/studioAppsRun.js (single implementations — do not fork)
    resolveInputs,
    isAppTriggerAutomation,
    resolveAppTriggerInputs,
    deriveFinalOutput,
    deriveRunOutcome,
    MAX_FIELD_KEY_LEN,
    MAX_INPUT_FIELDS,
    // What a server-side formula may read. Exported so the validator checks
    // against the runtime's own answer rather than a second copy of the list —
    // the drift between the two is what let `currentUser.name` resolve in the
    // editor, resolve in the browser, and be empty on every row the server wrote.
    SERVER_SCOPE_ROOTS,
    SERVER_CURRENT_USER_KEYS,
    // Test-only internals
    _resolveBinding: resolveBinding,
    _resolveValues: resolveValues,
    _buildServerScope: buildServerScope,
    _findTable: findTable,
    _resolveWriteMapping: resolveWriteMapping,
};
