// @typecheck strict
/**
 * App Studio data routes: "start clean". POST /:id/data/empty deletes every row of the app's
 * own tables (all, or the chosen ones) and keeps the tables. The owner-only gate is the one
 * PUT /:id/schema uses (loadOwnedApp); the ordering and the transaction live in
 * appStudio/emptyAppData.mts.
 */

const studioAppDataStore = require('../../stores/studioAppDataStore');
const studioAppDbStore = require('../../stores/studioAppDbStore');
const storageStore = require('../../stores/storageStore');
const queryCompiler = require('../../appStudio/queryCompiler');
const { emptyAppData } = require('../../appStudio/emptyAppData.mts');
const { purgeAttachments } = require('../../appStudio/connectorRetention.mts');
const { loadOwnedApp, handleErr } = require('./appDataContext');

/**
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function emptyData(req, res) {
    try {
        const app = await loadOwnedApp(req, res);
        if (!app) return;
        const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
        const model = meta && meta.model && typeof meta.model === 'object' ? meta.model : { tables: [] };
        const tableIds = Array.isArray(req.body?.tableIds) ? req.body.tableIds : undefined;
        const result = await emptyAppData(app, model, tableIds, {
            batch: studioAppDbStore.batch,
            query: studioAppDbStore.query,
            compileDeleteAll: (table, access) => queryCompiler.compileDeleteAll(table, access),
            purgeAttachments: (ids) => purgeAttachments(app, ids, {
                listAttachments: studioAppDataStore.listAttachments,
                deleteAttachment: studioAppDataStore.deleteAttachment,
                deleteFile: storageStore.deleteFile,
                buildAttachmentKey: storageStore.buildStudioAppAttachmentKey,
            }),
            setRowCount: studioAppDataStore.setRowCount,
            bumpDataVersion: studioAppDataStore.bumpDataVersion,
            resetSyncStates: studioAppDataStore.resetSyncStates,
        });
        if ('status' in result) {
            const { status, ...body } = result;
            return res.status(status).json(body);
        }
        res.json(result);
    } catch (err) { handleErr(res, err, 'data.empty'); }
}

module.exports = { emptyData };
