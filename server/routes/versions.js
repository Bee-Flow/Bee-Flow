/**
 * Version History API Routes
 * Endpoints for viewing and restoring agent version history.
 *
 * Access: an EDITOR surface, gated like the sibling agent write endpoints.
 * Version snapshots are raw agent rows — the CONCEPT system_prompt and config
 * (tool params regularly hold API keys) at historical points in time. The
 * concept/live split (A1) hands that draft view only to editors
 * (GET /agents/:id?draft=1 → canModifyAgent in routes/agents/crud.js), so the
 * history behind it carries the same gate — reads included: someone who may
 * merely chat with a published agent has no business in its edit history.
 * Chain: requireAuth on the router (anonymous → 401), then one
 * canModifyAgent call per route, exactly the routes/agents/publishVersion.js
 * idiom. The only client is the editor UI (agent-hub VersionHistory.jsx).
 *
 * What a caller may send: nothing. The three writes (pre-refine, restore,
 * delete) act on the agent and version named on the path, so their bodies are
 * pinned empty — a restore that carries `{ fields: ['system_prompt'] }` is a
 * caller that believes it is restoring part of a version, and it used to be
 * answered with a 200 for all of it. The two GETs read no query and stay open:
 * a `.strict()` there could only refuse a cache-buster.
 */

const express = require('express');
const router = express.Router();
const versionStore = require('../stores/versionStore');
const agentStore = require('../stores/agentStore');
const { requireAuth } = require('../auth');
const { getEffectiveUserId } = require('../utils/routeHelpers');
const { canModifyAgent } = require('./agents/crud');
const { validate } = require('../core/http/validate');
const { conflict } = require('../core/http/errors');
const { z } = require('zod');

/**
 * No body at all (Express 5 leaves `req.body` undefined then), or an empty
 * one. Every refusal is a sentence that names the keys it would have ignored.
 */
const noBody = (why) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({}, {
        errorMap: (issue) => ({
            message: issue.code === 'unrecognized_keys'
                ? `This request takes no body, so ${issue.keys.map((k) => `'${k}'`).join(', ')} would change nothing: ${why}`
                : `This request takes no body: ${why}`,
        }),
    }).strict(),
);
const PreRefineBody = noBody('the undo point is the agent exactly as it is now.');
const RestoreBody = noBody('the whole version on the path is restored.');
const DeleteBody = noBody('the version on the path is deleted.');

/**
 * An on/off setting as a snapshot stored it.
 *
 * A snapshot is the raw Postgres row, so a BOOLEAN column arrives as true or
 * false. The restore used to read `snapshot.embed_enabled !== 0` — a test
 * against the integer the SQLite era stored — and `false !== 0` is true. Every
 * restore therefore switched ON every setting that was off in the version, and
 * workspace_enabled and embed_enabled are off by default: restoring any version
 * of an ordinary agent made it embeddable and gave it a workspace. A snapshot
 * that does not carry the setting keeps what the agent has now.
 */
function storedFlag(value, current) {
    if (value === true || value === 1 || value === 't' || value === 'true') return true;
    if (value === false || value === 0 || value === 'f' || value === 'false') return false;
    return !!current;
}

// Anonymous callers stop here with a 401. Before this gate existed, version
// snapshots (system prompt included) were readable, restorable and deletable
// on guessed agent/version ids without any session at all.
router.use(requireAuth);

/**
 * Loads the agent behind :agentId and applies the per-agent write gate the
 * other agent endpoints use — one canModifyAgent(agent, userId, req) call
 * (owner, super-admin, or manage_agents within the agent's org). Responds
 * 404/403 itself and returns null so handlers can simply bail out; the 403
 * body mirrors sendAgentNotEditable in routes/agents/crud.js so clients can
 * translate it and flip into read-only mode.
 */
async function requireEditableAgent(req, res) {
    const agent = await agentStore.getAgent(req.params.agentId);
    if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return null;
    }
    const userId = getEffectiveUserId(req);
    if (!(await canModifyAgent(agent, userId, req))) {
        res.status(403).json({
            error: 'You do not have permission to edit this agent.',
            code: 'agent_not_editable',
        });
        return null;
    }
    return agent;
}

// GET /versions/:agentId — List all versions for an agent
router.get('/:agentId', async (req, res) => {
    if (!(await requireEditableAgent(req, res))) return;
    const versions = await versionStore.getVersions(req.params.agentId);
    res.json(versions);
});

/**
 * POST /versions/:agentId/pre-refine — het undo-punt van een AI-verfijning.
 *
 * De verfijn-rail roept dit aan VÓÓR hij de gemergede staat wegschrijft, zodat
 * "Ongedaan maken" een gewone restore van deze rij is (kind 'pre_refine', die
 * pruneVersions nooit opruimt). Bewust een eigen route en geen vlag op de
 * wizard-route: die is stateloos en kent de agent niet, en dit is een SCHRIJF
 * op één agent — dus door dezelfde per-agent poort als restore en delete.
 *
 * Het antwoord draagt de version-id. Lukt de snapshot niet, dan hoort de client
 * dat te weten en zijn undo-knop te laten zeggen dat er niets te herstellen is;
 * een stilzwijgend "ok" zou een knop opleveren die later iets ANDERS herstelt.
 */
router.post('/:agentId/pre-refine', validate({ body: PreRefineBody }), async (req, res) => {
    const agent = await requireEditableAgent(req, res);
    if (!agent) return;
    // De snapshot leest de RAUWE agentrij (persona-kolom incl.) — zie
    // stores/agent/agentCrud.snapshotAgent voor waarom dat niet de
    // weergave van getAgent() mag zijn.
    const created = await agentStore.snapshotAgent(agent.id, getEffectiveUserId(req), {
        kind: 'pre_refine', changeSummary: 'Before AI refine',
    });
    if (!created) return res.status(404).json({ error: 'Agent not found' });
    res.json({ id: created.id, version_number: created.version_number, kind: created.kind });
});

// GET /versions/:agentId/:versionId — Get full snapshot of a specific version
router.get('/:agentId/:versionId', async (req, res) => {
    if (!(await requireEditableAgent(req, res))) return;
    const version = await versionStore.getVersion(req.params.versionId);
    if (!version) return res.status(404).json({ error: 'Version not found' });
    if (version.agent_id !== req.params.agentId) return res.status(404).json({ error: 'Version not found for this agent' });
    res.json(version);
});

// POST /versions/:agentId/:versionId/restore — Restore agent to a specific version
router.post('/:agentId/:versionId/restore', validate({ body: RestoreBody }), async (req, res, next) => {
    const agent = await requireEditableAgent(req, res);
    if (!agent) return;
    const version = await versionStore.getVersion(req.params.versionId);
    if (!version) return res.status(404).json({ error: 'Version not found' });
    if (version.agent_id !== req.params.agentId) return res.status(404).json({ error: 'Version not found for this agent' });

    const snapshot = version.snapshot;
    const agentType = version.agent_type;

    // The structured role travels WITH the prompt (A1c). Persona is the
    // source `system_prompt` is generated from, so restoring one without
    // the other leaves the editor showing fields that describe a prompt
    // that is no longer there — and the next save would render those stale
    // fields straight back over the restored text. A snapshot taken before
    // the column existed restores `null`, which is not a loss: the row then
    // reads back as free mode over the prompt it just got.
    const restoredPersona = (() => {
        const p = snapshot && snapshot.persona;
        if (p === undefined || p === null || p === '') return null;
        if (typeof p === 'string') { try { return JSON.parse(p); } catch (_) { return null; } }
        return typeof p === 'object' && !Array.isArray(p) ? p : null;
    })();

    switch (agentType) {
        case 'agent': {
            // Restore writes the CONCEPT (updateAgent → config/system_prompt),
            // never the published_* columns: in the concept/live split a
            // restore is an edit, and it reaches users on the next
            // POST /agents/:id/publish-version. That is also what makes it
            // the undo of an AI refine (kind:'pre_refine' snapshots).
            //
            // Who may see the agent is NOT part of that edit. organization_id
            // and shared_groups are access decisions, never split into a
            // concept and a live copy (stores/agent/agentCrud getForRuntime),
            // so writing them from the snapshot changed access the moment the
            // restore landed: a version from before the agent was narrowed to
            // one group handed it back to the whole organisation (`[]` means
            // everyone), and a version from before the agent had an org — the
            // org is only assigned on its first save — took it out of the org
            // altogether. Both are passed as `undefined`, updateAgent's
            // "preserve" (as the category always was).
            //
            // The owner is the CURRENT one. updateAgent does not write owner_id,
            // it matches on it; the snapshot's owner no longer matches once the
            // agent changed hands (leave-org transfer), and the write then
            // touched no row while the route still answered success.
            const result = await agentStore.updateAgent(
                req.params.agentId,
                snapshot.name,
                snapshot.description,
                snapshot.system_prompt,
                agent.owner_id,
                snapshot.model,
                typeof snapshot.starter_prompts === 'string' ? JSON.parse(snapshot.starter_prompts || '[]') : (snapshot.starter_prompts || []),
                snapshot.avatar,
                storedFlag(snapshot.threads_enabled, agent.threads_enabled),
                storedFlag(snapshot.copy_enabled, agent.copy_enabled),
                storedFlag(snapshot.workspace_enabled, agent.workspace_enabled),
                typeof snapshot.config === 'string' ? JSON.parse(snapshot.config || '{}') : (snapshot.config || {}),
                storedFlag(snapshot.embed_enabled, agent.embed_enabled),
                undefined, // organizationId: preserve — see above
                undefined, // sharedGroups: preserve — see above
                // categoryId: `undefined` = preserve (updateAgent's
                // undefined-means-preserve rule — a restore has never
                // carried the category and must not start clearing it).
                undefined,
                { persona: restoredPersona },
            );
            if (!result || !result.ok) {
                return next(conflict('restore_not_applied', 'The agent changed while this version was being restored. Reload it and try again.'));
            }
            break;
        }

        default:
            return res.status(400).json({ error: `Unknown or unsupported agent type: ${agentType}` });
    }

    res.json({ success: true, restoredTo: version.version_number });
});



// DELETE /versions/:agentId/:versionId — Delete a specific version
router.delete('/:agentId/:versionId', validate({ body: DeleteBody }), async (req, res) => {
    if (!(await requireEditableAgent(req, res))) return;
    // Bind the version to :agentId BEFORE deleting (same check as the GET
    // and restore routes). Without it the per-agent gate above is hollow:
    // an editor of agent X could delete any version of agent Y by passing
    // their own X as :agentId — deleteVersion() only takes the version id.
    const version = await versionStore.getVersion(req.params.versionId);
    if (!version) return res.status(404).json({ error: 'Version not found' });
    if (version.agent_id !== req.params.agentId) return res.status(404).json({ error: 'Version not found for this agent' });
    const deleted = await versionStore.deleteVersion(req.params.versionId);
    if (!deleted) return res.status(404).json({ error: 'Version not found' });
    res.json({ success: true });
});

module.exports = router;
