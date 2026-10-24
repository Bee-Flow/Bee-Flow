// @typecheck
/**
 * App Studio data routes: what the app's owner manages. Saved datasets,
 * the data model (schema) and the app's members with their roles. The
 * route table stays in routes/studioAppData.js. Split out of it;
 * behaviour unchanged.
 */

const log = require('../../telemetry/log');
const studioAppDataStore = require('../../stores/studioAppDataStore');
const rlsGateway = require('../../appStudio/rlsGateway');
const { validateDataModel } = require('../../appStudio/dataModel');
const { loadOwnedApp, handleErr } = require('./appDataContext');
const { bestEffort } = require('../../utils/bestEffort');

async function listDatasets(req, res) {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const datasets = await studioAppDataStore.listDatasets(app.id, app.userId);
        res.json({ datasets });
    } catch (err) { handleErr(res, err, 'datasets.list'); }
}

async function createDataset(req, res) {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const dataset = await studioAppDataStore.createDataset(app.id, app.userId, {
            name: typeof body.name === 'string' ? body.name : undefined,
            tableId: typeof body.tableId === 'string' ? body.tableId : null,
            source: (body.source && typeof body.source === 'object') ? body.source : {},
            descriptor: (body.descriptor && typeof body.descriptor === 'object') ? body.descriptor : {},
            cacheTtlSeconds: Number.isFinite(body.cacheTtlSeconds) ? body.cacheTtlSeconds : undefined,
        });
        res.json({ success: true, dataset });
    } catch (err) { handleErr(res, err, 'datasets.create'); }
}

async function updateDataset(req, res) {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const updates = {};
        if (body.name !== undefined) updates.name = body.name;
        if (body.tableId !== undefined) updates.tableId = body.tableId;
        if (body.source !== undefined) updates.source = body.source;
        if (body.descriptor !== undefined) updates.descriptor = body.descriptor;
        if (body.cacheTtlSeconds !== undefined) updates.cacheTtlSeconds = body.cacheTtlSeconds;
        const dataset = await studioAppDataStore.updateDataset(req.params.datasetId, app.id, app.userId, updates);
        if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
        // Descriptor/source edits change the query — drop stale cached results.
        try { await studioAppDataStore.invalidateCache(req.params.datasetId); } catch (err) { bestEffort('routes/studio/appDataAdmin:updateDataset', err); /* advisory */ }
        res.json({ success: true, dataset });
    } catch (err) { handleErr(res, err, 'datasets.update'); }
}

async function deleteDataset(req, res) {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const ok = await studioAppDataStore.deleteDataset(req.params.datasetId, app.id, app.userId);
        if (!ok) return res.status(404).json({ error: 'Dataset not found' });
        res.json({ success: true });
    } catch (err) { handleErr(res, err, 'datasets.delete'); }
}

async function getSchema(req, res) {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        // reconcile: lazily heals a SQLite-ahead-of-Postgres drift window on
        // editor open (best-effort inside the store — never fails the read).
        const meta = await studioAppDataStore.getDataModel(app.id, app.userId, { reconcile: true });
        res.json({
            model: meta ? meta.model : null,
            modelVersion: meta ? meta.modelVersion : 0,
        });
    } catch (err) { handleErr(res, err, 'schema.get'); }
}

async function putSchema(req, res) {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const model = body.model;
        if (!model || typeof model !== 'object' || Array.isArray(model)) {
            return res.status(400).json({ error: 'model (object) is required' });
        }

        // Shape validation first, then every declared rowFilter must translate to
        // the bounded SQL subset (the ONLY free-form input a data model carries).
        const { errors } = validateDataModel(model);
        const rowFilterErrors = [];
        for (const t of (Array.isArray(model.tables) ? model.tables : [])) {
            const rf = t && t.access && typeof t.access.rowFilters === 'object' ? t.access.rowFilters : null;
            if (!rf) continue;
            for (const roleKey of Object.keys(rf)) {
                const { ok, errors: rfErr } = rlsGateway.validateRowFilter(rf[roleKey], t);
                if (!ok) rowFilterErrors.push(`table "${t.key}" role "${roleKey}": ${rfErr.join('; ')}`);
            }
        }
        const allErrors = [...errors, ...rowFilterErrors];
        if (allErrors.length) return res.status(422).json({ error: 'Data model failed validation', errors: allErrors });

        const expectedVersion = Number.isInteger(body.expectedVersion) ? body.expectedVersion : null;
        const result = await studioAppDataStore.saveDataModel(app.id, app.userId, model, { expectedVersion });
        if (result.invalid) return res.status(422).json({ error: 'Data model failed validation', errors: result.errors });
        if (result.notFound) return res.status(404).json({ error: 'App not found' });
        if (result.conflict) {
            return res.status(409).json({
                error: 'The data model changed since you loaded it',
                conflict: true,
                currentVersion: result.currentVersion,
                model: result.model,
            });
        }
        // Saving the model is what SCHEDULES a connector's table fill. Without
        // this a newly configured sync had no state row, so the background job —
        // which selects on next_run_at — could never see it, and the table stayed
        // empty until someone opened the app or pressed "Refresh now".
        // Best-effort: the model is already committed, and a missed seed is
        // recovered by the next save or by opening the app.
        try {
            const synced = (Array.isArray(model.connectors) ? model.connectors : [])
                .filter((c) => c && c.sync && c.sync.tableId)
                .map((c) => c.id);
            await studioAppDataStore.reconcileSyncStates(app.id, app.userId, synced);
        } catch (e) {
            log.warn(`[StudioAppData] sync scheduling failed for app ${app.id}: ${e.message}`);
        }

        res.json({ success: true, version: result.version });
    } catch (err) { handleErr(res, err, 'schema.put'); }
}

async function listMembers(req, res) {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const members = await studioAppDataStore.listMembers(app.id, app.userId);
        res.json({ members });
    } catch (err) { handleErr(res, err, 'members.list'); }
}

async function addMember(req, res) {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const memberUserId = typeof body.userId === 'string' ? body.userId.trim() : '';
        const roleKey = typeof body.roleKey === 'string' && body.roleKey ? body.roleKey : 'member';
        if (!memberUserId) return res.status(400).json({ error: 'userId is required' });

        // A member's role must exist in the data model (plus the built-in
        // 'member' fallback) — a typo'd/deleted role would otherwise sit in the
        // membership table and silently resolve to the tables' default access.
        const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
        const modelRoles = (meta && meta.model && Array.isArray(meta.model.roles)) ? meta.model.roles : [];
        const validRoles = [...new Set([
            ...modelRoles.map((r) => r && r.key).filter((k) => typeof k === 'string' && k),
            'member',
        ])];
        if (!validRoles.includes(roleKey)) {
            return res.status(422).json({ error: 'invalid_role', roleKey, validRoles });
        }

        const member = await studioAppDataStore.addMember(app.id, app.userId, memberUserId, roleKey);
        if (!member) return res.status(404).json({ error: 'App not found' });
        res.json({ success: true, member });
    } catch (err) { handleErr(res, err, 'members.add'); }
}

async function removeMember(req, res) {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const ok = await studioAppDataStore.removeMember(app.id, app.userId, req.params.userId);
        if (!ok) return res.status(404).json({ error: 'App not found' });
        res.json({ success: true });
    } catch (err) { handleErr(res, err, 'members.remove'); }
}

module.exports = { listDatasets, createDataset, updateDataset, deleteDataset, getSchema, putSchema, listMembers, addMember, removeMember };
