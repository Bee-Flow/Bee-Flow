/**
 * POST /import: an app archive file into a live app (routes/studioApps/).
 *
 * Not the template import (./templates); the comment on the route says why.
 */

const express = require('express');
const log = require('../../telemetry/log');
const studioAppStore = require('../../stores/studioAppStore');
const { LIMITS } = require('../../appStudio/componentSpecs');
const { canonicalizeAppDefinition } = require('../../appStudio/canonicalize');
const { installTemplate } = require('../../appStudio/templateInstall');
const { sanitizeAppImport } = require('../../appStudio/appPortability');
const { installAppContent } = require('../../appStudio/appContentInstall');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { requireAuth } = require('../../auth/permissions');
const { requireManageApps, resolveOwnerOrgId } = require('./access');
const { sanitizeAppRow } = require('./appHelpers');
const { bestEffort } = require('../../utils/bestEffort');

const router = express.Router();

/**
 * POST /import — an app archive file → a live app in this organisation.
 *
 * Registered BEFORE the `/:id` routes so the literal "import" is never read as
 * an app id: the same route-order rule `/templates/import` follows above.
 *
 * THIS IS NOT THE TEMPLATE IMPORT, and the difference is the whole point of
 * having both. `/templates/import` puts a BLUEPRINT in the gallery, from which
 * anyone can create as many empty apps as they like. This takes a PARTICULAR
 * app — its rows, and the documents those rows are about — and stands it up
 * once, working. See appStudio/appPortability.js for why they are separate
 * formats with separate ceilings.
 *
 * There is no route that writes one of these files. An archive is built by a
 * script, by somebody with a shell on the server; the product can open one and
 * can never produce one, so no menu item turns a live app's customer data into
 * a file somebody can carry out of the building.
 *
 * ALL OR NOTHING, ON THE PART THAT MATTERS. `POST /` treats a failed data
 * install as best-effort, because an app with screens and no tables is still
 * an app somebody asked for. Here nobody asked for that: the archive IS the
 * data. So a data model that will not install takes the app row with it rather
 * than leaving a shell behind that reads as "the import forgot the tables".
 * Individual rows and files stay best-effort and are named in the report —
 * `appContentInstall.js` explains why that line is drawn where it is.
 *
 * Rate-limited hard: one call parses up to 20 MB, writes thousands of rows and
 * runs a malware scan per file. 3/min is unhurried for a person and useless as
 * a way to fill the disk.
 */
const appImportLimiter = perUserRateLimit({ windowMs: 60_000, max: 3 });
router.post('/import', requireAuth, requireManageApps, appImportLimiter, async (req, res) => {
    let created = null;
    try {
        const userId = req.session.user.id;
        const body = req.body || {};
        const envelope = (body && typeof body === 'object' && body.envelope !== undefined) ? body.envelope : body;

        const { app: appMeta, template, content, report, errors, warnings } = sanitizeAppImport(envelope);
        if (!template) {
            return res.status(400).json({ error: 'That file could not be imported', code: 'invalid_archive', details: errors });
        }

        // A name the importer chose wins over the one in the file — two copies
        // of the same demo is the common reason to import twice.
        const chosen = (typeof body.name === 'string' && body.name.trim())
            ? body.name.trim().slice(0, LIMITS.MAX_NAME_LEN) : null;
        const name = chosen || appMeta.name || template.title || 'Imported app';

        const copy = JSON.parse(JSON.stringify(template.definition));
        copy.meta = { ...(copy.meta || {}), name };
        const definition = canonicalizeAppDefinition(copy).def;

        // Owner and organisation are facts of THIS installation, read from the
        // session and never from the file.
        const organizationId = await resolveOwnerOrgId(userId);
        created = await studioAppStore.createStudioApp({
            userId,
            organizationId,
            name,
            description: appMeta.description || template.description || '',
            icon: appMeta.icon || definition.meta?.icon || null,
            accentColor: appMeta.accentColor || null,
            definition,
            // No template provenance stamp: an archive is not a template, so
            // there is nothing here that a one-click template upgrade could
            // ever be offered against.
        });

        const install = await installTemplate({ appId: created.id, ownerId: userId, template });
        if (!install || !install.ok) {
            const why = (install && install.error) || 'unknown error';
            await studioAppStore.deleteStudioApp(created.id, userId).catch((e) => bestEffort('routes/studioApps/appImport:anon', e));
            created = null;
            return res.status(422).json({ error: `The app's data model could not be installed: ${why}`, code: 'model_install_failed' });
        }

        const model = template.dataModel || null;
        const app = await studioAppStore.getStudioApp(created.id);
        const filled = await installAppContent({ app, model, content });
        if (!filled.ok) {
            // The rows stopped part-way (a quota, a ceiling). The app and what
            // did land stay — deleting it would throw away the half that works
            // and tell the importer nothing about why.
            log.warn(`[StudioApps] Archive content install incomplete for ${created.id}: ${filled.error}`);
        }

        res.status(201).json({
            success: true,
            app: sanitizeAppRow(app),
            report: {
                ...report,
                installed: { rows: filled.rows, files: filled.files, dataModelVersion: install.dataModelVersion },
            },
            warnings: [
                ...warnings,
                ...(filled.error ? [filled.error] : []),
                ...filled.skipped,
            ],
        });
    } catch (err) {
        // An app created before the failure is not left behind: a half-imported
        // app nobody asked for is worse than an import that plainly failed.
        if (created) {
            await studioAppStore.deleteStudioApp(created.id, req.session.user.id).catch((e) => bestEffort('routes/studioApps/appImport:anon#2', e));
        }
        const message = err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : 'Failed to import app';
        if (/limit reached|exceeds|quota/i.test(message)) {
            return res.status(409).json({ error: message, code: 'app_limit' });
        }
        throw err;
    }
});

module.exports = router;
