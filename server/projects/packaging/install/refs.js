// @typecheck
/**
 * Turning a Blueprint's `{ $ref }`s back into real ids, and putting back what
 * the scrub emptied on the way out (the installer's resolutions).
 *
 * Split out of install.js so upgrade.js, which re-resolves the entities a newer
 * Blueprint replaces, can use these without requiring install.js: the two used
 * to require each other lazily (install -> upgrade.currentPayload, upgrade ->
 * install.resolveRefs). install.js re-exports every name here unchanged.
 */

'use strict';

const { rewriteRefs } = require('../../../core/packaging/manifest');
const { fromRefs, visitPointers, isRef } = require('../../../core/packaging/pointers');
const { walkAllSteps } = require('../../../core/packaging/walkers');
const { applyStepResolutions } = require('../resolutions');

function clone(v) {
    try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v ?? null)); }
}

/**
 * Every `{ $ref }` of one holder back to a real id: the registered pointer
 * locations through pointers.fromRefs, then the generic rewrite as a backstop
 * for a `$ref` the registry has no row for (a hand-made file), so nothing that
 * looks like a reference survives into a stored payload. Mutates `payload`;
 * every ref with no target lands in `unresolved`.
 */
function resolveRefs(holderKind, payload, refMap, unresolved, templateVersions = null) {
    const { unresolved: missed } = fromRefs(holderKind, payload, refMap);
    for (const m of missed) unresolved.push(m.ref);
    for (const key of Object.keys(payload)) payload[key] = rewriteRefs(payload[key], refMap, unresolved);
    if (holderKind === 'automation') pinTemplateVersions(payload.definition, templateVersions);
    return payload;
}

/**
 * Every `fill_document` step that names a template this install created is
 * pinned to that copy's revision (`documentVersionId`), so the automation renders
 * exactly the template it shipped with, and a stage switches template content
 * with the automation's own flip. `versionByDocId` is `ctx.templateVersions`
 * (template id → revision id); a step naming anything else is left alone.
 *
 * @param {object|null} definition  an automation definition, mutated
 * @param {Map<string, string>|null} versionByDocId
 */
function pinTemplateVersions(definition, versionByDocId) {
    if (!definition || !(versionByDocId instanceof Map) || !versionByDocId.size) return;
    walkAllSteps(definition, (step, _layerKey, isTrigger) => {
        if (isTrigger || step.type !== 'fill_document') return;
        const version = versionByDocId.get(step.documentId);
        if (typeof version === 'string' && version) step.documentVersionId = version;
    });
}

/**
 * Only the `{ $ref }`s whose target already exists, and only of the given
 * target kinds; every other ref is left for the patch pass. Used before a
 * automation's resolutions run, so a datatable step that points at a table this
 * bundle carries is already wired when `rebindDatatables` looks for holes.
 */
function resolveKnownRefs(holderKind, payload, refMap, targetKinds) {
    visitPointers(holderKind, payload, (ptr) => {
        if (!targetKinds.includes(ptr.targetKind)) return;
        const value = ptr.get();
        const real = (v) => (isRef(v) && typeof refMap.get(v.$ref) === 'string' ? refMap.get(v.$ref) : v);
        if (ptr.many) { if (Array.isArray(value)) ptr.set(value.map(real)); return; }
        const next = real(value);
        if (next !== value) ptr.set(next);
    });
}

/**
 * Put back the three things scrub.js emptied on the way out, for ONE automation.
 *
 * Connections and approvers come from the installer's `resolutions`; tables are
 * re-linked by KEY through the shared `rebindDatatables`, over the union of the
 * tables this bundle brought with it and the ones the installer picked.
 *
 * The reporting distinguishes three cases, because they need three different
 * things from the reader:
 *
 *   - bound to a table THIS INSTALL CREATED — silent. The Solution shipped that
 *     table; there is nothing for anyone to check.
 *   - bound to a table the INSTALLER PICKED — rebindDatatables' own sentence,
 *     which ends "check it is the right one before activating". Their pick, so
 *     their check.
 *   - not bound at all — always said out loud. A datatable step with no table
 *     is an automation that cannot run, and it used to arrive that way in silence.
 */
function applyResolutionsTo(definition, ref, ctx, report) {
    // `wiring` is null when nobody chose anything: a stage copy, or an
    // UPGRADE of a Solution whose install kept no choices (installed before
    // they were kept, or with none made). An upgrade has no wizard in front of
    // it, so it only ever re-applies what the installer chose at install time,
    // read back from `solution_bindings` (upgrade.js wiringFromBindings).
    if (!ctx.wiring) return [];
    const { rebindDatatables } = require('../../../automation/portability');

    const { applied, ignored } = applyStepResolutions(definition, ref, ctx.wiring.resolutions);
    for (const row of applied) {
        report.resolved.push(row);
    }
    for (const row of /** @type {Array<{ stepId: string, why: string }>} */ (ignored)) {
        report.warnings.push(
            `What you chose for step "${row.stepId}" of "${ref}" was not used (${row.why.replace(/_/g, ' ')}) — open the automation and set it there.`,
        );
    }

    const { entries } = rebindDatatables(definition, ctx.wiring.tables);
    for (const entry of entries) {
        // Silent only for a table this install created — bundled, or conjured
        // empty because the installer asked for one.
        if (entry.matches === 1 && ctx.wiring.freshTableIds.has(entry.datatableId)) continue;
        report.warnings.push(entry.message);
    }
    // The connection and approver rows that landed on a step: only those are
    // kept for later updates (persistResolutions), so an update never repeats
    // "was not used" about a choice that never applied.
    return applied;
}

module.exports = { clone, resolveRefs, pinTemplateVersions, resolveKnownRefs, applyResolutionsTo };
