/**
 * Direct Chat — per-turn setup that runs BEFORE the SSE handshake:
 * EU-aware tier/model resolution (incl. auto-classification and the vision
 * override), provider/adapter resolution, conversation-ownership check and
 * subscription-limit enforcement. Moved verbatim out of streamTurn.js.
 *
 * Every early-exit path in here answers the response itself (a 400 JSON or
 * an SSE-shaped error) — the caller checks `res.headersSent` after awaiting
 * and stops when a path already responded.
 */

const {
    getAIConfig,
    getProviderForModel,
} = require('../../../core/aiAgent');
const configStore = require('../../../stores/configStore');
const { getAdapter } = require('../../../core/providers');
const agentStore = require('../../../stores/agentStore');
const { checkSubscriptionLimits, resolveOrgId } = require('../../../core/entitlements/limits');
const orgHealth = require('../../../services/orgHealth');
const log = require('../../../telemetry/log');

async function resolveTurnSetup({ req, res, userId, message, modelTier, conversationId, attachments }) {
    // EU mode + org privacy shield: resolve user's org early.
    const { resolveUserOrgIds: resolveOrgIdsForTiers } = require('../../../auth');
    require('../../../stores/userStore');
    const { getUserTierMap, resolveEffectiveOrgId } = require('../../../core/llm/modelResolver');
    // Raw membership set stays uncached — it's the KB-visibility authz input below.
    const orgIdsForTiers = await resolveOrgIdsForTiers(req);
    // Tier-org: reuse the set when present; else resolve + cache (super-admin /
    // no-direct-org fallback — the getAllGroups path, now memoised per user/~45s).
    let userOrgForTiers = orgIdsForTiers && orgIdsForTiers.size > 0
        ? Array.from(orgIdsForTiers)[0]
        : await resolveEffectiveOrgId(req, { userId });

    // Resolve model from tier config — EU-aware base tiers merged with
    // global/org custom tiers via the centralized resolver (getUserTierMap
    // is the single source of truth). The auto-classifier below still only
    // sees the standard tiers (see classifyTiers) so custom tiers can never
    // be auto-selected — they must be explicitly chosen by the user.
    let tiers = await getUserTierMap({ userOrgId: userOrgForTiers, userId });
    let disableSearchOnUpload = false;
    let webSearchGuardPiiCategories = null;
    if (userOrgForTiers) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`);
        if (shield?.enabled) {
            if (shield.euModeEnabled) {
                log.info(`[DirectChat] EU mode active for org ${userOrgForTiers}`);
            }
            disableSearchOnUpload = !!shield.disableSearchOnUpload;
            if (disableSearchOnUpload) log.info(`[DirectChat] Org ${userOrgForTiers}: disableSearchOnUpload=true`);
            if (Array.isArray(shield.webSearchGuardPiiCategories) && shield.webSearchGuardPiiCategories.length > 0) {
                webSearchGuardPiiCategories = shield.webSearchGuardPiiCategories;
                log.info(`[DirectChat] Org ${userOrgForTiers}: webSearchGuardPiiCategories=${webSearchGuardPiiCategories.length} categories (monitoring${shield.webSearchGuardEnabled ? ' + blocking' : ' only'})`);
            }
        }
    }
    let resolvedTier = modelTier || 'fast';

    // Defensive gate: the Flow tier (key 'standard') requires BOTH:
    //   - `flow`   — the tier opt-in beta feature
    //   - `skills` — the runtime dependency (Flow bootstraps chat-local
    //                session skills; see the session-skill setup in
    //                toolStackAssembly.js)
    // The frontend already hides the option when either is ungranted — this
    // just stops a hand-crafted request.
    if (resolvedTier === 'standard') {
        const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
        const [hasFlow, hasSkills] = await Promise.all([
            userHasBetaFeature(userId, 'flow', req.session).catch(() => false),
            userHasBetaFeature(userId, 'skills', req.session).catch(() => false),
        ]);
        if (!hasFlow || !hasSkills) {
            log.warn(`[DirectChat] User ${userId} requested Flow tier without required betas (flow=${hasFlow}, skills=${hasSkills}) — falling back to fast`);
            resolvedTier = 'fast';
        }
    }

    // Auto mode: classify which tier to use
    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../../core/llm/promptClassifier');
            // Strip custom tiers — they require explicit user choice and must never
            // win automatic selection. Swarm is also excluded (auto must never
            // spend the cost of a multi-agent swarm without the user asking).
            // Flow (standard) IS eligible for auto, but the classifier is
            // instructed to reserve it for clear multi-stage tasks.
            const classifyTiers = Object.fromEntries(
                Object.entries(tiers).filter(([k]) => !k.startsWith('custom:') && k !== 'swarm')
            );
            const result = await classifyWithLLM(message, classifyTiers, { userOrgId: userOrgForTiers, userId });
            resolvedTier = result.tier;
            log.info(`[DirectChat] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            log.info(`[DirectChat] Auto classification failed: ${err.message}, using fast`);
            resolvedTier = 'fast';
        }
    }

    // Vision override: images require a vision-capable model
    // Auto classifier only looks at text complexity — override to smart/vision tier
    if (attachments?.some(a => a.type?.startsWith('image/'))) {
        const visionTier = tiers['vision'] || tiers['smart'];
        if (visionTier?.modelId && resolvedTier !== 'vision' && resolvedTier !== 'smart') {
            const prevTier = resolvedTier;
            resolvedTier = tiers['vision'] ? 'vision' : 'smart';
            log.info(`[DirectChat] Image attached — overriding tier: ${prevTier} → ${resolvedTier} (${visionTier.modelId})`);
        }
    }

    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;

    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model || 'mistral-small-latest';
    }

    // Resolve provider for this model
    let config;
    let adapter;
    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        log.error(`[DirectChat] Provider resolution failed for model "${modelId}":`, providerErr.message);
        orgHealth.problem('chat.provider_config_failed', {
            orgId: userOrgForTiers || null, source: 'directChat', req,
            meta: { modelId, tier: resolvedTier, error: providerErr },
        });
        return res.status(400).json({ error: providerErr.message });
    }
    let apiKey = config.apiKey;
    let apiUrl = (config.url || '').replace(/\/+$/, '');

    log.info(`[DirectChat] Provider: ${config.providerName || 'default'} (${adapter.name})`);
    log.info(`[DirectChat] Using model: ${modelId} (tier: ${resolvedTier}${modelTier === 'auto' ? ', auto-selected' : ''})`);

    // ── Conversation ownership ──
    // `conversationId` comes straight from the request body and is handed to the
    // tool dispatcher, where the notebook tools resolve it against BOTH
    // conversation tables by id alone. A caller must therefore not be able to
    // name someone else's conversation. An id that doesn't exist anywhere is
    // fine (a new conversation is created below); one that exists and belongs to
    // another user is refused.
    if (conversationId) {
        try {
            const ownerId = await agentStore.getConversationOwnerId(conversationId);
            if (ownerId && ownerId !== userId) {
                log.warn('[DirectChat] refused foreign conversationId:', { conversationId, caller: userId, owner: ownerId });
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                });
                res.write(`event: error\ndata: ${JSON.stringify({ error: 'Conversation not found' })}\n\n`);
                return res.end();
            }
        } catch (e) {
            // Fail closed: if we can't establish ownership we don't proceed with
            // a client-supplied conversation id.
            log.error('[DirectChat] conversation ownership check failed:', e.message);
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Could not verify the conversation. Please retry.' })}\n\n`);
            return res.end();
        }
    }

    // ── Subscription limit enforcement ──
    const limitOrgId = await resolveOrgId(req);
    const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
    if (limitError) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`event: error\ndata: ${JSON.stringify({ error: limitError })}\n\n`);
        return res.end();
    }
    return { orgIdsForTiers, userOrgForTiers, tiers, disableSearchOnUpload, webSearchGuardPiiCategories, resolvedTier, tier, modelId, config, adapter, apiKey, apiUrl };
}

module.exports = { resolveTurnSetup };
