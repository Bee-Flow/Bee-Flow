// @typecheck
// Templates, import and export, split out of routes/automation/crud.js: the
// gallery, a portability envelope coming in as a new draft, and one going out.
// crud.js registers these routes on its own router at the places they always
// had: templates and import before `/:id`, export beside the other `/:id/...`.
const log = require('../../telemetry/log');
const automationStore = require('../../stores/automationStore');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { buildExport } = require('../../automation/portability');
const { orgOf, kbFindingsFor, automationAccess } = require('./crudContext');
const { sessionUser } = require('../../core/http/sessionUser');

/**
 * The datatables THIS caller may use, in the shape portability.rebindDatatables
 * matches on — built exactly the way the builder catalog builds its picker
 * (both tenancies, then the same grade resolver the runner uses), so an import
 * can only ever re-link to a table its importer can already see.
 *
 * Best-effort by design: a datatable outage must leave the automation importable
 * with its steps unlinked, which is what the file said anyway. Returning []
 * loses nothing except the re-link.
 */
async function importableDatatables(req) {
    try {
        const datatableStore = require('../../stores/datatableStore');
        const { gradeForPrincipal, resolveDatatablePrincipal, datatableScopesFor } = require('../../auth/datatableAccess');
        const principal = await resolveDatatablePrincipal(req);
        const out = [];
        for (const scope of datatableScopesFor(principal)) {
            const all = await datatableStore.listDatatablesForScope(scope);
            const grantsByTable = await datatableStore.listGrantsForTables(all.map(t => t.id));
            for (const t of all) {
                if (!gradeForPrincipal(t, grantsByTable.get(t.id) || [], principal)) continue;
                out.push({ id: t.id, key: t.key, name: t.name });
            }
        }
        return out;
    } catch (e) {
        log.warn('[automation/import] datatables unavailable; importing without re-linking:', e.message);
        return [];
    }
}

/**
 * Import a portability envelope (produced by GET /:id/export, or a bare
 * `{ automation }` body) as a NEW inactive draft owned by the caller.
 *
 * Like /templates, this MUST be registered before `/:id` — route order is
 * what keeps Express from treating the literal "import" as an automation id.
 *
 * Flow: sanitizeImport (allowlist + format/schemaVersion gate) →
 * validateDefinition hard-fail (on the file as sent) → rekeyDefinition (fresh
 * step ids per graph) → second, catalog-aware validation pass on the draft AS
 * STORED (built exactly like /:id/activate builds it) whose findings are
 * NON-BLOCKING here — the draft lands inactive, and activate re-checks
 * hard — → createAutomation (which already forces is_active=FALSE,
 * is_draft=TRUE).
 *
 * Rate-limited per user: imports validate against the full tool catalog and
 * write a row, so 10/min is plenty for legitimate use and starves bulk abuse.
 */
const importLimiter = perUserRateLimit({ windowMs: 60_000, max: 10 });

function registerTemplateAndImportRoutes(router) {
    // Templates routes MUST come before `/:id` — otherwise Express matches
    // `/:id` for the literal string 'templates' and returns 404 from
    // automationStore.getAutomation('templates').

    // Handoff 5: the organisation's own templates ("Save as template", source
    // 'org') lead the list; the built-in ones follow (source 'builtin').
    router.get('/templates', async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
        const { listTemplatesFor, CATEGORIES } = require('../../automation/templates');
        const templates = await listTemplatesFor({ userId: sessionUser(req).id, orgId: await orgOf(req) });
        res.json({ templates, categories: CATEGORIES });
    });

    router.get('/templates/:id', async (req, /** @type {import('express').Response} */ res) => {
        const { getTemplateFor } = require('../../automation/templates');
        const tmpl = await getTemplateFor(req.params.id, { userId: req.session.user.id, orgId: await orgOf(req) });
        if (!tmpl) return res.status(404).json({ error: 'Template not found' });
        res.json({ template: tmpl });
    });

    router.post('/import', importLimiter, async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
        // The gates and the write live in usecases/automation/importEnvelope.mts,
        // shared with the Windmill importer: one pipeline for every envelope.
        const { importEnvelope } = require('../../usecases/automation/importEnvelope.mts');
        const r = await importEnvelope(req.body, await importContextFor(req));
        if (r.ok === false) return res.status(r.status).json(r.body);
        res.json({ automation: r.automation, warnings: r.warnings });
    });

    // Import from Windmill (Enterprise, `automation_import`): /import/windmill/*
    // and /:id/import-report, each gated per route (./windmillImport.mts).
    require('./windmillImport.mts').registerWindmillImportRoutes(router, { importContextFor });
}

/**
 * Who imports, and the three lookups an import needs from the request: the
 * caller's datatables, the integrations they may use and the knowledge-base
 * findings in their organisation. Shared with routes/automation/windmillImport.js.
 * @param {import('express').Request} req
 * @returns {Promise<import('../../usecases/automation/importEnvelope.mts').ImportContext>}
 */
async function importContextFor(req) {
    const userId = sessionUser(req).id;
    return {
        userId,
        organizationId: await orgOf(req),   // see the note on the create route in crud.js
        importableDatatables: () => importableDatatables(req),
        permittedApps: async () => {
            const { getUserPermittedApps } = require('../../core/integrations/integrationTools');
            return getUserPermittedApps({ userId, session: req.session, isAdmin: !!req.session?.isAdmin });
        },
        // An exported automation carries knowledge-base ids from wherever it was
        // built: non-blocking, the draft lands inactive and activate re-checks.
        kbFindings: (definition) => kbFindingsFor(definition, req, userId, 'draft'),
    };
}

function registerExportRoute(router) {
    // Export: the same ownership guard as the rest of the file, so a user can
    // download a sanitized, portable envelope of their own automation
    // (matching POST /import).
    router.get('/:id/export', require('../../compliance/dataPortability/stampExport')('automations'), async (req, /** @type {import('express').Response} */ res) => {
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        // `view` reads every step already; the export is the same data, sanitised.
        if (!await automationAccess.guard(req, res, a, 'view')) return;
        const { envelope, warnings } = buildExport(a);
        res.json({ envelope, warnings });
    });
}

module.exports = { registerTemplateAndImportRoutes, registerExportRoute, importContextFor };
