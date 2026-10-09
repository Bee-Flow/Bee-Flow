/**
 * Direct Chat — chat-local session-skill state for the Flow (standard) tier:
 * conversation-meta load (compaction summary, OpenAI response chaining id,
 * persisted session skills), the forced skill bootstrap on a fresh Flow
 * conversation, and the per-turn session-skill system-prompt/tool injection.
 * Moved verbatim out of streamTurn.js.
 */

const agentStore = require('../../../stores/agentStore');
const { getProviderForModel } = require('../../../core/aiAgent');
const { getAdapter } = require('../../../core/providers');
const {
    bootstrapSessionSkills,
    buildSessionSkillInjection,
    initialActivatedSkillIds,
} = require('../../../core/tools/sessionSkillRuntime');
const { encryptionOpts } = require('./shared');
const log = require('../../../telemetry/log');

async function setupSessionSkills({ req, send, userId, convId, config, clientHistoryProvided, modelId, disableSearchOnUpload, directChatTools, resolvedTier, requestSessionSkills, requestActivatedSessionSkillIds, message, timezone, tier, adapter, apiKey, apiUrl, messages, volatileMessage = null }) {
        let lastResponseId = null; // OpenAI Responses API chaining
        let conversationSummary = null; // Compaction summary
        let conversationSummaryUpTo = 0; // Watermark: non-system messages already folded into the summary
        let _loadedSummary = null; // Summary as loaded from meta — persist-time change detection
        const isStandardTier = resolvedTier === 'standard';
        let sessionSkills = [];
        let activatedSessionSkillIds = [];
        // Step-machine state: completion is explicit (not derived from
        // activation). LLM calls `complete_session_skill` to advance. Without
        // this distinction, "active" and "done" collapse and the pipeline
        // can't tell whether a step is still being worked on or finished.
        let completedSessionSkillIds = [];
        let sessionSkillsCompletions = [];   // [{ skillId, skillName, summary, order, total, at }]
        let bootstrappedSessionSkills = false;

        // Load metadata from existing conversation
        if (convId) {
            try {
                const existingConv = await agentStore.getDirectConversation(convId, userId, encryptionOpts(req));
                if (existingConv) {
                    // Load compaction summary + watermark (summaryUpTo rides
                    // along via the meta spread in getDirectConversation).
                    if (existingConv.conversationSummary) {
                        conversationSummary = existingConv.conversationSummary;
                        _loadedSummary = conversationSummary;
                        if (Number.isInteger(existingConv.summaryUpTo) && existingConv.summaryUpTo > 0) {
                            conversationSummaryUpTo = existingConv.summaryUpTo;
                        }
                    }
                    // Load OpenAI response chaining ID (model-specific).
                    // Never chain when the client supplied history (edit/
                    // retry): the provider-side chain state is the PRE-edit
                    // conversation and would silently ignore the truncation.
                    if (config.providerType === 'openai' && existingConv.lastResponseId) {
                        if (clientHistoryProvided) {
                            log.info('[DirectChat] Client history supplied — invalidating lastResponseId');
                        } else if (existingConv.lastResponseModel === modelId) {
                            lastResponseId = existingConv.lastResponseId;
                            log.info('[DirectChat] Loaded lastResponseId:', lastResponseId);
                        } else {
                            log.info('[DirectChat] Model changed, invalidating lastResponseId');
                        }
                    }
                    // Check DB messages for past file uploads (disableSearchOnUpload policy)
                    if (disableSearchOnUpload && existingConv.messages?.some(m => m.attachments && m.attachments.length > 0)) {
                        directChatTools = directChatTools.filter(t => t.function.name !== 'agent_search' && t.function.name !== 'read_url');
                        log.info('[DirectChat] Web search disabled — files found in conversation history DB (org policy)');
                    }
                    if (Array.isArray(existingConv.sessionSkills)) {
                        sessionSkills = existingConv.sessionSkills;
                    }
                    if (Array.isArray(existingConv.activatedSessionSkillIds)) {
                        activatedSessionSkillIds = existingConv.activatedSessionSkillIds;
                    }
                    if (Array.isArray(existingConv.completedSessionSkillIds)) {
                        completedSessionSkillIds = existingConv.completedSessionSkillIds;
                    }
                    if (Array.isArray(existingConv.sessionSkillsCompletions)) {
                        sessionSkillsCompletions = existingConv.sessionSkillsCompletions;
                    }
                }
            } catch (e) { /* ignore */ }
        }
        // Client-side fallback: if a direct conversation id is not yet synced
        // (race between new message and SSE conversation_created), reuse
        // chat-local session skills from request payload to avoid regenerating.
        if (isStandardTier && sessionSkills.length === 0 && Array.isArray(requestSessionSkills) && requestSessionSkills.length > 0) {
            sessionSkills = requestSessionSkills;
            activatedSessionSkillIds = Array.isArray(requestActivatedSessionSkillIds) ? requestActivatedSessionSkillIds : [];
            log.info(`[DirectChat] Reused ${sessionSkills.length} session skills from request payload`);
        }

        // Forced bootstrap for the direct-chat-only standard tier:
        // each conversation starts by generating its own chat-local skill set.
        if (isStandardTier && sessionSkills.length === 0) {
            // Tell the UI we're spending some time before the first reply
            // token arrives so it can show a "Preparing chat-local skills…"
            // status instead of looking frozen.
            send('session_skills_bootstrap_started', {});

            // Use a cheaper/faster model for the bootstrap pass when the admin
            // configured tier.bootstrapModelId. Falls back to the main tier
            // model if unset or if the cheap model fails provider resolution.
            let bootstrapModelId = modelId;
            let bootstrapAdapter = adapter;
            let bootstrapApiKey = apiKey;
            let bootstrapApiUrl = apiUrl;
            if (tier.bootstrapModelId && tier.bootstrapModelId !== modelId) {
                try {
                    const bConfig = await getProviderForModel(tier.bootstrapModelId);
                    bootstrapAdapter = getAdapter(bConfig.providerType, (bConfig.url || '').replace(/\/+$/, ''));
                    bootstrapApiKey = bConfig.apiKey;
                    bootstrapApiUrl = (bConfig.url || '').replace(/\/+$/, '');
                    bootstrapModelId = tier.bootstrapModelId;
                    log.info(`[DirectChat] Bootstrap using cheap model: ${bootstrapModelId} (main tier: ${modelId})`);
                } catch (bErr) {
                    log.warn(`[DirectChat] Bootstrap model "${tier.bootstrapModelId}" unavailable, falling back to "${modelId}":`, bErr.message);
                }
            }

            // Pull lightweight user/org context so the bootstrap can tailor
            // language and tone. Best-effort — failures are non-fatal.
            let userContext = null;
            try {
                const userStore = require('../../../stores/userStore');
                const u = await userStore.getUser(userId);
                if (u) {
                    userContext = {
                        language: u.language || u.locale || (req.session?.user?.language) || null,
                        role: u.orgRole || u.role || null,
                    };
                    if (u.organizationId) {
                        const org = await userStore.getOrganization(u.organizationId);
                        if (org) {
                            userContext.orgName = org.name || null;
                            userContext.orgTagline = org.tagline || null;
                        }
                    }
                }
            } catch (ctxErr) {
                log.warn('[DirectChat] Bootstrap userContext lookup failed:', ctxErr.message);
            }

            try {
                sessionSkills = await bootstrapSessionSkills({
                    adapter: bootstrapAdapter,
                    apiKey: bootstrapApiKey,
                    apiUrl: bootstrapApiUrl,
                    modelId: bootstrapModelId,
                    message: message || '[No text message provided]',
                    timezone: timezone || 'UTC',
                    userContext,
                });
                // Auto-activate step-1 skills so their full bodies land in the
                // first-turn system prompt. Without this the AI tends to answer
                // from the short manifest and the pipeline has no effect.
                activatedSessionSkillIds = initialActivatedSkillIds(sessionSkills);
                bootstrappedSessionSkills = true;
                send('session_skills_bootstrapped', {
                    count: sessionSkills.length,
                    skills: sessionSkills,
                    activatedSkillIds: activatedSessionSkillIds,
                });
                log.info(`[DirectChat] Session skills bootstrapped: ${sessionSkills.length} (step-1 auto-activated: ${activatedSessionSkillIds.length})`);
            } catch (bootstrapErr) {
                log.warn('[DirectChat] Session skill bootstrap failed:', bootstrapErr.message);
                // Hard fallback so Standard tier always has at least one
                // chat-local skill even if provider bootstrap fails.
                sessionSkills = [{
                    id: `sess_fallback_${Date.now()}`,
                    name: 'General Assistant Workflow',
                    description: 'Use a concise, execution-first workflow for this chat.',
                    instructions: 'Answer directly, structure output clearly, and execute requested tasks without filler.',
                    workflow: 'Understand intent -> perform actions/tools -> verify -> return concise result.',
                    rules: 'Prefer actionable outputs, include assumptions when uncertain, keep language aligned with user.',
                    examples: 'For research requests, gather current facts first, then synthesize in requested format.',
                    order: 1,
                    dependsOn: [],
                    dynamicActivation: true,
                }];
                activatedSessionSkillIds = initialActivatedSkillIds(sessionSkills);
                bootstrappedSessionSkills = true;
                send('session_skills_bootstrapped', {
                    count: sessionSkills.length,
                    skills: sessionSkills,
                    activatedSkillIds: activatedSessionSkillIds,
                });
            }
        }

        // Inject chat-local session skills (standard tier) with dynamic activation tools.
        if (isStandardTier && sessionSkills.length > 0) {
            const sessionSkillInjection = buildSessionSkillInjection({
                sessionSkills,
                activatedSkillIds: activatedSessionSkillIds,
                // Explicit completion set — completed steps have their full
                // body replaced with a one-line summary trailer (tokens +
                // prevents prior-step prose bleeding into the current step).
                completedSessionSkillIds,
                completions: sessionSkillsCompletions,
                // Once the conversation has been compacted, active-skill bodies
                // are already baked into the summary — re-injecting them every
                // turn wastes tokens. Compact mode emits a one-liner instead;
                // the model can reload any via activate_session_skill.
                compactMode: !!conversationSummary,
            });
            if (sessionSkillInjection.systemPromptAddendum) {
                // The addendum renders the activated/completed sets and the
                // "Current step" header, so it changes on every step of the
                // pipeline. It belongs on the per-turn block: on the cached
                // block every activation re-read the whole prompt on a
                // self-hosted model and re-wrote Claude's 1h cache. Fallback
                // is the LAST system message (the volatile block at index 1).
                const target = volatileMessage || [...messages].reverse().find(m => m && m.role === 'system');
                if (target && typeof target.content === 'string') target.content += sessionSkillInjection.systemPromptAddendum;
            }
            for (const t of sessionSkillInjection.tools) {
                if (!directChatTools.find(dt => dt.function?.name === t.function?.name)) {
                    directChatTools.push(t);
                }
            }
        }
        // The skill-bootstrap pass is intentionally isolated from the response pass.
        // Do not chain provider response IDs from before/through bootstrap.
        if (bootstrappedSessionSkills) {
            lastResponseId = null;
        }
        return { lastResponseId, conversationSummary, conversationSummaryUpTo, _loadedSummary, isStandardTier, sessionSkills, activatedSessionSkillIds, completedSessionSkillIds, sessionSkillsCompletions, bootstrappedSessionSkills, directChatTools };
}

module.exports = { setupSessionSkills };
