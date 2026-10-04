/**
 * POST /agents/:id/publish-version — copy the concept into the published
 * columns (A1 concept/live split).
 *
 * Two different "publish" verbs live on an agent and this is the second one:
 *   PATCH /agents/:id/publish          AUDIENCE  — who may see/chat with it
 *                                      (is_published + shared_groups).
 *   POST  /agents/:id/publish-version  CONTENT   — which config/system_prompt
 *                                      the runtime serves.
 *
 * Until an agent's first publish-version the runtime follows the concept
 * (agentStore.getForRuntime), so this endpoint is what flips an agent into
 * split mode. After it, PUT /agents/:id keeps writing the concept only and
 * nothing reaches users until the next publish-version.
 *
 * owner_id='system' agents (support singleton, system agents) have no publish
 * button and always follow live → 409. Re-validates every cross-element
 * reference in the concept against the OWNER first, exactly like PATCH
 * /publish does: a KB the owner lost access to since the last save must not
 * become the config that runs.
 *
 * The request carries nothing: what is published is whatever the concept is
 * NOW, at the rev this route reads itself. A body is refused rather than
 * ignored, because the keys a caller would plausibly send (`expectedRev`,
 * `rev`, `config`) all look like they pin WHICH content goes live — and every
 * one of them was dropped under a 200 that published the current concept
 * instead.
 *
 * A reference the owner may not use is the one refusal this route writes
 * itself (validateAgentConfigReferences throws it with status 400). Any other
 * failure in that stretch — the retry's write included — is a server failure
 * and goes to the terminal handler as one; it used to be answered as a 400
 * carrying the raw error text, a database's own wording included.
 */

const express = require('express');
const agentStore = require('../../stores/agentStore');
const { requireActiveOrgForMutations } = require('../../auth');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { canModifyAgent, validateAgentConfigReferences, applyConfigValidation } = require('./crud');
const publishable = require('../../agents/publishableConfig');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** No body at all (Express 5 leaves `req.body` undefined then) or an empty one. */
const NoBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());
const NoQuery = z.object({}).strict();

const router = express.Router();

/**
 * The concept as it may go live: agents/publishableConfig.js, over the two
 * halves this router's crud.js exports (the same functions the concept save
 * runs). Throws what validateAgentConfigReferences throws.
 */
function publishableConfig(agent) {
    return publishable.publishableConfig(agent, { validateAgentConfigReferences, applyConfigValidation });
}

/** A refusal the validator wrote for the caller, or null for anything else. */
function callerRefusal(e) {
    return e && e.status >= 400 && e.status < 500 ? { status: e.status, error: e.message } : null;
}

// Same write gate as the CRUD router: a suspended/archived org publishes nothing.
router.use(requireActiveOrgForMutations());

router.post('/:id/publish-version', validate({ body: NoBody, query: NoQuery }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    if (!(await canModifyAgent(agent, userId, req))) {
        return res.status(403).json({
            error: 'You do not have permission to edit this agent.',
            code: 'agent_not_editable',
        });
    }

    if (agent.owner_id === 'system' || agent.owner_id === 'swarm') {
        return res.status(409).json({
            error: 'System agents always run their live configuration and cannot be published as a version.',
            code: 'system_agent_follows_live',
        });
    }

    // Anti-leak re-validation against the owner (not the requester).
    // Cross-org KBs hard-fail; unresolvable skills are dropped and tool
    // grants are clamped in the copy we publish (never in the concept —
    // that stays the editor's).
    let checked;
    try {
        checked = await publishableConfig(agent);
    } catch (e) {
        const refusal = callerRefusal(e);
        if (!refusal) throw e;
        return res.status(refusal.status).json({ error: refusal.error });
    }
    let warnings = checked.warnings;

    // Guard on the rev we validated. One retry on a concurrent save: the
    // second attempt re-reads and re-validates through the same path.
    let result = await agentStore.publishAgentVersion(agent.id, { expectedRev: Number(agent.rev) || 1, config: checked.config });
    if (result.conflict) {
        const fresh = await agentStore.getAgent(agent.id);
        if (!fresh) return res.status(404).json({ error: 'Agent not found' });
        let again;
        try {
            again = await publishableConfig(fresh);
        } catch (e) {
            const refusal = callerRefusal(e);
            if (!refusal) throw e;
            return res.status(refusal.status).json({ error: refusal.error });
        }
        warnings = again.warnings;
        result = await agentStore.publishAgentVersion(fresh.id, { expectedRev: Number(fresh.rev) || 1, config: again.config });
    }
    if (result.systemAgent) {
        return res.status(409).json({ error: 'System agents cannot be published as a version.', code: 'system_agent_follows_live' });
    }
    if (result.notFound) return res.status(404).json({ error: 'Agent not found' });
    if (result.conflict) {
        return res.status(409).json({
            error: 'The agent changed while publishing',
            conflict: true,
            currentVersion: result.currentRev,
        });
    }
    if (!result.ok) return res.status(500).json({ error: 'Failed to publish version' });

    // History row: the published state, never pruned (kind != autosave).
    try {
        const versionStore = require('../../stores/versionStore');
        await versionStore.createVersion(agent.id, 'agent', result.row, userId,
            `Published v${result.publishedVersion}`, { kind: 'published' });
    } catch (e) { log.error('[PublishVersion] version snapshot failed:', e.message); }

    // The prompt that runs just changed → re-check Art-50 disclosure now
    // instead of at the next sweep (only meaningful when it has an audience).
    if (agent.is_published) {
        try {
            const events = require('../../compliance/events');
            events.emit(events.EVENTS.AGENT_PUBLISHED, {
                orgId: agent.organization_id || 'default',
                agentId: agent.id,
            });
        } catch (_) { /* compliance bus is best-effort */ }
    }

    const rev = Number(result.row?.rev) || Number(agent.rev) || 1;
    const body = {
        success: true,
        publishedVersion: result.publishedVersion,
        publishedRev: result.publishedRev,
        publishedAt: result.publishedAt,
        rev,
        unpublishedChanges: Math.max(0, rev - result.publishedRev),
        runtimeSource: 'published',
    };
    res.json(warnings.length > 0 ? { ...body, warnings } : body);
});

module.exports = router;
