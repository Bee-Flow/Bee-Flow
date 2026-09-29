/**
 * Module frontend runtime manifest — the pinned FE-RUNTIME contract the SPA
 * reads to lazy-mount remote modules that ship a frontend.
 *
 * GET /api/modules/frontend  (any authenticated user)
 *   → { rev, modules: [{ id, version,
 *        studioApp: { urlSegment, labels:{en,nl}, icon, gateCapability },
 *        entryUrl, cssUrls: [] }] }
 *
 * `rev` is a stable digest of the (id, version) set — the SPA's module
 * registry compares it across refetches and remounts remote Studio apps when
 * a hot-swap changed a version underneath them.
 *
 * Lists ONLY active (imported + currently-entitled) remote modules that declare
 * a `frontend.entry`. Asset URLs point at /api/module-assets/<id>/<version>/…
 * so the version is content-addressed and cacheable-immutable.
 *
 * ── A failed read is a 500, never an empty list ─────────────────────────
 *
 * The module-state read used to be wrapped in `catch → []`, so a database
 * blip was answered `200 { modules: [] }` — "nothing is installed". The SPA
 * (moduleRuntime/registry.js) keeps its last-good set on a 5xx precisely so a
 * transient failure does not blank the UI, and it replaces the set on a 200:
 * every remote Studio app tab vanished until the next auth change refetched.
 * The error now reaches the terminal handler like any other.
 *
 * The route takes no query, and says so: the SPA sends none, and a key such
 * as `?includeInactive=1` has no reading here that is not "ignored".
 */

'use strict';

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../auth/permissions');
const modules = require('../modules');
const remoteCatalog = require('../modules/remoteCatalog');
const store = require('../stores/platformModuleStore');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const NO_QUERY_TEXT = 'The module manifest takes no parameters.';
/** Nothing. Said rather than left out: an ignored key is a promise. */
const NO_QUERY = z.object({}).strict(NO_QUERY_TEXT);

function assetBase(id, version) {
    return `/api/module-assets/${encodeURIComponent(id)}/${encodeURIComponent(version)}/frontend`;
}
function assetUrl(base, rel) {
    return `${base}/${String(rel).replace(/^\/+/, '')}`;
}
// The default Studio-tab glyph for a module that declares none. Must be a key
// of the SPA's ICON_MAP (moduleRuntime/registry.js); 'box' is not one.
const DEFAULT_ICON = 'boxes';
function iconName(v) {
    return !v || v === 'box' ? DEFAULT_ICON : v;
}

router.get('/frontend', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    const rows = await store.getAllStates();

    const out = [];
    for (const row of rows) {
        if (!remoteCatalog.isRemoteRow(row)) continue;
        // Runtime source of truth: imported + entitled (timestamp gate).
        if (!(await modules.isModuleActive(row.moduleId))) continue;

        const entry = remoteCatalog.entryFromRow(row);
        const fe = entry && entry.frontend;
        if (!fe || !fe.entry || !entry.version) continue;

        // StudioApp presentation fields live NESTED under `frontend.studioApp`
        // in the manifest schema (preserved verbatim through packageLoader's
        // _manifestSummary → remoteCatalog.entryFromRow). Read them from there,
        // keeping the same fallbacks (urlSegment → module id, labels → name,
        // gate → first capability id).
        const sa = fe.studioApp || {};
        const base = assetBase(entry.id, entry.version);
        out.push({
            id: entry.id,
            version: entry.version,
            studioApp: {
                urlSegment: sa.urlSegment || entry.id,
                labels: {
                    en: (sa.labels && sa.labels.en) || entry.name,
                    nl: (sa.labels && sa.labels.nl) || (sa.labels && sa.labels.en) || entry.name,
                },
                // 'boxes', not 'box': the SPA resolves names against
                // moduleRuntime/registry.js ICON_MAP, which has no 'box'
                // — the old default (and remoteCatalog.entryFromRow's
                // 'box' fallback for entry.icon) rendered as the Puzzle
                // fallback for every icon-less module.
                icon: iconName(sa.icon || entry.icon),
                gateCapability: sa.gateCapability || (entry.capabilityIds && entry.capabilityIds[0]) || null,
            },
            entryUrl: assetUrl(base, fe.entry),
            cssUrls: Array.isArray(fe.css) ? fe.css.map(c => assetUrl(base, c)) : [],
        });
    }
    const rev = require('crypto').createHash('sha256')
        .update(out.map(m => `${m.id}@${m.version}`).sort().join(','))
        .digest('hex').slice(0, 16);
    res.json({ rev, modules: out });
});

module.exports = router;
