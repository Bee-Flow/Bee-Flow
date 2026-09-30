/**
 * Streaming agent chat — project / memory / knowledge context.
 *
 * Resolves the validated project for the turn (assigning a fresh conversation
 * to it), retrieves + scrubs the user's relevant memories, and injects the
 * project's instructions plus KB retrieval into the prompt halves. Moved
 * verbatim out of chatStream.js; the prompt halves travel in and out by
 * value, everything else is the caller's live state.
 */
const { emitPhase, emitPhaseEnd } = require('./phaseEvents');
const { performKnowledgeSearch } = require('./knowledgeSearch');
const log = require('../../telemetry/log');

async function resolveProjectContext({ userId, messageMetadata, conversation, isEphemeral }) {
    // Assign new conversation to project if projectId provided
    let extractMemoriesEnabled = false;
    let validProjectId = null;
    let validProject = null;
    if (messageMetadata.projectId) {
        // resolveRequestedProject resolves the caller's groups itself, so a member
        // whose access comes only from a GROUP share is recognised here. The old
        // call omitted the groupIds argument, which silently denied those members
        // and dropped their project instructions + KB from the prompt.
        const { resolveRequestedProject } = require('../../auth/projectAccess');
        const resolved = await resolveRequestedProject(userId, messageMetadata.projectId);
        if (resolved) {
            validProjectId = resolved.projectId;
            validProject = resolved.project;
            extractMemoriesEnabled = resolved.project.extractMemories === true;
        }
    }

    // Only assign the new conversation to a project we actually validated above.
    // Skipping the validation step left orphan rows pointing at unknown projects
    // when the user had no access (or the project no longer existed).
    if (conversation && validProjectId && !messageMetadata.conversationId && !isEphemeral) {
        try {
            const projectStore = require('../../stores/projectStore');
            await projectStore.assignConversation(conversation.id, validProjectId, userId, 'agent_conversations');
        } catch (e) {
            log.warn('[AgentRuntime] Failed to assign conversation to project:', e.message);
        }
    }

    return { extractMemoriesEnabled, validProjectId, validProject };
}

async function resolveMemoryContext({ agent, agentId, userId, userMessage, validProjectId, onEvent }) {
    // ============ MEMORY INTEGRATION ============
    // Skip memory for embed-enabled agents — private user memories must not leak into public embed chats
    let memoryContext = '';
    if (agent.embed_enabled) {
        log.info(`[AgentRuntime] Skipping memory for embed-enabled agent ${agentId}`);
    } else {
        emitPhase(onEvent, 'memory_lookup');
        const _memT = Date.now();
        try {
            const memoryStore = require('../../stores/memoryStore');
            log.info(`[AgentRuntime] Memory lookup - userId: ${userId}, agentId: ${agentId}`);
            // Limit to ~300 tokens (approx 1200 chars) to prevent context pollution
            // Always pass projectId for retrieval (project memories should be available regardless of extractMemories flag)
            // Per-agent memory: when memoryEnabled is on AND useGeneralMemory is
            // false, restrict retrieval to this agent's own bucket.
            const cfg = agent.config || {};
            const includeGeneral = !(cfg.memoryEnabled === true && cfg.useGeneralMemory === false);
            const relevantMemories = await memoryStore.findRelevantMemories(userId, agentId, userMessage, 300, validProjectId || null, { includeGeneral });
            if (relevantMemories.length > 0) {
                memoryContext = memoryStore.formatMemoriesForPrompt(relevantMemories);
                log.info(`[AgentRuntime] Injected ${relevantMemories.length} memories into prompt`);

                // Defence in depth against the "memory leak" class of bug: stored
                // memories can carry real PII from earlier turns that would bypass
                // this turn's tokeniser. Replace detected values with generic
                // labels before they reach the LLM. Non-reversible by design.
                try {
                    const configStore = require('../../stores/configStore');
                    const { getAIConfig } = require('../aiAgent');
                    const orgShieldForScrub = agent.organization_id
                        ? await configStore.getConfig(`org_privacy_shield_${agent.organization_id}`)
                        : null;
                    const aiCfg = await getAIConfig();
                    // Shield's master flag gates scrubbing; detectPii() calls
                    // the PII Guard service when installed.
                    const scrubEnabled = !!orgShieldForScrub?.enabled || !!aiCfg?.piiDetectionEnabled;
                    if (scrubEnabled) {
                        const { scrubMemoryContext } = require('../memory/scrubMemoryContext');
                        const { scrubbed, replacedCategories } = await scrubMemoryContext(memoryContext, orgShieldForScrub);
                        if (replacedCategories.length > 0) {
                            log.info(`[AgentRuntime] 🧹 Scrubbed memory context: ${replacedCategories.join(', ')}`);
                            memoryContext = scrubbed;
                        }
                    }
                } catch (scrubErr) {
                    log.warn('[AgentRuntime] Memory scrub failed (fail-open):', scrubErr.message);
                }
                log.info(`[AgentRuntime] Memory context:\n${memoryContext}`);
            } else {
                log.info('[AgentRuntime] No memories found for this user/agent');
            }
        } catch (memErr) {
            log.error('[AgentRuntime] Memory retrieval failed:', memErr.message);
        }
        emitPhaseEnd(onEvent, 'memory_lookup', Date.now() - _memT);
    }

    return memoryContext;
}

/**
 * Strip what the Privacy Shield's "own server" block list forbids out of
 * knowledge-base passages that reach the prompt without a tool call
 * (BFSF-354). The same passages fetched through kb_search are stripped in the
 * tool loop, so without this an agent WITH that tool honoured the setting and
 * one without it did not. Fails open, like the tool-result strip.
 *
 * `labelOf` names the "### Source N:" line each passage is shown under; the
 * returned labels are those after the same scan (one per chunk, unchanged
 * when nothing applies).
 */
function stripInjectedPassages(chunks, shield, labelOf) {
    return require('../privacy/toolPiiGate').stripInjectedPassages(chunks, { shield, tag: 'AgentRuntime', labelOf });
}

async function injectProjectAndKnowledgeContext({ agent, userId, userMessage, userAuth, validProject, systemPrompt, volatileSystemPrompt, _kbSources, onEvent, moderationViolation, guardrailViolation, tools, isStrictKnowledge, testAs = null, shield = null }) {
    // ============ PROJECT CONTEXT ============
    // Mirrors directChat.js project handling: inject the project's custom
    // instructions and auto-search its knowledge bases. Skipped for embed-enabled
    // agents — same privacy guard used for memory injection.
    if (validProject && !agent.embed_enabled) {
        if (validProject.customInstructions && validProject.customInstructions.trim()) {
            systemPrompt += `\n\n[PROJECT INSTRUCTIONS — "${validProject.name}"]\n${validProject.customInstructions}`;
        }
        /**
         * A project's bases are filtered against the person chatting, not the
         * project's owner. A project can be shared more widely than the bases
         * somebody attached to it, and `quickKBSearch` is documented as
         * taking an already-authorised list.
         *
         * `visibleKbIdsFor` is that same K5 filter plus the "Test as · group X"
         * narrowing (A1c). This door needs it too: a preview that hides a
         * group-restricted base from the agent's own knowledge and then quotes
         * it back out of the project's is not a preview of anything.
         *
         * The one exception is the project's own files base: it is never
         * published, so the filter above would hide it from every member but
         * the owner. `searchableProjectKbIds` keeps it for members (this
         * project was validated for the asker in resolveProjectContext) and
         * drops it in a "Test as" preview, where the asker is nobody's colleague.
         */
        const { visibleKbIdsFor } = require('./testAs');
        const { searchableProjectKbIds } = require('../kb/projectFilesKb');
        const kbIds = await searchableProjectKbIds(validProject, {
            filterAttached: (ids) => visibleKbIdsFor(ids, {
                userId, testAs, context: 'project_kb', agentId: agent?.id || null,
            }),
            includeFiles: !testAs,
        });
        if (kbIds.length > 0) {
            try {
                const { quickKBSearch } = require('./knowledgeSearch');
                const kbResults = await quickKBSearch(userId, kbIds, userMessage, { topK: 6, session: userAuth?.session });
                if (kbResults.length > 0) {
                    // Stripped as stripInjectedPassages does, before the prompt
                    // text AND the citation snippets below.
                    const kbText = await require('../privacy/toolPiiGate').injectedPassagesPrompt(kbResults, { shield, tag: 'AgentRuntime' });
                    // Retrieved against THIS turn's message — volatile half.
                    volatileSystemPrompt += `\n\n[PROJECT KNOWLEDGE BASE — "${validProject.name}"]\nRelevant information from this project's knowledge base:\n${kbText}`;
                    _kbSources.push(...kbResults.map(c => ({
                        document_id: c.document_id, kb_id: c.kb_id,
                        title: c.title, source_uri: c.source_uri,
                        score: c.score, snippet: (c.content || '').slice(0, 240),
                    })));
                    log.info(`[AgentRuntime] Injected ${kbResults.length} KB chunks from project "${validProject.name}"`);
                }
            } catch (kbErr) {
                log.warn('[AgentRuntime] Project KB search failed:', kbErr.message);
            }
        }
    }

    // ============ VECTOR KNOWLEDGE BASE ============
    // When the kb_search TOOL is available, skip auto-injection — let the LLM
    // decide when and what to search.  This avoids double-searching (once here,
    // once via the tool) and gives the LLM control over query formulation.
    const hasKbSearchTool = tools.some(t => t.function?.name === 'kb_search');

    if (!moderationViolation && !guardrailViolation && !hasKbSearchTool) {
        emitPhase(onEvent, 'kb_search');
        const _kbT = Date.now();
        try {
            const kbExtension = await performKnowledgeSearch({ agent, userId, userMessage, isStrictKnowledge, testAs, session: userAuth?.session, stripPassages: (chunks, labelOf) => stripInjectedPassages(chunks, shield, labelOf), onEvent: (type, data) => {
                // Intercept kb_sources to accumulate for persistence
                if (type === 'kb_sources' && data?.sources) {
                    _kbSources.push(...data.sources);
                }
                onEvent(type, data);
            } });
            if (kbExtension) {
                // Per-query retrieval — volatile half.
                volatileSystemPrompt += kbExtension;
            }
        } catch (kErr) {
            log.error('[AgentRuntime] Knowledge retrieval failed:', kErr.message);
        }
        emitPhaseEnd(onEvent, 'kb_search', Date.now() - _kbT);
    } else if (hasKbSearchTool) {
        log.info('[AgentRuntime] KB auto-inject skipped — kb_search tool available, LLM will decide');
    }

    return { systemPrompt, volatileSystemPrompt };
}

module.exports = { resolveProjectContext, resolveMemoryContext, injectProjectAndKnowledgeContext };
