/**
 * The Versions tab (Studio → Automations handoff 5, artboard 5d).
 *
 *   GET /:id/versions                        the history, grouped-ready
 *   GET /:id/versions/:ref                   one version, read-only
 *   GET /:id/versions/:ref/fielddiff/:other  per-field changes of :ref against :other
 *   PUT /:id/versions/:ref/name              name a version (a milestone), null clears it
 *
 * A version reference (`:ref`, `:other`) is a version NUMBER, 'live' (the
 * version runs execute), 'working' (the one being edited) or, for the
 * read-only view and as before, a version row id.
 *
 * The working copy is the definition as saved, not its version row: a
 * layout-only save moves positions without writing a version
 * (automation/diffSummary.js planVersionWrite), so the row of the working
 * version can lag the canvas by a drag. The live version reads the live copy
 * for the same reason.
 *
 * Registered by versions.js. Handlers come from a factory so a test hands in
 * its own store and access guard.
 */

'use strict';

const { z } = require('zod');
const { HttpError } = require('../../core/http/errors');
const { fieldDiff, describeChange, isLayoutOnlyChange, stepIdsOf } = require('../../automation/diffSummary');

const MAX_NAME = 80;
const NAME_TEXT = `name is the milestone name (at most ${MAX_NAME} characters), or null to clear it.`;
const NameBody = z.object({
    name: z.string({ invalid_type_error: NAME_TEXT }).trim().max(MAX_NAME, NAME_TEXT).nullable(),
}).strict();

/** Agent ids → names, best-effort, for a diff that changed an agent. */
async function defaultResolveNames({ agent = [] }) {
    const out = { agent: {} };
    if (!agent.length) return out;
    let getAgent = null;
    try { getAgent = require('../../stores/agentStore').getAgent; } catch { return out; }
    for (const id of agent.slice(0, 20)) {
        try {
            const a = await getAgent(id);
            if (a && typeof a.name === 'string' && a.name.trim()) out.agent[id] = a.name.trim();
        } catch { /* a name is a nicety; the id stays */ }
    }
    return out;
}

function agentIdsOf(def) {
    const ids = new Set();
    const visit = (steps) => {
        for (const s of Array.isArray(steps) ? steps : []) {
            if (!s || typeof s !== 'object') continue;
            if (typeof s.agentId === 'string' && s.agentId) ids.add(s.agentId);
            if (s.type === 'loop') visit(s.body);
            if (s.type === 'parallel') for (const b of Array.isArray(s.branches) ? s.branches : []) visit(b);
        }
    };
    visit(def?.steps);
    for (const g of Object.values(def?.layers && typeof def.layers === 'object' ? def.layers : {})) visit(g?.steps);
    return [...ids];
}

/**
 * @param {{
 *   store: { getAutomation: Function, listVersions: Function, getVersion: Function,
 *            getVersionByNumber: Function, renameVersion: Function, countRunsByVersion: Function },
 *   access: { guard: (req, res, a, need) => Promise<object|null> },
 *   resolveNames?: (ids: { agent: string[] }) => Promise<{ agent?: Record<string, string> }>,
 *   log?: { warn: Function },
 * }} deps
 */
function makeVersionHistoryHandlers(deps) {
    const { store, access } = deps;
    const resolveNames = deps.resolveNames || defaultResolveNames;
    const log = deps.log || require('../../telemetry/log');

    async function load(req, res, need) {
        const a = await store.getAutomation(req.params.id);
        if (!a) { res.status(404).json({ error: 'Not found' }); return null; }
        if (!await access.guard(req, res, a, need)) return null;
        return a;
    }

    function flagsFor(a, version) {
        const isLive = a.liveVersion != null && version === a.liveVersion;
        return {
            isLive,
            liveSince: isLive ? (a.liveAt || null) : null,
            isEditing: version === a.version,
        };
    }

    /** The definition a version stands for (see the header on working and live). */
    function effectiveDefinition(a, version, row) {
        if (version === a.version && a.definition) return a.definition;
        if (a.liveVersion != null && version === a.liveVersion && a.liveDefinition) return a.liveDefinition;
        return row?.definition || {};
    }

    /**
     * Resolve a reference to `{ version, row, definition }`, or throw 404/400.
     * A version row that went missing (legacy routines) still resolves for the
     * working and live copies, which are on the routine itself.
     */
    async function resolveRef(a, ref) {
        let n = null;
        let row = null;
        if (ref === 'live') {
            if (a.liveVersion == null) throw new HttpError(404, 'never_live', 'This routine has never been live.');
            n = a.liveVersion;
        } else if (ref === 'working' || ref === 'current') {
            n = a.version;
        } else if (/^\d{1,9}$/.test(ref)) {
            n = Number(ref);
        } else {
            row = await store.getVersion(ref);
            if (!row) throw new HttpError(404, 'version_not_found', 'Version not found');
            if (row.automationId !== a.id) throw new HttpError(400, 'version_mismatch', 'Version does not belong to this automation');
            n = row.version;
        }
        if (!row) row = await store.getVersionByNumber(a.id, n);
        const onRoutine = n === a.version || (a.liveVersion != null && n === a.liveVersion);
        if (!row && !onRoutine) throw new HttpError(404, 'version_not_found', 'Version not found');
        return { version: n, row, definition: effectiveDefinition(a, n, row) };
    }

    async function list(req, res) {
        const a = await load(req, res, 'view');
        if (!a) return;
        const rows = await store.listVersions(a.id);
        let runs = null;
        try { runs = await store.countRunsByVersion(a.id); }
        catch (e) { log.warn(`[automation versions] run counts for ${a.id}: ${e.message}`); }
        const versions = rows.map((r) => ({
            ...r,
            savedBy: r.savedBy || { id: r.savedByUserId || null, name: r.savedByName || null },
            ...flagsFor(a, r.version),
            runs: runs ? (runs.get(r.version) || { total: 0, failed: 0 }) : null,
        }));
        res.json({
            versions,
            liveVersion: a.liveVersion ?? null,
            workingVersion: a.version ?? null,
            pendingChanges: a.pendingChanges ?? 0,
        });
    }

    async function getOne(req, res) {
        const a = await load(req, res, 'view');
        if (!a) return;
        const { version, row, definition } = await resolveRef(a, req.params.versionId);
        res.json({
            version: {
                ...(row || { id: null, automationId: a.id, version, savedByUserId: null, savedAt: null, name: null, description: null, descriptionJson: null, isLayoutOnly: false }),
                version,
                definition,
                ...flagsFor(a, version),
                readOnly: true,
            },
        });
    }

    async function diff(req, res) {
        const a = await load(req, res, 'view');
        if (!a) return;
        const target = await resolveRef(a, req.params.versionId);
        const base = await resolveRef(a, req.params.other);
        let changes = fieldDiff(base.definition, target.definition);
        if (changes.some((c) => c.path === 'agentId')) {
            try {
                const names = await resolveNames({ agent: [...new Set([...agentIdsOf(base.definition), ...agentIdsOf(target.definition)])] });
                changes = fieldDiff(base.definition, target.definition, { names });
            } catch (e) { log.warn(`[automation versions] agent names for ${a.id}: ${e.message}`); }
        }
        const layoutOnly = changes.length === 0 && isLayoutOnlyChange(base.definition, target.definition);
        const described = describeChange(changes, { reordered: changes.length === 0 && !layoutOnly });
        res.json({
            version: target.version,
            other: base.version,
            changes,
            stepIds: stepIdsOf(changes),
            descriptionJson: described.entries,
            description: described.text,
            layoutOnly,
        });
    }

    async function rename(req, res) {
        const a = await load(req, res, 'edit');
        if (!a) return;
        const ref = req.params.versionId;
        if (!/^\d{1,9}$/.test(ref)) throw new HttpError(400, 'invalid_version', 'Name a version by its number.');
        const parsed = NameBody.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, 'invalid_request', parsed.error.issues[0]?.message || NAME_TEXT);
        const name = parsed.data.name && parsed.data.name.length ? parsed.data.name : null;
        const out = await store.renameVersion(a.id, Number(ref), name);
        if (!out) throw new HttpError(404, 'version_not_found', 'Version not found');
        res.json({ version: { ...out, ...flagsFor(a, out.version) } });
    }

    return { list, getOne, diff, rename };
}

module.exports = { makeVersionHistoryHandlers, defaultResolveNames, agentIdsOf, MAX_NAME };
