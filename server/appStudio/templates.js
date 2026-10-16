/**
 * App Studio — starter templates.
 *
 * Static gallery mirroring server/automation/templates.js. Each entry is
 * { id, title, description, category, icon, tags, definition } and MAY also
 * carry the OPTIONAL data-side of a template:
 *
 *   dataModel — a dataModel.js model (tables/fields/roles/access). Installed by
 *               templateInstall.js via the saveDataModel CAS seam (which runs
 *               migrationPlan → SQLite DDL). Field/table stable ids are
 *               authored here so the definition's record/records bindings
 *               resolve to them.
 *   seed      — { [tableId]: Row[] } demo rows (≤50/table). A Row is a
 *               { fieldKey: value } map; a `$id` key is a LOCAL alias (never a
 *               column) and a relation value of { $ref: '<alias>' } points at a
 *               previously-seeded row in the referenced table. templateInstall
 *               seeds PARENT tables first and rewrites $ref → the parent's real
 *               rec_ id. Every row is written through actionExecutor.writeRecord
 *               (RLS + quotas asserted; created_by = the owner).
 *   datasets  — BI descriptors created via studioAppDataStore.createDataset.
 *
 * SEEDING & VISIBILITY (review G2): demo tables use `access.default:'app'` so
 * owner-seeded rows are visible to EVERY viewer — under an `own` access mode a
 * viewer only sees rows they created, which would leave a shared demo empty.
 * The ONE deliberate exception is the ticket tracker's "My tickets" screen: the
 * tickets table is still `app`-scoped, but that screen's records binding filters
 * `created_by = currentUser.id`, demonstrating per-user scoping (and proving the
 * Wave 1a run-view fix — `currentUser` resolves in production).
 *
 * The DEFINITION is installed by studioApps.js's create-from-template clone
 * path; templateInstall.js owns ONLY the data side (model + seed + datasets).
 *
 * run_automation actions ship with automationId: null on purpose — users wire
 * their own automation after install. validate.js reports that as the friendly
 * 'action.automation_unset' warning, which the editor renders as a
 * "connect an automation" setup checklist, so templates install cleanly without
 * any automation dependencies.
 *
 * templates.test.js asserts every definition passes canonicalize + validate
 * with zero errors (passing each template's own dataModel + dataset ids so the
 * data-reference cross-checks resolve), every dataModel passes validateDataModel,
 * and every seed row conforms to its table.
 */

'use strict';

const TEMPLATES = [
    // ------------------------------------------------------------------
    // 1-10. The first templates: request form, lookup console, ops
    // dashboard, team hub, approval inbox, then the data-backed ones (CRM
    // pipeline, ticket tracker, asset inventory, event planner, team
    // directory). One file each under ./templates/, like the ones below.
    // ------------------------------------------------------------------
    require('./templates/appRequestForm'),
    require('./templates/appLookupConsole'),
    require('./templates/appOpsDashboard'),
    require('./templates/appTeamHub'),
    require('./templates/appApprovalInbox'),

    // ==================================================================
    // DATA-BACKED TEMPLATES (v2 — own SQLite tables + seed rows).
    // ==================================================================
    require('./templates/appCrmPipeline'),
    require('./templates/appTicketTracker'),
    require('./templates/appAssetInventory'),
    require('./templates/appEventPlanner'),
    require('./templates/appTeamDirectory'),

    // ------------------------------------------------------------------
    // 11. Support desk — the mailbox wave's acceptance test. Lives in its own
    // file: it is the largest template by some way, and keeping it here would
    // push this module past readability.
    // ------------------------------------------------------------------
    require('./templates/appSupportDesk'),

    // ------------------------------------------------------------------
    // 12. Offerte-intake — the support desk's spine (mailbox → grains →
    // reply) pointed at a sales workflow: AI classification, an editable
    // projectlines grid and an in-app portal CSV. Also in its own file.
    // ------------------------------------------------------------------
    require('./templates/appQuoteIntake'),

    // ------------------------------------------------------------------
    // 13. Sprint planning — an ADO/Jira-shaped delivery workspace. The
    // acceptance test for the board wave: a work-item hierarchy in ONE
    // self-referencing table, a rank-ordered backlog, sprints with capacity,
    // and boards whose columns are ROWS IN A TABLE rather than authored props
    // — so a team lead adds a column without opening the builder. Scrum and
    // Kanban are the same components with a different scope, which is what
    // "supports multiple board types" has to mean if it is not to be two
    // copies of one app. Also in its own file.
    // ------------------------------------------------------------------
    require('./templates/appSprintBoard'),

    // ------------------------------------------------------------------
    // 14-20. The COMPLIANCE set.
    //
    // Every template before this one is a business app: forms, tickets, a CRM,
    // a board. All of them are perfectly good, and all of them are things you
    // could also build in a US SaaS. None of them says why this product exists.
    //
    // These six do. Each is a register an EU organisation is either legally
    // obliged to keep or badly needs, and each holds exactly the kind of
    // material nobody should paste into a hosted assistant: the record of what
    // you process and on what basis, the breach you have 72 hours to report,
    // the identity documents behind a subject request, what went into the
    // knowledge base your assistants answer from, and the recording of the
    // meeting where it was all decided. A self-hosted, zero-knowledge workspace
    // is not a nice-to-have for these — it is the only defensible place to put
    // them.
    //
    // They are also the templates that argue for themselves: five of the six
    // need no AI at all, which is the point rather than an omission.
    // ------------------------------------------------------------------
    require('./templates/appAiActRegister'),
    require('./templates/appProcessingRegister'),
    require('./templates/appBreachRegister'),
    require('./templates/appDataSubjectRequests'),
    require('./templates/appKnowledgeGovernance'),
    require('./templates/appMeetingDossier'),
    require('./templates/appBiReports'),

    // ------------------------------------------------------------------
    // 21. Invoice approvals — the approvals wave's acceptance test.
    //
    // Every template above either has no approval in it or fakes one with a
    // form. This one is the real thing: PDF invoices read by ai_extract, and
    // then a `request_approval` step with a `stages` chain — an ordered ladder
    // of named rungs, each with its own approvers and its own rule.
    //
    // It is also the file to read when you want to know WHICH kind of routing
    // to reach for, because it demonstrates both and says why: a `condition`
    // and a `switch` in the action pick between whole ladders (by supplier and
    // by amount band), while `when` conditions on individual stages switch
    // single rungs on and off inside one ladder. The seats are deliberate
    // `replace-me-` placeholders — see the module header.
    // ------------------------------------------------------------------
    require('./templates/appInvoiceApprovals'),
];

/**
 * A template's version — an integer authors bump when they ship a changed
 * definition/data side. Missing or invalid counts as 1 EVERYWHERE (older
 * template modules simply don't carry the field), so version maths never
 * sees undefined. The template-upgrade feature (templateUpgrade.js) compares
 * this against the version stamped on an app row at create-from-template time.
 */
function templateVersion(t) {
    const v = t && t.version;
    return (Number.isInteger(v) && v > 0) ? v : 1;
}

function listTemplates() {
    // Gallery view — everything except the heavy fields (definition, dataModel,
    // seed rows and dataset descriptors). The gallery only needs the metadata.
    return TEMPLATES.map(({ definition, dataModel, seed, datasets, ...meta }) => ({ ...meta, version: templateVersion(meta) }));
}

function getTemplate(id) {
    const t = TEMPLATES.find((x) => x.id === id) || null;
    // Shallow copy so the normalized version never mutates the shared
    // constant; the heavy fields (definition/dataModel/seed) are shared by
    // reference — every consumer already deep-clones before writing.
    return t ? { ...t, version: templateVersion(t) } : null;
}

module.exports = { TEMPLATES, listTemplates, getTemplate, templateVersion };
