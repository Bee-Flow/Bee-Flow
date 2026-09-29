/**
 * App Studio builder tools — templates: the gallery (app_list_templates),
 * installing one as the app foundation (app_apply_template) and capturing
 * this app as a reusable template (app_save_as_template).
 */

'use strict';

const { canonicalizeAppDefinition } = require('../canonicalize');
const { capStr } = require('./shared');
const { persistDraft } = require('./persistence');
const { rowCountsById } = require('./dataTools');
const log = require('../../telemetry/log');

/** True when the draft is untouched — one empty screen, no actions, no tables. */
function isFreshDraft(draftWrap) {
    const def = draftWrap?.def || {};
    const screens = Array.isArray(def.screens) ? def.screens : [];
    if (screens.length !== 1) return false;
    const sole = screens[0];
    const sections = Array.isArray(sole.sections) ? sole.sections : [];
    if (sections.some((s) => Array.isArray(s.children) && s.children.length > 0)) return false;
    if (def.actions && Object.keys(def.actions).length > 0) return false;
    const model = draftWrap?.dataModel;
    if (model && Array.isArray(model.tables) && model.tables.length > 0) return false;
    return true;
}

/** Lazy-load the templates gallery module; null when unavailable. */
function loadTemplatesModule() {
    try { return require('../templates'); } catch (_) { return null; }
}

/** Lazy-load the merged (built-in + captured) registry; null when unavailable. */
function loadTemplateRegistry() {
    try { return require('../templateRegistry'); } catch (_) { return null; }
}

/** The visibility scope for captured templates — see templateRegistry.js. */
function viewerScope(draftWrap) {
    return {
        userId: draftWrap?.userId,
        orgIds: draftWrap?.orgId ? [draftWrap.orgId] : [],
    };
}

/**
 * app_list_templates — compact gallery rows for the model to choose from.
 * Lists BOTH the built-in starters and the templates this user's organisation
 * captured from its own apps (app_save_as_template), because from the model's
 * point of view they are the same thing: an id you can apply.
 */
async function applyListTemplates(draftWrap) {
    const registry = loadTemplateRegistry();
    const templates = loadTemplatesModule();
    if (!registry && !templates) {
        return { error: 'Templates are not available.', _fixHint: 'Build the app directly with app_upsert_table / app_add_components instead.' };
    }
    let rows;
    try {
        rows = registry
            ? await registry.listAvailableTemplates(viewerScope(draftWrap))
            : templates.listTemplates();
    } catch (e) {
        return { error: `Could not list templates: ${e.message}` };
    }
    // Built-in rows carry no definition (listTemplates strips the heavy fields),
    // so the screen/table counts come from the full constant. A captured row
    // does not need them — it reports its own counts from the store.
    const full = Array.isArray(templates?.TEMPLATES) ? templates.TEMPLATES : [];
    const byId = new Map(full.map((t) => [t.id, t]));
    const compact = (Array.isArray(rows) ? rows : []).slice(0, 60).map((t) => {
        const src = byId.get(t.id) || t;
        return {
            id: t.id,
            name: t.title || t.name || t.id,
            description: typeof t.description === 'string' ? t.description.slice(0, 200) : '',
            screens: Array.isArray(src.definition?.screens) ? src.definition.screens.length : 0,
            tables: Array.isArray(src.dataModel?.tables) ? src.dataModel.tables.length : 0,
            ...(t.source === 'captured' ? { source: 'captured', version: t.version } : {}),
        };
    });
    return {
        templates: compact,
        note: compact.length
            ? 'Apply one with app_apply_template { templateId } on a fresh draft, then customise. Rows marked source:"captured" were made from an app in this organisation with app_save_as_template.'
            : 'No templates available — build directly.',
    };
}

/**
 * app_apply_template — install a starter template as the app foundation via
 * templateInstall.installTemplate (the SINGLE template instantiation path;
 * deep-clones the definition, creates tables, seeds rows and datasets). Refused
 * unless the draft is untouched. On success the draft's def/dataModel/datasets
 * are reloaded so the route can emit fresh draft + data_model SSE.
 */
async function applyApplyTemplate(draftWrap, args) {
    const templateId = capStr(args?.templateId, 120);
    if (!templateId) return { error: 'templateId is required — call app_list_templates for the ids.' };
    if (!isFreshDraft(draftWrap)) {
        return {
            error: 'app_apply_template only works on a fresh, untouched draft (one empty screen, nothing built yet).',
            _fixHint: 'You have already started building. Continue with app_add_components / app_upsert_table, or start a new app to apply a template.',
        };
    }
    // Resolves BOTH kinds: a built-in id from the code gallery, or a `utpl_…`
    // one this organisation captured from its own app. Same install path.
    const registry = loadTemplateRegistry();
    const templates = loadTemplatesModule();
    let template = null;
    try {
        template = registry
            ? await registry.resolveTemplate(templateId, viewerScope(draftWrap))
            : (templates && typeof templates.getTemplate === 'function' ? templates.getTemplate(templateId) : null);
    } catch (e) {
        return { error: `Could not read template ${JSON.stringify(templateId)}: ${e.message}` };
    }
    if (!template) {
        return { error: `Unknown templateId ${JSON.stringify(templateId)}.`, _fixHint: 'Call app_list_templates for the available ids.' };
    }

    // installTemplate needs a persisted app row to write tables/rows into.
    if (!draftWrap.appId) {
        const created = await persistDraft(draftWrap);
        if (created.error) return created;
    }

    // SIBLING 5c owns server/appStudio/templateInstall.js — lazy-require so this
    // tool loads (and the schema stays live) even before that module lands.
    let templateInstall;
    try {
        templateInstall = require('../templateInstall');
    } catch (_) {
        return {
            error: 'Template installation is not available yet in this build.',
            _fixHint: 'Build the app directly (app_upsert_table + app_add_components) instead of applying a template.',
        };
    }
    if (!templateInstall || typeof templateInstall.installTemplate !== 'function') {
        return { error: 'Template installation is not available yet in this build.' };
    }

    /*
     * THE DEFINITION, WHICH USED TO BE LEFT BEHIND.
     *
     * This tool installed only the DATA side and then re-read the app's
     * definition from the store — which, on the fresh draft it insists on, is
     * still one empty screen. So applying a 7-screen template over MCP produced
     * an app with all its tables, all its rows, its roles and its connector, and
     * nothing to look at. The docstring above has always said "deep-clones the
     * definition"; only the REST create-from-template path actually did it,
     * which is why the product UI never showed the hole.
     *
     * Same three steps as routes/studioApps.js: deep-clone (the built-in
     * TEMPLATES constant is shared and must never be mutated), keep the name the
     * app already has, canonicalize.
     */
    const copy = JSON.parse(JSON.stringify(template.definition || {}));
    const keepName = draftWrap.def?.meta?.name;
    copy.meta = { ...(copy.meta || {}), ...(keepName ? { name: keepName } : {}) };
    draftWrap.def = canonicalizeAppDefinition(copy).def;

    // Persist before the data install: templateInstall's seed rows go through
    // writeRecord against the STORED app, and a definition still sitting in
    // memory here would be lost if anything below threw.
    const savedDef = await persistDraft(draftWrap);
    if (savedDef.error) return savedDef;

    // Template provenance — the same stamp the REST create path writes, so a
    // pristine app installed over MCP is offered the newer version later
    // (templateUpgrade.js). Best-effort: a missing stamp costs the upgrade
    // offer, never the install.
    try {
        const { hashDefinition } = require('../templateUpgrade');
        const { templateVersion } = require('../templates');
        const studioAppStore = require('../../stores/studioAppStore');
        if (typeof studioAppStore.setTemplateProvenance === 'function') {
            await studioAppStore.setTemplateProvenance(draftWrap.appId, draftWrap.userId, {
                templateId: template.id,
                templateVersion: template.version || templateVersion(template),
                templateInstallHash: hashDefinition(draftWrap.def),
            });
        }
    } catch (e) {
        log.warn(`[builderTools] template provenance not stamped for ${draftWrap.appId}: ${e && e.message ? e.message : e}`);
    }

    let out;
    try {
        out = await templateInstall.installTemplate({ appId: draftWrap.appId, ownerId: draftWrap.userId, template });
    } catch (e) {
        return { error: `Could not install template "${templateId}": ${e.message}` };
    }
    if (!out || out.ok === false) {
        return { error: (out && out.error) || `Template "${templateId}" could not be installed.` };
    }

    // Reload the draft's two sides so the route emits the real post-install state.
    try {
        const studioAppStore = require('../../stores/studioAppStore');
        const app = await studioAppStore.getStudioApp(draftWrap.appId);
        if (app && app.definition && Object.keys(app.definition).length) {
            const { def } = canonicalizeAppDefinition(app.definition);
            draftWrap.def = def;
            draftWrap.version = app.definitionVersion;
        }
    } catch (_) { /* keep the current def — the route re-persists on the next mutation */ }
    try {
        const studioAppDataStore = require('../../stores/studioAppDataStore');
        const dataMeta = await studioAppDataStore.getDataModel(draftWrap.appId, draftWrap.userId);
        draftWrap.dataModel = dataMeta?.model ?? draftWrap.dataModel ?? null;
        draftWrap.dataModelVersion = dataMeta?.modelVersion ?? draftWrap.dataModelVersion ?? 0;
        draftWrap.rowCounts = rowCountsById(draftWrap.dataModel, dataMeta?.rowCounts);
        const datasetRows = await studioAppDataStore.listDatasets(draftWrap.appId, draftWrap.userId);
        draftWrap.datasetIds = (datasetRows || []).map((d) => ({ id: d.id, name: d.name }));
    } catch (_) { /* data side is advisory for the emit; tools re-read it next turn */ }

    return {
        ok: true,
        appId: draftWrap.appId,
        templateId,
        screens: Array.isArray(draftWrap.def?.screens) ? draftWrap.def.screens.length : 0,
        actions: draftWrap.def?.actions ? Object.keys(draftWrap.def.actions).length : 0,
        ...(out.dataModelVersion !== undefined ? { dataModelVersion: out.dataModelVersion } : {}),
        _hints: ['Template installed. Customise it with the normal tools — the new tables, rows and screens are in the draft state.'],
    };
}

/**
 * app_save_as_template — capture THIS app as a reusable template.
 *
 * The inverse of app_apply_template, and deliberately its mirror: what comes
 * out installs through the same templateInstall path a built-in starter does.
 * See templateCapture.js for what is scrubbed (routine ids, file values,
 * system columns, relations to rows that did not travel) and why.
 *
 * It reads the app and writes a row in a DIFFERENT table, so it is NOT in
 * MUTATING_TOOLS: there is no draft change to persist, and adding one would
 * make the CAS version move for a call that changed nothing about the app.
 */
async function applySaveAsTemplate(draftWrap, args) {
    if (!draftWrap.appId) {
        return {
            error: 'Save this app first — there is nothing persisted to capture yet.',
            _fixHint: 'Any mutating tool (app_set_meta is enough) creates the app row.',
        };
    }
    const title = capStr(args?.title, 80);
    if (!title) return { error: 'title is required — it names the template in the gallery.' };

    const seedTables = Array.isArray(args?.seedTables)
        ? args.seedTables.filter((t) => typeof t === 'string' && t)
        : [];

    let capture;
    try {
        const { captureFromApp } = require('../templateCapture');
        capture = await captureFromApp({
            appId: draftWrap.appId,
            userId: draftWrap.userId,
            definition: draftWrap.def,
            dataModel: draftWrap.dataModel || null,
            seedTables,
            meta: {
                title,
                description: capStr(args?.description, 400),
                category: capStr(args?.category, 40),
                icon: capStr(args?.icon, 40),
                tags: Array.isArray(args?.tags) ? args.tags : [],
            },
        });
    } catch (e) {
        return { error: `Could not capture the app: ${e.message}` };
    }

    if (!capture.ok) {
        return {
            error: `The app cannot be captured as a template yet: ${capture.errors.join('; ')}`,
            ...(capture._fixHint ? { _fixHint: capture._fixHint } : {
                _fixHint: 'Run app_dry_run and fix the validation errors first — a template has to install clean.',
            }),
        };
    }

    const { template, report } = capture;
    let saved;
    try {
        const store = require('../../stores/studioAppTemplateStore');
        saved = await store.saveTemplate({
            id: capStr(args?.templateId, 60) || null,
            organizationId: draftWrap.orgId || null,
            createdBy: draftWrap.userId,
            sourceAppId: draftWrap.appId,
            title: template.title,
            description: template.description,
            category: template.category,
            icon: template.icon,
            tags: template.tags,
            payload: {
                definition: template.definition,
                ...(template.dataModel ? { dataModel: template.dataModel } : {}),
                ...(template.seed ? { seed: template.seed } : {}),
                ...(template.datasets ? { datasets: template.datasets } : {}),
            },
        });
    } catch (e) {
        return { error: `Could not save the template: ${e.message}` };
    }

    const hints = [
        `Saved as template ${saved.id} (v${saved.version}). Install it with app_apply_template { templateId: "${saved.id}" } on a fresh app.`,
    ];
    if (!report.seededRows) {
        hints.push('No rows were captured. Pass seedTables with the ids of tables holding VOCABULARY (option lists, column maps) — never tables holding customer records.');
    }
    for (const req of report.requires) {
        if (req.kind === 'connector') hints.push(`Whoever installs this must create connector(s): ${req.ids.join(', ')}.`);
        if (req.kind === 'automation') hints.push(`${req.count} run_automation step(s) were cleared — the installer wires their own routine.`);
        if (req.kind === 'knowledge_base') hints.push(`References ${req.ids.length} knowledge base(s) that will not exist after install.`);
    }

    return {
        ok: true,
        templateId: saved.id,
        version: saved.version,
        title: saved.title,
        scope: draftWrap.orgId ? 'organisation' : 'private',
        ...report,
        _hints: hints,
    };
}

module.exports = {
    applyListTemplates,
    applyApplyTemplate,
    applySaveAsTemplate,
    // internal, re-exported through ../builderTools.js _test
    isFreshDraft,
};
