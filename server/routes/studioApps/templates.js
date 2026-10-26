// @typecheck strict
/**
 * Catalog and template gallery: read, delete, export, import (routes/studioApps/).
 *
 * Static paths, mounted before any /:id route (see ../studioApps.js).
 */

const express = require('express');
const { validate } = require('../../core/http/validate');
const userStore = require('../../stores/userStore');
const { buildCatalog } = require('../../appStudio/componentSpecs');
const { templateVersion } = require('../../appStudio/templates');
const { listAvailableTemplates, resolveTemplate } = require('../../appStudio/templateRegistry');
const studioAppTemplateStore = require('../../stores/studioAppTemplateStore');
const { buildExport, sanitizeImport, exportFilename } = require('../../appStudio/templatePortability');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { requireAuth } = require('../../auth/permissions');
const { DownloadQuery } = require('./schemas');
const { requireManageApps, audienceFor, resolveOwnerOrgId } = require('./access');
const { fallback } = require('../../utils/bestEffort');
const { sessionUser } = require('../../core/http/sessionUser');

const router = express.Router();

// ── Catalog & templates (static — before any /:id route) ───────────

router.get('/catalog', requireAuth, (req, res) => {
    res.set('Cache-Control', 'private, max-age=3600');
    res.json(buildCatalog());
});

// The gallery is BOTH halves at once: the built-in starters plus whatever this
// organisation captured from its own apps (app_save_as_template). See
// appStudio/templateRegistry.js — a captured template installs by exactly the
// same path, so nothing below this line needs to know which kind it got.
router.get('/templates', requireAuth, async (req, res) => {
    const { userId, orgIdArr } = await audienceFor(req);
    res.json({ templates: await listAvailableTemplates({ userId, orgIds: orgIdArr }) });
});

router.get('/templates/:templateId', requireAuth, async (/** @type {import('express').Request<{ templateId: string }>} */ req, res) => {
    const { userId, orgIdArr } = await audienceFor(req);
    const template = await resolveTemplate(req.params.templateId, { userId, orgIds: orgIdArr });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
});

// Deleting a CAPTURED template — the creator, or an admin of the org it was
// shared with. Built-in templates are code and have no delete: a 404 for a
// non-utpl_ id is the honest answer rather than a 403 implying it might work
// with more rights.
router.delete('/templates/:templateId', requireAuth, requireManageApps, async (req, res) => {
    const userId = sessionUser(req).id;
    const { orgIdArr } = await audienceFor(req);
    const templateId = /** @type {string} */ (req.params.templateId);
    if (!studioAppTemplateStore.isCapturedTemplateId(templateId)) {
        return res.status(404).json({ error: 'Template not found' });
    }
    const existing = await studioAppTemplateStore.getTemplateById(templateId);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    // An org admin may clear out a template a departed colleague left in
    // the org's gallery; the store's own rule is creator-only.
    const isOrgAdmin = !!sessionUser(req).isSuperAdmin
        || (sessionUser(req).isOrgAdmin && existing.organizationId
            && orgIdArr.includes(existing.organizationId));
    const out = await studioAppTemplateStore.deleteTemplate(templateId, userId, { force: isOrgAdmin });
    if (out.notFound) return res.status(404).json({ error: 'Template not found' });
    if (out.forbidden) return res.status(403).json({ error: 'Only the template\'s creator can delete it' });
    res.json({ success: true });
});

/**
 * GET /templates/:templateId/export — the template as a portable FILE.
 *
 * Reading a template you may install is what this is; it produces the same
 * substance `GET /templates/:templateId` already hands the editor, written in
 * the interchange format and scrubbed once more on the way out
 * (appStudio/templatePortability.js). So the gate is the same visibility check
 * the read route uses — a template you cannot see 404s — plus `manage_apps`,
 * because shipping a template to another installation is authoring, not using.
 *
 * `download=1` sets Content-Disposition so a browser saves it under the
 * template's own name, and answers with the envelope ALONE — what the scrub
 * cleared is news for the person exporting, and a note folded into the file
 * would travel to the recipient as though it were part of the template. The
 * default JSON shape is the one that carries the warnings, which is why the
 * editor uses it and saves the file itself.
 */
router.get('/templates/:templateId/export', requireAuth, requireManageApps, validate({ query: DownloadQuery }),
    require('../../compliance/dataPortability/stampExport')('app_templates'),
    async (req, res) => {
        const { userId, orgIdArr } = await audienceFor(req);
        const template = await resolveTemplate(/** @type {string} */ (req.params.templateId), { userId, orgIds: orgIdArr });
        if (!template) return res.status(404).json({ error: 'Template not found' });

        // The organisation NAME is read here rather than in buildExport for
        // the reason manifest.withSource gives: a capture knows the thing it
        // captured, not the tenant it sat in, and the name is a courtesy to
        // the recipient ("this came from Acme") rather than anything the
        // format depends on.
        let orgName = null;
        // resolveOwnerOrgId, not `session.user.organizationId`: it is the
        // same answer for most people and the right one for a member whose
        // organisation comes from a group rather than the user row — and it
        // is what the import route on the other side uses to decide where a
        // template lands, so the two halves agree on what "your
        // organisation" means.
        const orgId = await resolveOwnerOrgId(userId);
        if (orgId) {
            try {
                const org = await userStore.getOrganization(orgId);
                orgName = (org && typeof org.name === 'string') ? org.name : null;
            } catch (err) { fallback('routes/studioApps/templates:anon', err); /* a missing name is a missing courtesy, not a failed export */ }
        }

        const { envelope, warnings } = buildExport(template, {
            exportedAt: new Date().toISOString(),
            source: { templateId: template.id, orgId, orgName, version: templateVersion(template) },
        });
        if (!envelope) throw new Error('Template export produced no envelope');

        if (req.query.download === '1') {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(template)}"`);
            return res.send(JSON.stringify(envelope, null, 2));
        }
        res.json({ envelope, warnings, filename: exportFilename(template) });
    });

/**
 * POST /templates/import — take a template file into this organisation's
 * gallery, as a captured template like any other.
 *
 * Registered BEFORE `/templates/:templateId` would be reached by a POST, and
 * kept next to it so the literal "import" is never read as a template id — the
 * same route-order rule routes/automation/crud.js documents for its own import.
 *
 * WHAT THIS ROUTE DOES NOT DO is create an app. The file lands in the gallery
 * and the existing create-from-template path turns it into one, which means an
 * imported template installs through `studioApps.js` + `templateInstall.js`
 * exactly as a built-in does: one installer, three ways for a template to be
 * born. It also means importing once and creating five apps is the ordinary
 * case rather than five imports.
 *
 * The body is either a bare envelope or `{ envelope }` — a file read straight
 * off disk by a client is the first shape and a hand-written call tends to be
 * the second, and rejecting one of them would be a riddle rather than a rule.
 *
 * Rate-limited per user: an import validates a whole definition and writes a
 * multi-megabyte JSONB row, so 10/min is generous for a person and useless for
 * a script filling the org's hundred-template ceiling.
 */
const templateImportLimiter = perUserRateLimit({ windowMs: 60_000, max: 10 });
router.post('/templates/import', requireAuth, requireManageApps, templateImportLimiter, async (req, res) => {
    try {
        const userId = sessionUser(req).id;
        const body = req.body || {};
        const envelope = (body && typeof body === 'object' && body.envelope !== undefined) ? body.envelope : body;

        // The template is the one captureTemplate builds (appStudio/templateCapture.js),
        // which sanitizeImport declares only as a loose record.
        const { template, report, errors, warnings } = /** @type {{ template: { title: string, description: string, category: string, icon: string, tags: string[], definition: Record<string, any>, dataModel?: Record<string, unknown>, seed?: Record<string, unknown>, seedPeople?: Record<string, unknown>, datasets?: Array<Record<string, unknown>> } | null, report: Record<string, unknown> | null, errors: string[], warnings: string[] }} */ (sanitizeImport(envelope));
        if (!template) {
            return res.status(400).json({ error: 'That file could not be imported', code: 'invalid_template', details: errors });
        }

        // A name the importer chose wins over the one in the file: two copies of
        // the same template in one gallery is the common reason to import twice,
        // and a gallery of identical titles is not a gallery.
        const chosen = (typeof body.title === 'string' && body.title.trim())
            ? body.title.trim().slice(0, 80) : null;
        if (chosen) {
            template.title = chosen;
            if (template.definition && typeof template.definition === 'object') {
                template.definition.meta = { ...(template.definition.meta || {}), name: chosen };
            }
        }

        // The org of the importer, resolved the same way a capture resolves it,
        // so an imported template is visible to the colleagues who will install
        // it. A user with no organisation keeps it to themselves — the store's
        // own rule, not a special case here.
        const organizationId = await resolveOwnerOrgId(userId);

        const { definition, dataModel, seed, seedPeople, datasets } = template;
        const saved = await studioAppTemplateStore.saveTemplate({
            organizationId,
            createdBy: userId,
            // Imported, not captured: there is no app here it came from, and
            // writing one in would claim a provenance this installation cannot
            // vouch for.
            sourceAppId: null,
            title: template.title,
            description: template.description,
            category: template.category,
            icon: template.icon,
            tags: template.tags,
            payload: {
                definition,
                ...(dataModel ? { dataModel } : {}),
                ...(seed ? { seed } : {}),
                ...(seedPeople ? { seedPeople } : {}),
                ...(datasets ? { datasets } : {}),
            },
        });

        res.status(201).json({ template: saved, report, warnings });
    } catch (err) {
        const message = err && err.message ? err.message : 'Failed to import template';
        // The two ceilings the store enforces are the user's to act on (delete
        // one, or capture fewer seed tables), not a server fault.
        if (/limit reached|exceeds/i.test(message)) {
            return res.status(409).json({ error: message, code: 'template_limit' });
        }
        throw err;
    }
});

module.exports = router;
