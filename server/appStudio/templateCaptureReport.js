// @typecheck strict
'use strict';

/**
 * What a template capture (templateCapture.js) tells the author besides the
 * template: `requires`, everything the installer has to supply by hand
 * (reported, never guessed), and `warnings`, everything the capture removed
 * or could not carry, said rather than left silent.
 */

/** Validation warnings repeated to the author stop at this many lines in all. */
const MAX_WARNINGS = 12;

/**
 * @typedef {{ rule: string, field?: unknown, automationId?: string }} ScrubRecord
 * @typedef {{ tables: string[], fields: string[], rows: number, refs: number, files?: number, duplicateAliases: number }} SeedDropped
 */

/**
 * Everything the installer has to supply by hand. A knowledge base and an
 * approver are a COUNT, not ids: the connector entry carries names on purpose
 * (they are stable, and the installer supplies credentials for them); a KB id
 * is an opaque identifier of a resource in the source organisation, so
 * reporting it to the recipient would leak by the back door what the
 * definition no longer carries. The automation entry made the same call.
 * @param {{ connectorIds: string[], automationIds: unknown[], knowledgeBaseIds: unknown[], approverSeatsRemoved: number }} refs
 */
function requiresOf({ connectorIds, automationIds, knowledgeBaseIds, approverSeatsRemoved }) {
    /** @type {Array<Record<string, unknown>>} */
    const requires = [];
    if (connectorIds.length) requires.push({ kind: 'connector', ids: connectorIds });
    if (automationIds.length) requires.push({ kind: 'automation', count: automationIds.length });
    if (knowledgeBaseIds.length) requires.push({ kind: 'knowledge_base', count: knowledgeBaseIds.length });
    if (approverSeatsRemoved) requires.push({ kind: 'approver', count: approverSeatsRemoved });
    return requires;
}

/**
 * What a file's seed lost on the way in. Only the file path can drop anything
 * here (buildSeed reads rows this installation just handed it).
 * @param {SeedDropped | null} seedDropped
 * @param {number} seedCeiling
 */
function seedDroppedWarnings(seedDropped, seedCeiling) {
    /** @type {string[]} */
    const warnings = [];
    if (!seedDropped) return warnings;
    if (seedDropped.tables.length) {
        warnings.push(`${seedDropped.tables.length} seed table(s) dropped: the file seeds tables this template's data model does not contain.`);
    }
    if (seedDropped.fields.length) {
        const shown = [...new Set(seedDropped.fields)].slice(0, 5).join(', ');
        warnings.push(`${seedDropped.fields.length} seed value(s) dropped — no such column, or a type that never travels (file/computed): ${shown}.`);
    }
    if (seedDropped.rows) warnings.push(`${seedDropped.rows} seed row(s) dropped (not an object, or over the ${seedCeiling}-row per-table ceiling).`);
    if (seedDropped.refs) warnings.push(`${seedDropped.refs} relation value(s) emptied: they pointed at rows this file does not carry.`);
    if (seedDropped.duplicateAliases) warnings.push(`${seedDropped.duplicateAliases} seed row(s) reuse an alias another row already claimed; a reference to it resolves to the last one seeded.`);
    return warnings;
}

/**
 * The warnings of a capture, in the order the author reads them.
 * @param {{ stagesEmptied: number, orphanSeedRows: number, seedDropped: SeedDropped | null, seedCeiling: number,
 *   portableWarnings: string[], peopleDropped: string[], danglingDatasets: number,
 *   validationWarnings: Array<{ code: string, path: string }> }} input
 */
function captureWarnings({ stagesEmptied, orphanSeedRows, seedDropped, seedCeiling, portableWarnings, peopleDropped, danglingDatasets, validationWarnings }) {
    /** @type {string[]} */
    const warnings = [];
    // The canonicaliser drops a stage with no approvers, so a staged approval
    // does not survive the seat scrub on this path (unlike a Blueprint or an
    // automation export, which keep the emptied stage). Say so rather than let
    // the chain vanish behind the generic "seats removed" count.
    if (stagesEmptied) {
        warnings.push(`${stagesEmptied} approval stage(s) removed together with their approvers: a stage cannot exist without somebody to decide it. Rebuild the approval chain after installing.`);
    }
    // Silence would read as "the template had no rows", which is a different
    // and much more confusing thing than "nine rows in it did not belong to
    // any column this template has".
    if (orphanSeedRows) {
        warnings.push(`${orphanSeedRows} example row(s) dropped: the file carries rows but no data model to put them in.`);
    }
    warnings.push(...seedDroppedWarnings(seedDropped, seedCeiling));
    warnings.push(...portableWarnings);
    for (const what of peopleDropped) {
        warnings.push(`The demo-people declaration was dropped (${what}) — seeded rows keep the names the file carries.`);
    }
    // A binding to a dataset the template carries is pointed at the dataset the
    // install creates (templateDatasetRefs.mts); one to any other id dangles.
    if (danglingDatasets) {
        warnings.push(
            `${danglingDatasets} dataset binding(s) will not survive install: they point at datasets this template does not carry. Re-point them after installing.`,
        );
    }
    // Every OTHER validation warning is worth repeating to the author: the
    // template installs, but something in it is worth a second look.
    // `action.automation_unset` is excluded — it is the DESIRED state of a
    // captured template (automations are wired by the installer) and is already
    // reported once, as a count, under `requires`.
    for (const w of validationWarnings) {
        if (w.code === 'action.automation_unset') continue;
        warnings.push(`${w.code} @ ${w.path}`);
        if (warnings.length >= MAX_WARNINGS) break;
    }
    return warnings;
}

module.exports = { requiresOf, captureWarnings };
