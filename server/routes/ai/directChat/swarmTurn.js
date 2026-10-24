/**
 * Direct Chat — the Swarm tier branch of the streaming turn.
 *
 * When the user picked the "Swarm" tier in the model dropdown, the entire
 * turn runs through the swarm runtime instead of the regular direct-chat
 * pipeline. Moved verbatim out of streamTurn.js; every path in this branch
 * ends the response itself, so the caller returns right after awaiting it.
 */

const agentStore = require('../../../stores/agentStore');
const { encryptionOpts } = require('./shared');
const chatSignalsTurn = require('./chatSignalsTurn');
const log = require('../../../telemetry/log');
const { HttpError } = require('../../../core/http/errors');
const { openSse } = require('../../../core/http/sseHelpers');
const { turnTierRefusal } = require('../../../core/llm/resolveTurnModel');

async function runSwarmTierTurn({ req, res, userId, message, conversationId, attachments }) {
        const { runSwarmTurn, loadSwarmById } = require('../../../core/swarms/swarmRuntime');
        const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
        const { resolveModelForTier: resolveSwarmTierModel } = require('../../../core/llm/modelResolver');

        // Beta gate (defensive — `tiers-for-user` already hides the Swarm
        // tier from the dropdown when this feature is off, but never trust
        // the client).
        const allowed = await userHasBetaFeature(userId, 'swarm', req.session).catch(() => false);
        if (!allowed) {
            return res.status(403).json({ error: 'Swarm Agents beta is not enabled for your organisation.' });
        }
        // Group gate: a group whose Allowed tiers leave Swarm out refuses it,
        // as every other named tier (core/llm/resolveTurnModel).
        const tierRefusal = await turnTierRefusal({ tier: 'swarm', userId });
        if (tierRefusal) {
            return res.status(tierRefusal.status).json({ error: tierRefusal.error, code: tierRefusal.code });
        }
        const swarmId = 'builtin:research_swarm';
        const swarmEntry = loadSwarmById(swarmId);
        if (!swarmEntry) {
            throw new HttpError(500, 'swarm_misconfigured', `Swarm runtime is misconfigured: ${swarmId} not registered.`);
        }

        // Resolve the Swarm tier's configured model (used as a fallback
        // any time a worker's tier doesn't resolve to a specific model).
        let fallbackModelId = null;
        let userOrgId = null;
        try {
            // Need the user's org for EU-aware resolution. Resolve it cheaply
            // here — we don't need the full Flow tier-resolution dance.
            const userStoreLocal = require('../../../stores/userStore');
            const localUser = await userStoreLocal.getUser(userId).catch(() => null);
            userOrgId = localUser?.organizationId || null;
            fallbackModelId = await resolveSwarmTierModel('tier:swarm', { userOrgId, userId, fallbackTier: 'fast' });
        } catch (e) {
            log.warn('[DirectChat/Swarm] tier model resolution failed:', e.message);
        }
        if (!fallbackModelId) {
            return res.status(400).json({ error: 'No model is configured for the Swarm tier. Ask an admin to set one in Chat Model Tiers → Swarm (Direct).' });
        }

        // Chat signals: the swarm's workers get the message without an input
        // scan, so the turn counts as 'unscanned' with an unknown destination.
        // Fire-and-forget (./chatSignalsTurn.js); the marker and the opt-out
        // come from the same body as a regular direct turn.
        chatSignalsTurn.countFixedTurn({ req, userId, surface: 'direct', outcome: 'unscanned', providerConfig: null });

        // SSE handshake: the same head as the regular direct-chat path
        // (streamTurn.js). No keep-alive here, as before this branch moved
        // onto openSse.
        const { send } = openSse(res);

        // Load (or create) conversation + restore prior Hive Mind state.
        let convId = conversationId;
        let hiveMind = null;
        if (convId) {
            try {
                const existingConv = await agentStore.getDirectConversation(convId, userId, encryptionOpts(req));
                if (existingConv && existingConv.hiveMind && typeof existingConv.hiveMind === 'object') {
                    hiveMind = existingConv.hiveMind;
                }
            } catch (err) { log.debug('ignore — proceed with fresh state', err); }
        }

        try {
            const result = await runSwarmTurn({
                swarmId,
                message,
                hiveMind,
                send,
                userId,
                session: req.session,
                isAdmin: !!req.session?.isAdmin,
                fallbackModelId,
                userOrgId,
                resolvedTier: 'swarm',
                organizationId: userOrgId,
                conversationId: convId || null,
            });

            // Persist updated state on the conversation (best-effort; failure
            // here mustn't abort the response — the user already saw the answer).
            try {
                if (!convId) {
                    const created = await agentStore.createDirectConversation(userId, 'swarm');
                    convId = created?.id || null;
                    if (convId) send('conversation_created', { conversationId: convId });
                }
                if (convId) {
                    const existingConv = await agentStore.getDirectConversation(convId, userId, encryptionOpts(req));
                    const messages = Array.isArray(existingConv?.messages) ? [...existingConv.messages] : [];
                    if (!result.paused && typeof result.finalText === 'string' && result.finalText.length > 0) {
                        messages.push({
                            role: 'user',
                            content: message,
                            attachments: attachments || [],
                            timestamp: new Date().toISOString(),
                        });
                        messages.push({
                            role: 'assistant',
                            content: result.finalText,
                            metadata: { swarmId },
                            // Top-level `swarm` field mirrors what useChatEngine
                            // builds from SSE during a live run, so when the
                            // conversation reloads from DB the assistant message
                            // already has everything SwarmTimeline needs to
                            // re-render the worker grid + tool calls.
                            swarm: result.snapshot || null,
                            timestamp: new Date().toISOString(),
                        });
                    }
                    await agentStore.updateDirectConversation(convId, messages, userId, {
                        swarmId,
                        hiveMind: result.hiveMind,
                    }, encryptionOpts(req));
                }
            } catch (persistErr) {
                log.warn('[DirectChat/Swarm] persist failed:', persistErr.message);
            }

            send('done', {});
            return res.end();
        } catch (err) {
            log.error('[DirectChat/Swarm] run failed:', err);
            send('error', { error: err.message || 'Swarm execution failed' });
            return res.end();
        }
}

module.exports = { runSwarmTierTurn };
