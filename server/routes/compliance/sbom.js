// @typecheck
/**
 * Compliance — CRA Annex I Part II(1): download the software bill of materials
 * that ships with this build (located by compliance/lib/sbomLocator). The
 * artefact is platform-wide (one image, one SBOM), so there is nothing
 * org-specific to leak — but the download still sits behind the compliance
 * permission because it enumerates every dependency and version.
 */

// ── Why the two SBOM routes have no schema ───────────────────
//
// GET /sbom streams a file a browser NAVIGATES to, so a schema refusal (JSON,
// through the terminal error handler) would land inside the download. Neither
// route reads a parameter: the artefact that ships with the build is the only
// thing either of them can answer with.

const express = require('express');
const { sendStream } = require('../../core/http/sendStream');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { requireAuth, requirePermission } = require('../../auth/permissions');

const CONTENT_TYPES = Object.freeze({
    cyclonedx: 'application/vnd.cyclonedx+json',
    spdx: 'application/spdx+json',
    'licenses-md': 'text/markdown; charset=utf-8',
});

function _locator() {
    try {
        const mod = require('../../compliance/lib/sbomLocator');
        return typeof mod?.locate === 'function' ? mod : null;
    } catch {
        return null;
    }
}

/**
 * @param {string} format
 */
function contentTypeFor(format) {
    return CONTENT_TYPES[format] || 'application/json';
}

function filenameFor(found) {
    const base = path.basename(found?.path || 'sbom.json').replace(/[^A-Za-z0-9._-]/g, '_');
    if (found?.format === 'licenses-md' && !/\.md$/i.test(base)) return `${base}.md`;
    if (found?.format !== 'licenses-md' && !/\.json$/i.test(base)) return `${base}.json`;
    return base;
}

router.get('/sbom', requireAuth, requirePermission('admin_compliance'), async (req, res, next) => {
    try {
        const locator = _locator();
        if (!locator) return res.status(404).json({ error: 'sbom_not_found', message: 'No SBOM artefact ships with this build.' });
        const found = await locator.locate({ hash: true });
        if (!found?.path) {
            return res.status(404).json({ error: 'sbom_not_found', message: 'No SBOM artefact ships with this build.', tried: found?.tried || [] });
        }
        const stat = await fs.promises.stat(found.path).catch(() => null);
        if (!stat?.isFile()) return res.status(404).json({ error: 'sbom_not_found' });

        res.setHeader('Content-Type', contentTypeFor(found.format));
        res.setHeader('Content-Disposition', `attachment; filename="${filenameFor(found)}"`);
        res.setHeader('Content-Length', String(stat.size));
        res.setHeader('Cache-Control', 'no-store');
        if (found.sha256) res.setHeader('X-Content-SHA256', found.sha256);
        if (found.format) res.setHeader('X-SBOM-Format', found.format);
        const stream = fs.createReadStream(found.path);
        stream.on('error', (e) => {
            if (!res.headersSent) next(e);
            else res.destroy(e);
        });
        sendStream(stream, res);
    } catch (e) {
        if (!res.headersSent) next(e);
    }
});

router.get('/sbom/meta', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const locator = _locator();
    if (!locator) return res.status(404).json({ error: 'sbom_not_found' });
    const found = await locator.locate({ hash: true });
    if (!found?.path) return res.status(404).json({ error: 'sbom_not_found', tried: found?.tried || [] });
    res.json({
        format: found.format,
        filename: filenameFor(found),
        size: found.size,
        mtime: found.mtime,
        sha256: found.sha256 || null,
        components: typeof found.parsed?.component_count === 'number' ? found.parsed.component_count : null,
    });
});

module.exports = Object.assign(router, { contentTypeFor, filenameFor });

/** @typedef {import('express').Router & Record<string, unknown>} RouterExports */
