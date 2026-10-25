// @typecheck
/**
 * Install a Blueprint: turn a written-down Solution back into a live one.
 *
 * ── The two passes, and why there have to be two ───────────────────────────
 *
 * Entities reference each other by bundle-local `{ $ref }`, and a ref can only
 * be resolved once its target has a real id. So everything is created first,
 * building ref → id as it goes, and only then are the references patched in.
 * This is exactly the shape templateInstall.buildSeed already uses for seed-row
 * relations — one two-pass idea in the product, not two.
 *
 * ── Order within the first pass ────────────────────────────────────────────
 *
 * The project row comes first so every entity can be stamped with its
 * `project_id` at INSERT rather than patched afterwards. Then blocks and layers
 * before automations, so a `call_block` target exists before its caller.
 *
 * ── Nothing installed is live ──────────────────────────────────────────────
 *
 * An installed Blueprint must never start firing schedules and webhooks on
 * arrival. createAutomation already inserts is_active = FALSE / is_draft = TRUE,
 * so this is a guarantee of the store rather than something re-implemented
 * here — and the test asserts it rather than trusting it. Webpages are created
 * unpublished for the same reason, which is also what cloneWebpage does.
 *
 * ── One owner ──────────────────────────────────────────────────────────────
 *
 * Every entity is created under the INSTALLER. A cross-owner edge refuses at
 * the moment someone presses the button (actionExecutor and the webpage bridge
 * both run acts-as-owner), so an install that spread ownership around would be
 * born with the exact defect the Flow tab exists to surface.
 *
 * ── Missing capabilities skip, never fail ──────────────────────────────────
 *
 * A Blueprint with apps landing on an install without App Studio should install
 * its automations and say what it could not install. Refusing the whole thing
 * would make a partly-usable Solution unusable, and the `requires` entry exists
 * precisely so this can be reported rather than guessed.
 *
 * ── Best-effort, but never silent ──────────────────────────────────────────
 *
 * Every step that can fail is caught and NAMED in the report. An install that
 * half-worked and said nothing is worse than one that failed loudly.
 *
 * ── A page's bridge grants are REQUIRES, not data ───────────────────────────
 *
 * `bridge_grants` decides what a webpage's script.js may call through
 * window.beeflowAI / beeflowAutomations / beeflowIntegrations — and those
 * bridges run AS THE PAGE'S AUTHOR (core/webpages/webpageBridgeAuth.js), who
 * after an install is the INSTALLER. So a granted tool in a Blueprint is not a
 * description of the page, it is a request for authority over the account of
 * whoever presses install. It is treated the same way an app's `requires` is:
 * shown, and re-assigned by hand.
 *
 * Install therefore writes the grants it can VOUCH for and nothing else:
 *
 *   ai           the store's own default — public AI OFF, whatever the file says
 *   automations  only entries that pointed at an automation INSIDE this bundle, by
 *                `{ $ref }`, resolved to the copy this install just created
 *   tables       the same rule for tables (F14); public columns never
 *   agent        the same rule for the page's agent, or none
 *   integrations empty. Always. A tool name is authority.
 *
 * updateBridgeGrants replaces the WHOLE column with the normalizer's output, so
 * a grant kind that does not exist yet cannot arrive through this path either:
 * an unknown key in the file is dropped by normalizeBridgeGrants, and the
 * column that lands has the keys it wrote and no others. That is the narrow
 * direction on purpose — the day a new grant kind exists, an installed page
 * starts without one rather than with the file's.
 *
 * What the file asked for is NOT thrown away, it is REPORTED:
 * `collectGrantRequires` reads it off the raw manifest into `report.grantRequires`
 * so the install wizard can list it and the installer can grant it themselves,
 * with the connection status in front of them. Read off the RAW manifest and
 * not the checked copy, because sanitizeManifest has already stripped the
 * `ai.public*` keys by then — the rows exist precisely to show what was
 * stripped.
 *
 * ── What the INSTALLER supplies: `resolutions` ─────────────────────────────
 *
 * The mirror image of the paragraph above. Bridge grants are things the file
 * asks for and the install refuses; `resolutions` are things the file
 * deliberately does NOT carry and the installer hands over instead — which
 * table a step should use, which HTTP credential, who approves. The wizard's
 * Connect step collects them; projects/packaging/resolutions.js is the only
 * place that turns them into definition edits, and its one rule is that a
 * resolution fills a hole and never overwrites a step that is already wired.
 *
 * Tables are re-linked through automation/portability.rebindDatatables — the
 * same function the single-automation import uses, so "a `datatableKey` finds its
 * table" has one implementation. Both the tables this bundle brought WITH it
 * and the ones the installer picked go into the same list, which is why a
 * automation that ships alongside its own table now arrives wired rather than
 * pointing at nothing.
 */

'use strict';

const { sanitizeManifest, readSource } = require('../../core/packaging/manifest');
const { normalizeResolutions } = require('./resolutions');
const { resolveRefs, pinTemplateVersions, applyResolutionsTo } = require('./install/refs');
const { installHashOf, versionOf, makeInstallCtx, stampAll } = require('./install/context');
const { provenanceOf, verifyClaimedBlueprint } = require('./install/provenance');
const { installAutomations } = require('./install/parts/automations');
const { installApps } = require('./install/parts/apps');
const { installWebpages } = require('./install/parts/webpages');
const { installDatatables, createRequestedTables, tablesForRebind } = require('./install/parts/datatables');
const { installAgents } = require('./install/parts/agents');
const { installKnowledgeBases } = require('./install/parts/knowledgeBases');
const { skillFieldsOf, installSkills } = require('./install/parts/skills');
const { templateFieldsOf, installDocumentTemplates } = require('./install/parts/documents');
const { safeInstallGrants, collectGrantRequires } = require('./install/grants');
const { patchReferences, persistResolutions } = require('./install/patch');

/** The installer per part kind, for `installOne`. */
const INSTALLERS = Object.freeze({
    automation: (...a) => installAutomations(...a),
    block: (...a) => installAutomations(...a),
    layer: (...a) => installAutomations(...a),
    app: (...a) => installApps(...a),
    webpage: (...a) => installWebpages(...a),
    datatable: (...a) => installDatatables(...a),
    agent: (...a) => installAgents(...a),
    knowledge_base: (...a) => installKnowledgeBases(...a),
    skill: (...a) => installSkills(...a),
    document: (...a) => installDocumentTemplates(...a),
});

/**
 * Install ONE part through the same path a whole Blueprint takes (inactive on
 * arrival, one owner, filed into `ctx.projectId`, stamp collected). The stage
 * engine creates a missing part this way, with a ctx from `makeInstallCtx`
 * (`rekey: false`, the stage's scope and key rule, run-as owner, stage
 * project, and the deployment's `managedWrite`: without it the store guards
 * refuse to file a part into a stage, and the part lands in `report.skipped`
 * as 409 managed_part). Returns the new id, or null when the part was skipped
 * (the reason is in `report.skipped`).
 *
 * @param {string} kind  automation | block | layer | app | webpage | datatable | agent | knowledge_base | skill | document
 *
 * With `ctx.managedWrite` a `skill` is only COMPUTED (its id is allocated and
 * `report.computed.skills` gets `{ ref, id, fields }`; the deployment's commit
 * writes the row), and a `document` template is created in the stage with the
 * revision it is pinned to in `ctx.templateVersions`.
 */
async function installOne(kind, entity, ctx, report) {
    const install = INSTALLERS[kind];
    if (!install) throw new TypeError(`installOne: no installer for kind '${kind}'`);
    report.installed = report.installed || {};
    for (const list of ['automations', 'apps', 'webpages', 'datatables', 'agents', 'knowledgeBases', 'skills', 'documents']) {
        if (!Array.isArray(report.installed[list])) report.installed[list] = [];
    }
    for (const list of ['skipped', 'warnings', 'resolved']) if (!Array.isArray(report[list])) report[list] = [];
    if (!report.computed || typeof report.computed !== 'object') report.computed = {};
    await install([entity], ctx, report);
    return ctx.refMap.get(entity.ref) || null;
}

/**
 * Install a Blueprint as a new Solution.
 *
 * @param {object}   [input]
 * @param {Record<string, any>} [input.manifest]
 * @param {string}   [input.ownerId]          every entity is created under this person
 * @param {string}   [input.organizationId]
 * @param {string}   [input.name]           override the Blueprint's own name
 * @param {string}   [input.blueprintId]    the gallery Blueprint this came
 *   from, when the SERVER resolved one. Recorded on the project so the overview
 *   can show it under "Installed" and tell the installer a newer version
 *   exists. A file install has none here and falls back to what the file claims
 *   about itself — see provenanceOf for the difference between the two, which
 *   is the difference between established and asserted.
 * @param {string}   [input.blueprintOrgId] the organisation of that resolved
 *   Blueprint, read off the gallery row by the route. Never taken from the
 *   file when this is set, and never a grant either way.
 * @param {Function} [input.can]            capability predicate; defaults to permissive
 * @param {object}   [input.req]            the installing request. Only the
 *   knowledge-base kind needs it, and only to answer "may this person read this
 *   base" — see projects/knowledgeBaseMembership.js. Without it a base is still
 *   created and the report says it could not be filed into the project.
 * @param {object}   [input.resolutions]    what the INSTALLER supplies for the
 *   holes scrub.js left: `{ tables, connections, approvers }`. Normalised
 *   before anything reads it, so an unrecognised key contributes nothing —
 *   see projects/packaging/resolutions.js. What was used is kept as
 *   `solution_bindings` rows on the new project, so an upgrade fills the same
 *   holes the same way (F3).
 * @param {object}   [input.deps]           `{ bindings }`: the store the
 *   resolutions are kept in (default stores/solutionStageStore).
 */
async function installBlueprint({
    manifest, ownerId, organizationId = null, name = null, blueprintId = null,
    blueprintOrgId = null, can = () => true, req = null, resolutions = null, deps = {},
} = {}) {
    if (!ownerId) return { ok: false, errors: ['An installer is required.'] };

    const checked = sanitizeManifest(manifest);
    if (!checked.ok) return { ok: false, errors: checked.errors };

    const solution = checked.manifest.solution;
    const projectStore = require('../../stores/projectStore');

    const report = {
        installed: { automations: [], apps: [], webpages: [], datatables: [], agents: [], knowledgeBases: [], skills: [], documents: [] },
        computed: {},
        skipped: [],
        warnings: /** @type {string[]} */ ([]),
        // What the file asked a page to be allowed to do and this install would
        // not grant. Read off the RAW manifest, before sanitizeManifest strips
        // the `ai.public*` keys — see collectGrantRequires.
        grantRequires: collectGrantRequires(manifest),
        // Which of the installer's own choices were actually used. Empty is the
        // honest answer for an install that was handed none, and for one whose
        // choices all missed — the `warnings` say which of the two it was.
        resolved: [],
    };

    // Where this comes from, read off the CHECKED manifest: the provenance
    // block is already normalised there, so no raw file field is touched here.
    // The PROJECT's organisation stays the installer's (`organizationId`
    // below): no file moves itself into another org by writing that down.
    const claimVerified = blueprintId
        ? false
        : await verifyClaimedBlueprint({
            claimedId: readSource(checked.manifest).blueprintId,
            solutionKey: solution.key,
        });
    const provenance = provenanceOf({ blueprintId, blueprintOrgId, manifest: checked.manifest, claimVerified });

    // The project first, so every entity below is stamped at INSERT.
    let project;
    try {
        // createProject's optional fields are not declared optional.
        project = await projectStore.createProject(/** @type {any} */ ({
            name: name || solution.name || 'Installed Solution',
            description: solution.description || '',
            customInstructions: solution.customInstructions || '',
            color: solution.color || undefined,
            icon: solution.icon || undefined,
            ownerId,
            organizationId,
            // An installed Blueprint is a Studio Solution, never a
            // collaborative project: it lists under Solutions only.
            kind: 'solution',
            ...provenance,
        }));
    } catch (err) {
        return { ok: false, errors: [`The Solution could not be created: ${err.message}`] };
    }

    const ctx = makeInstallCtx({
        ownerId, organizationId, projectId: project.id, can, req, deps,
        installedVersion: versionOf(solution),
        // Everything an automation needs to arrive WIRED. An upgrade rebuilds it
        // from the bindings this install saves below (persistResolutions).
        wiring: {
            resolutions: normalizeResolutions(resolutions),
            tables: [],                 // filled in below, before any automation
            freshTableIds: new Set(),   // tables this install made itself
            createdForKey: new Map(),
            applied: [],                // connection/approver rows that landed (persistResolutions)
        },
    });

    // Tables and knowledge bases first: they are what other entities point AT,
    // and nothing points back at an automation from them.
    await installDatatables(solution.entities.datatables || [], ctx, report);
    await installKnowledgeBases(solution.entities.knowledgeBases || [], ctx, report);
    await installDocumentTemplates(solution.entities.documents || [], ctx, report);
    await createRequestedTables(ctx, report);
    ctx.wiring.tables = tablesForRebind(solution.entities.datatables || [], ctx, report);
    await installAutomations(solution.entities.automations || [], ctx, report);
    await installApps(solution.entities.apps || [], ctx, report);
    await installWebpages(solution.entities.webpages || [], ctx, report);
    // Skills after the automations and bases they link to, before the agents that attach them.
    await installSkills(solution.entities.skills || [], ctx, report);
    await installAgents(solution.entities.agents || [], ctx, report);
    await patchReferences(checked.manifest, ctx, report);
    await persistResolutions(ctx, report);
    // Last: every reference and every resolution is in place, so the hash is
    // of what the entity IS, and an untouched one reads as pristine (F2).
    await stampAll(ctx, report);

    for (const requirement of solution.requires || []) {
        report.warnings.push(`This Solution needs ${requirement.count} ${requirement.kind}(s) supplying before it will work.`);
    }

    // Said out loud, once per page, so an install that went through the plain
    // button rather than the wizard still tells somebody what is NOT wired up.
    // The rows themselves travel on `report.grantRequires`.
    // Keyed by REF, so two pages that happen to share a name each get their own
    // sentence; named by whichever of the two a reader would recognise.
    const askedPerPage = new Map();
    for (const row of report.grantRequires) {
        const key = row.ref || row.name || '';
        const seen = askedPerPage.get(key);
        askedPerPage.set(key, { label: row.name || row.ref || 'A page', n: (seen?.n || 0) + 1 });
    }
    for (const { label, n } of askedPerPage.values()) {
        report.warnings.push(
            `"${label}" asks to be allowed to do ${n} thing(s) — a tool, an automation elsewhere, or public AI. An install never grants those on your behalf: open the page and grant what it should have.`,
        );
    }

    return { ok: true, projectId: project.id, report };
}

module.exports = {
    installBlueprint,
    // Reused by upgrade for the entities a newer Blueprint ADDS — creating one
    // during an upgrade and creating one during an install are the same act,
    // and two implementations of it would drift on the details that matter
    // (inactive on arrival, one owner, filed into the project, stamped).
    installAutomations, installApps, installWebpages, patchReferences, installHashOf,
    installDatatables, installAgents, installKnowledgeBases, installSkills, installDocumentTemplates,
    // What a skill and a template are written with, and the pin of a fill_document step.
    skillFieldsOf, templateFieldsOf, pinTemplateVersions,
    // One part at a time and the deferred stamp pass: the stage engine's
    // prepare creates missing parts with these, under its own ctx.
    makeInstallCtx, installOne, stampAll, resolveRefs, applyResolutionsTo,
    // The two halves of "bridge grants are requires": what an install writes,
    // and what it refuses to write and shows instead. The install wizard reads
    // the second one to build its Connect step.
    safeInstallGrants, collectGrantRequires,
    // The other direction — what the INSTALLER supplies. Exported for the tests
    // that pin the "a resolution fills a hole, it never re-points" rule.
    tablesForRebind, createRequestedTables,
    // Where an install says it comes from: established by the server, or
    // claimed by the file. Pure, so the hostile cases can be tested on their
    // own.
    provenanceOf,
    verifyClaimedBlueprint,
};
