/**
 * Memory Extractor - Extracts memorable information from conversations
 * Uses LLM to identify facts, preferences, and instructions worth remembering
 */

const memoryStore = require('../../stores/memoryStore');
const { writeMemory } = require('./memoryWriter');
const { isTaskLike, isQuestion } = require('./contentRules');
const agentStore = require('../../stores/agentStore');
const { resolveMemoryExtractionModel, EXTRACTION_CHAT_OPTIONS, EXTRACTION_MAX_CHARS } = require('../../core/memory/extractionModel');
const { isAnonymousUserId } = require('../../utils/anonymousUser');
const log = require('../../telemetry/log');

// Extraction prompt is managed via the system agent (stored in DB)

// The seven types the rest of the system understands (typeScores,
// formatMemoriesForPrompt, the Manage UI). Anything else the model emits is
// coerced to `fact` rather than dropped: the fact is still true, only the
// label was wrong.
const MEMORY_TYPES = ['fact', 'preference', 'instruction', 'person', 'project', 'workflow', 'context'];

// JSON Schema for structured output (OpenAI-compatible)
//
// `subject` is deliberately FREE TEXT. `(type, subject, attribute)` is the
// canonical key `createMemory` dedupes and SUPERSEDES on; with subject
// restricted to an enum every person's role collapses onto one key and the
// second colleague the assistant learns about silently replaces the first.
// The description carries the canonical-form rule so the model does not fork
// the key on "Tom", "he" and "Tom Smit" either.
const MEMORY_SCHEMA = {
    type: "json_schema",
    json_schema: {
        name: "memory_extraction",
        strict: true,
        schema: {
            type: "object",
            properties: {
                memories: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            type: { type: "string", enum: ["fact", "preference", "instruction", "person", "project", "workflow", "context"] },
                            content: { type: "string", description: "Full readable sentence" },
                            subject: {
                                type: "string",
                                description: "The entity this memory is about, in canonical form: a person's full name, a project or company name, or \"user\" for the person you are talking to. Never a pronoun or a description — the same entity must always get the same subject.",
                            },
                            attribute: { type: "string", description: "The property being defined (snake_case, e.g. role, tech_stack)" },
                            value: { type: "string", description: "Canonical value" },
                            evidence_quote: { type: "string", description: "Exact quote from user message" },
                            sensitivity: { type: "string", enum: ["none", "art9"], description: "\"art9\" for health, religion or belief, political opinion, sexual orientation or sex life, ethnic origin, trade union membership, genetic or biometric data; else \"none\"" },
                            confidence: { type: "number", minimum: 0.8, maximum: 1.0 },
                            importance: { type: "number", minimum: 0, maximum: 1, description: "How important this is to remember" }
                        },
                        required: ["type", "content", "evidence_quote", "confidence"],
                        additionalProperties: false
                    }
                }
            },
            required: ["memories"],
            additionalProperties: false
        }
    }
};

/**
 * Verify that evidence_quote exists in source text
 */
function verifyEvidence(memory, sourceText) {
    if (!memory.evidence_quote || memory.evidence_quote.length < 3) return false;
    // Normalize for matching (handle whitespace differences)
    const normalized = sourceText.toLowerCase().replace(/\s+/g, ' ').trim();
    const quote = memory.evidence_quote.toLowerCase().replace(/\s+/g, ' ').trim();
    return normalized.includes(quote);
}


/**
 * Extract memories from conversation messages
 * @param {string} userId - User ID
 * @param {string} agentId - Agent ID (or null for global)
 * @param {Array} messages - Array of {role, content} messages
 * @param {string} conversationId - Conversation ID for source tracking
 * @param {string} projectId - Optional project ID for scoping memory
 * @param {string} userOrgId - Optional org ID for EU-mode model overrides
 */
async function extractFromConversation(userId, agentId, messages, conversationId = null, projectId = null, userOrgId = null) {
    // Anonymous visitors get nothing extracted. `POST /agents/:id/chat` is
    // unauthenticated by design (embed widget) and `getEffectiveUserId` mints
    // `guest_<random>` rather than 401-ing, so this is the one place that
    // closes the hole: no store round trip, no LLM call — a `guest_*` id has
    // no data subject behind it, and extraction is a paid model call.
    if (isAnonymousUserId(userId)) return [];

    // If this agent has per-agent memory enabled, route writes to its own
    // bucket (agent_id = X). Otherwise keep the legacy behaviour and store
    // memories at the user-global level (agent_id IS NULL).
    let writeAgentId = null;
    try {
        if (agentId) {
            const a = await agentStore.getAgent(agentId);
            if (a?.config?.memoryEnabled === true) writeAgentId = agentId;
        }
    } catch (_) { /* fall back to global */ }

    // Only analyze the LATEST user message (not last 5 - prevents blending)
    const userMessages = (Array.isArray(messages) ? messages : []).filter(m => m && m.role === 'user').slice(-1);

    if (userMessages.length === 0) {
        log.info('[MemoryExtractor] No user messages to analyze');
        return [];
    }

    // Get the single latest message content
    let userText = userMessages[0].content;

    // Handle multimodal messages
    if (Array.isArray(userText)) {
        const textBlock = userText.find(b => b.type === 'text');
        userText = textBlock ? textBlock.text : '';
    }



    if (!userText || userText.length < 10) {
        log.info('[MemoryExtractor] Message too short to analyze');
        return [];
    }

    try {
        // Fetch System Agent for config
        const extractorAgent = await agentStore.getSystemAgent('system-memory-extractor');
        const systemPrompt = extractorAgent?.system_prompt || 'Extract user memories.';

        // The admin's dedicated extraction model when set, else this agent's
        // model through the Fast tier (core/memory/extractionModel.js).
        const extractionModel = await resolveMemoryExtractionModel({ agentModel: extractorAgent?.model, userOrgId, userId });

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Today's date: ${new Date().toISOString().slice(0, 10)}\n\nExtract memories from this user message:\n\n"${userText.slice(0, EXTRACTION_MAX_CHARS.user)}"` }
        ];

        let responseFormat;
        try {
            responseFormat = MEMORY_SCHEMA;
        } catch (e) {
            // Fallback: provider doesn't support response_format
        }

        const llmClient = require('../../core/llm/llmClient');
        // Thinking off + 1k cap (EXTRACTION_CHAT_OPTIONS): a reasoning model
        // would otherwise deliberate over a JSON list on the chat's slot.
        const result = await llmClient.chat(extractionModel, messages, {
            ...EXTRACTION_CHAT_OPTIONS,
            temperature: 0.2,
            responseFormat: responseFormat
        });
        const content = result.content;



        // Parse JSON from response
        const memories = parseMemoryResponse(content);


        if (memories.length === 0) {
            log.info('[MemoryExtractor] No memories extracted');
            return [];
        }

        // Store each extracted memory with evidence verification
        const created = [];
        for (const memory of memories) {
            // VERIFY EVIDENCE: The quote must exist in the source text
            if (!verifyEvidence(memory, userText)) {
                log.info(`[MemoryExtractor] Evidence verification failed (${memory.type || '?'})`);
                continue;
            }

            // ── Isolation guard ──────────────────────────────────────────────────
            // Project memories belong only inside a project context. If there is
            // no projectId, skip them to avoid polluting global memory.
            if ((memory.type === 'project' || memory.subject === 'project') && !projectId) {
                log.info('[MemoryExtractor] Skipping project memory in user-global scope');
                continue;
            }

            // One pipeline for every automatic write: hard drops, Art. 9,
            // confirm / supersede / duplicate checks, cap (agents/memory/memoryWriter.js).
            const outcome = await writeMemory({
                type: memory.type,
                content: memory.content,
                subject: memory.subject,
                attribute: memory.attribute,
                value: memory.value,
                importance: memory.importance,
                confidence: memory.confidence,
                evidenceQuote: memory.evidence_quote,
                sensitivity: memory.sensitivity,
            }, {
                userId, orgId: userOrgId, agentId: writeAgentId, projectId,
                conversationId, origin: 'inferred', userText,
            });
            log.info(`[MemoryExtractor] ${outcome.action}${outcome.reason ? ` (${outcome.reason})` : ''}${outcome.id ? ` ${outcome.id}` : ''}`);
            const id = outcome.id;
            if (!id || outcome.action === 'confirmed' || outcome.action === 'rejected') continue;

            // Link to source conversation
            if (conversationId && id) {
                let sourceMessage = userMessages[userMessages.length - 1]?.content;

                // Handle array content (multimodal messages)
                if (Array.isArray(sourceMessage)) {
                    const textBlock = sourceMessage.find(b => b.type === 'text');
                    sourceMessage = textBlock ? textBlock.text : '[Media Message]';
                }

                if (sourceMessage && typeof sourceMessage === 'string') {
                    try {
                        await memoryStore.addMemorySource(id, conversationId, sourceMessage);
                    } catch (err) {
                        log.error('[MemoryExtractor] Failed to link source:', err.message);
                    }
                }
            }

            created.push({ id, action: outcome.action, ...memory });
        }

        log.info(`[MemoryExtractor] Stored ${created.length} memories`);
        return created;

    } catch (error) {
        log.error('[MemoryExtractor] Extraction failed:', error);
        return [];
    }
}

/**
 * Parse the LLM response to extract memory objects
 * Handles both {memories: [...]} and [...] formats
 */
function parseMemoryResponse(content) {
    try {
        // Clean content
        let cleanContent = content.trim();

        // Try to parse as JSON first (structured output)
        let parsed;
        try {
            parsed = JSON.parse(cleanContent);
        } catch (e) {
            // Fallback: try to find JSON in response
            const objectMatch = cleanContent.match(/\{[\s\S]*"memories"[\s\S]*\}/);
            const arrayMatch = cleanContent.match(/\[[\s\S]*\]/);

            if (objectMatch) {
                parsed = JSON.parse(objectMatch[0]);
            } else if (arrayMatch) {
                parsed = JSON.parse(arrayMatch[0]);
            } else {
                return [];
            }
        }

        // Handle both {memories: [...]} and [...] formats
        let memories = Array.isArray(parsed) ? parsed : (parsed.memories || []);

        if (!Array.isArray(memories)) {
            return [];
        }


        // Validate and filter memories
        return memories.filter(m => {
            // Basic validation
            if (!m.type || !m.content || typeof m.content !== 'string') return false;
            if (m.content.length < 5 || m.content.length > 500) return false;

            // Confidence threshold - only keep high confidence
            if ((m.confidence || 0) < 0.8) return false;

            // Filter out task-like content (secondary filter in case LLM misses)
            if (isTaskLike(m.content)) {
                log.info('[MemoryExtractor] Filtered task-like content');

                return false;
            }

            // Filter out questions
            if (isQuestion(m.content)) return false;

            return true;
        }).map(m => ({
            type: MEMORY_TYPES.includes(m.type) ? m.type : 'fact',
            content: m.content.trim(),
            // Subject keeps its case: it is half of the canonical key, and the
            // rows already in the database read "Tom Smit", not "tom smit".
            // Whitespace is collapsed so formatting alone cannot fork the key.
            subject: typeof m.subject === 'string' && m.subject.trim() ? m.subject.trim().replace(/\s+/g, ' ') : null,
            attribute: typeof m.attribute === 'string' && m.attribute.trim() ? m.attribute.toLowerCase().trim() : null,
            value: typeof m.value === 'string' && m.value.trim() ? m.value.trim() : null,
            evidence_quote: typeof m.evidence_quote === 'string' ? m.evidence_quote.trim() : null,
            sensitivity: m.sensitivity === 'art9' ? 'art9' : 'none',
            confidence: Math.min(1, Math.max(0.8, Number(m.confidence) || 0.8)),
            importance: Math.min(1, Math.max(0.5, Number(m.importance) || 0.7))
        }));

    } catch (error) {
        log.error('[MemoryExtractor] Failed to parse response:', error);
        return [];
    }
}

module.exports = {
    extractFromConversation,
    MEMORY_TYPES,
};
