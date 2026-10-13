// Templates, import and export, split out of routes/automation/crud.js: the
// gallery, a portability envelope coming in as a new draft, and one going out.
// crud.js registers these routes on its own router at the places they always
// had: templates and import before `/:id`, export beside the other `/:id/...`.
const log = require('../../telemetry/log');
const automationStore = require('../../stores/automationStore');
const cron = require('../../automation/cron');
const { validateDefinition } = require('../../automation/validate');
const { getDeliverableEvents } = require('../../automation/deliverableEvents');
const { TOOL_REGISTRY, loadTools } = require('../../automation/toolRegistry');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { buildExport, sanitizeImport, rebindDatatables, rekeyDefinition, stripAppRefs } = require('../../automation/portability');
const { syncDatatableUsage } = require('../../automation/datatableUsageSync');
const { syncKbSources } = require('../../core/kb/kbSourceSync');
const { orgOf, kbFindingsFor, automationAccess } = require('./crudContext');

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
    router.get('/templates', async (req, res) => {
        const { listTemplatesFor, CATEGORIES } = require('../../automation/templates');
        const templates = await listTemplatesFor({ userId: req.session.user.id, orgId: await orgOf(req) });
        res.json({ templates, categories: CATEGORIES });
    });

    router.get('/templates/:id', async (req, res) => {
        const { getTemplateFor } = require('../../automation/templates');
        const tmpl = await getTemplateFor(req.params.id, { userId: req.session.user.id, orgId: await orgOf(req) });
        if (!tmpl) return res.status(404).json({ error: 'Template not found' });
        res.json({ template: tmpl });
    });

    router.post('/import', importLimiter, async (req, res) => {
        const userId = req.session.user.id;
        const { automation: incoming, errors: importErrors } = sanitizeImport(req.body);
        if (!incoming || importErrors.length > 0) {
            return res.status(400).json({ error: 'Invalid import file', details: importErrors });
        }

        // Re-link datatable steps BEFORE validating: export blanks the id (a
        // datatable id names a table in ONE organisation) and keeps the key, and
        // `datatable.table_missing` blocks at this stage — so until this ran, a
        // automation with a datatable step could not be imported at all, not even
        // as a draft to repair by hand. Only the caller's own tables are offered
        // to it, so a re-link cannot cross a scope boundary.
        const { entries: datatableEntries } = rebindDatatables(incoming.definition, await importableDatatables(req));
        const datatableFindings = (stepIdOf = (_layer, id) => id) => datatableEntries.map(e => {
            const stepId = stepIdOf(e.layerKey, e.stepId) || '';
            return {
                code: e.datatableId ? 'datatable.relinked' : 'datatable.unlinked',
                severity: 'warning',
                path: e.layerKey ? `layers.${e.layerKey}.steps.${stepId}` : `steps.${stepId}`,
                message: e.message,
                hint: e.datatableId ? 'A table key travels with an exported automation; the table it names here is yours.' : 'Open the step in the builder and pick a table.',
            };
        });

        const v = validateDefinition(incoming.definition);
        // The datatable findings ride along on the failure too: without them a
        // automation that could not be re-linked is refused with "pick which
        // datatable to use" and nothing that says which one it wanted. A refused
        // file is reported in the ids the file itself uses.
        if (!v.ok) return res.status(400).json({ error: 'Invalid definition', details: [...v.errors, ...datatableFindings()] });

        // Fresh step ids per graph (root + each inline layer) so importing
        // the same file twice never collides and crafted ids can't alias
        // existing drafts' replay data. Done BEFORE the findings below, which
        // describe the draft as it is STORED: a reference the rename missed used
        // to land as a broken draft with nothing said, because only the
        // pre-rename copy was ever validated.
        const { definition, renameMap } = rekeyDefinition(incoming.definition);
        const renamedId = (layerKey, id) => {
            const map = layerKey ? renameMap?.layers?.[layerKey] : renameMap?.root;
            return map && Object.prototype.hasOwnProperty.call(map, id) ? map[id] : id;
        };

        // Catalog-aware pass — same construction as the activate route
        // (permission-based, fail-open). Because the catalog-free pass above
        // already succeeded, everything this pass flags is a tool-availability /
        // required-param / deliverability finding: surfaced as warnings so the
        // user knows which integrations they still need to connect.
        // Fallback when the catalog cannot be built: the stored draft, catalog-free.
        // Its errors are warnings here (the draft lands inactive; activate re-checks).
        const stored = definition === incoming.definition ? v : validateDefinition(definition);
        let warnings = [...(stored === v ? [] : stored.errors || []), ...(stored.warnings || [])];
        try {
            const { getUserPermittedApps } = require('../../core/integrations/integrationTools');
            const permitted = await getUserPermittedApps({ userId, session: req.session, isAdmin: !!req.session?.isAdmin });
            const availableTools = new Set();
            const toolRequiredParams = {};
            for (const entry of TOOL_REGISTRY) {
                const permittedApp = permitted.has(entry.app);
                for (const t of loadTools(entry)) {
                    const name = t?.function?.name;
                    if (!name) continue;
                    if (permittedApp) availableTools.add(name);
                    const rq = t?.function?.parameters?.required;
                    if (Array.isArray(rq)) toolRequiredParams[name] = rq;
                }
            }
            const v2 = validateDefinition(definition, {
                availableTools, toolRequiredParams, deliverableEvents: getDeliverableEvents(),
            });
            warnings = [...(v2.errors || []), ...(v2.warnings || [])];
        } catch (e) {
            log.warn('[automation/import] tool catalog build failed; importing without tool warnings:', e.message);
        }
        // An exported automation carries knowledge-base ids from wherever it was
        // built. Non-blocking, like every other import finding: the draft lands
        // inactive and activate re-checks — but the author is told now, while
        // they still remember what the automation was supposed to read.
        warnings = [...warnings, ...await kbFindingsFor(definition, req, req.session.user.id, 'draft')];

        // And the back-pointer to an app button comes off — the SAME rule as on
        // export, now on the way in too. `buildExport` removed it, so a truly
        // exported file has none; a hand-written file can, and then an
        // automation landed here pointing at someone else's app while the gate
        // on POST / (`appRef` → appRefOwnerVerdict) refuses exactly the same
        // definition with 403 `owner_mismatch`. Two create paths, one answer.
        // Refusing would be too harsh here: it is a label, not a right, and the
        // rest of the file imports fine.
        const strippedRefs = stripAppRefs(definition, []);
        if (strippedRefs) {
            warnings = [...warnings, {
                code: 'import.app_ref_removed', severity: 'warning', path: 'definition.trigger.appRef',
                message: 'Removed the link back to an app button — it names a screen in the installation this file came from.',
                hint: 'Open the button in App Studio and pick this automation there to link them again.',
            }];
        }

        // Best-effort schedule arming — a bad cron in the file shouldn't
        // block the import (the draft is inactive); activate recomputes.
        let nextRunAt = null;
        if (incoming.triggerType === 'schedule' && incoming.scheduleCron) {
            try { nextRunAt = cron.nextRunAt(incoming.scheduleCron, incoming.scheduleTz || 'Europe/Amsterdam', Date.now()); }
            catch (e) {
                warnings = [...warnings, { code: 'import.bad_cron', severity: 'warning', path: 'scheduleCron', message: `Schedule "${incoming.scheduleCron}" did not parse (${e.message}).`, hint: 'Open the trigger and pick a schedule again before activating.' }];
            }
        }

        const organizationId = await orgOf(req);   // see the note on the create route above
        const a = await automationStore.createAutomation({
            userId,
            organizationId,
            title: incoming.title,
            description: incoming.description,
            definition,
            triggerType: incoming.triggerType,
            scheduleCron: incoming.scheduleCron,
            scheduleTz: incoming.scheduleTz || 'Europe/Amsterdam',
            nextRunAt,
        });
        // portability blanks datatableId on export, so an imported automation
        // usually indexes nothing — but one imported into the org it came from
        // keeps its ids, and those steps have to appear in "used by".
        await syncDatatableUsage(a.id, organizationId, definition, { label: 'automation import' });
        // An import arrives with its knowledge base BLANKED (portability scrubs
        // it), so this usually attaches nothing — until the importer picks a
        // base of their own, at which point the next save attaches it.
        await syncKbSources(a.id, definition, { userId: req.session.user.id, title: a.title });
        // Appended LAST because the catalog pass above reassigns `warnings`
        // wholesale — pushing them earlier would drop every one of them.
        res.json({ automation: a, warnings: [...warnings, ...datatableFindings(renamedId)] });
    });
}

function registerExportRoute(router) {
    // §WS4.3 — the export route was documented and buildExport imported, but the
    // handler was never registered (dead import). Implement it with the same
    // ownership guard as the rest of the file so a user can download a sanitized,
    // portable envelope of their own automation (matching POST /import).
    router.get('/:id/export', require('../../compliance/dataPortability/stampExport')('automations'), async (req, res) => {
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        // `view` reads every step already; the export is the same data, sanitised.
        if (!await automationAccess.guard(req, res, a, 'view')) return;
        const { envelope, warnings } = buildExport(a);
        res.json({ envelope, warnings });
    });
}

module.exports = { registerTemplateAndImportRoutes, registerExportRoute };
