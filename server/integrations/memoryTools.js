/**
 * Memory Tools — the user's own long-term memory (stores/memoryStore.js) as two
 * tools a chat agent or an automation step can call.
 *
 *   memory_search   — the memories most relevant to a query, optionally by type.
 *   memory_remember — store one durable fact / preference / instruction.
 *
 * Why a tool and not a step type: the automation runner already dispatches
 * every tool call through core/tools/toolDispatcher.js, so an automation that
 * learned something ("Tom signs client mail with 'Groet, Tom'") can hand it to
 * the same memory the chat assistant reads — and read back what the owner told
 * chat — without a new executor.
 *
 * Scope: ALWAYS the calling user's own memory (context.userId). There is no
 * parameter to read or write anyone else's. Writes go through the one write
 * pipeline (agents/memory/memoryWriter.js): hard drops, Art. 9 review, confirm /
 * supersede on (type, subject, attribute), never a duplicate.
 */

// Lazily required inside the executor: this module is pulled in at load time by
// core/integrations/integrationTools.js, and a top-level require of the store
// closes a cycle through ../db that leaves makeStoreInit undefined in
// datatableStore (the server then crash-loops on boot).
const getMemoryStore = () => require('../stores/memoryStore');

const getMemoryWriter = () => require('../agents/memory/memoryWriter');

const getMemoryPolicy = () => require('../core/memory/memoryPolicy');

const MEMORY_OFF_MESSAGE = 'Memory is turned off';

const MEMORY_TYPES = ['person', 'preference', 'fact', 'project', 'workflow', 'instruction'];

const MEMORY_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'memory_search',
            description: 'Search the user\'s personal long-term memory: preferences, standing instructions, people they work with, projects, workflows and facts they shared earlier. Returns the memories most relevant to the query. Use before writing in the user\'s name or deciding on their behalf.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What you want to know, in a short sentence (e.g. "how does the user sign off client email").' },
                    types: { type: 'array', items: { type: 'string', enum: MEMORY_TYPES }, description: 'Optional: only these memory types.' },
                    limit: { type: 'integer', description: 'Max memories to return (1-20, default 8).' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_remember',
            description: 'Store one durable fact about the user in their personal memory so it is available in every later conversation and automation. Only for things worth keeping (a preference, a standing instruction, who someone is) — never transient details, never data about third parties beyond their role.',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: MEMORY_TYPES, description: 'Kind of memory.' },
                    content: { type: 'string', description: 'One self-contained sentence, max 200 characters.' },
                    subject: { type: 'string', description: 'What/who it is about (a person name, a project, "email style"). Enables deduplication together with attribute.' },
                    attribute: { type: 'string', description: 'Which aspect (e.g. "signoff", "role", "tone").' },
                    value: { type: 'string', description: 'The value for that attribute, when there is one.' },
                    importance: { type: 'number', description: '0-1, default 0.6.' },
                    evidence: { type: 'string', description: 'Optional: where this came from (a short note, no long quotes).' },
                },
                required: ['type', 'content'],
            },
        },
    },
];

function isMemoryTool(toolName) {
    return toolName === 'memory_search' || toolName === 'memory_remember';
}

function clampInt(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/** What the model is told about one write; it relays this to the user. */
function rememberResult(r, { type, content }) {
    const base = { type, content, action: r.action };
    switch (r.action) {
        case 'created':
            return { ...base, id: r.id, stored: true, message: 'Remembered.' };
        case 'confirmed':
            return { ...base, id: r.id, stored: true, message: 'Already known: confirmed the existing memory.' };
        case 'superseded':
            return { ...base, id: r.id, stored: true, replaced: r.supersededId || null, message: 'Updated: this replaces an older memory about the same thing.' };
        case 'pending_review':
            return {
                ...base, id: r.id, stored: false, needsReview: true,
                message: r.reason === 'contradicts_explicit'
                    ? 'Not applied yet: it conflicts with something the user wrote themselves. It needs the user\'s review in Settings → Memory.'
                    : 'Saved but not active yet: this is sensitive personal information, so it needs the user\'s review in Settings → Memory.',
            };
        default:
            return {
                ...base, stored: false, reason: r.reason || 'rejected',
                message: r.reason === 'sensitive_identifier'
                    ? 'Not stored: identity numbers, bank or card numbers and passwords are never kept in memory.'
                    : r.reason === 'art9_no_consent'
                        ? 'Not stored: this is sensitive personal information (health, beliefs, and similar) and the user has not allowed memory to keep that.'
                        : `Not stored (${r.reason || 'rejected'}).`,
            };
    }
}

function publicShape(m) {
    return {
        id: m.id,
        type: m.type,
        content: m.content,
        subject: m.subject || null,
        attribute: m.attribute || null,
        value: m.value || null,
        importance: m.importance ?? null,
        lastConfirmedAt: m.last_confirmed_at || m.lastConfirmedAt || null,
    };
}

async function executeMemoryTool(toolName, args = {}, context = {}) {
    const userId = context.userId;
    if (!userId) return { error: 'memory tools need a signed-in user' };

    // The same gate the prompt injection and the extractor use. A tool result
    // (not an error) so the model tells the user instead of retrying. The
    // per-chat flags only reach the tool when the caller puts them on context.
    const policy = await getMemoryPolicy().resolveMemoryPolicy({
        userId, orgId: context.orgId || null,
        perChatReadEnabled: context.memoryReadEnabled,
        perChatWriteEnabled: context.memoryWriteEnabled,
    });

    if (toolName === 'memory_search') {
        if (!policy.read) return { memories: [], count: 0, disabled: true, reason: policy.reason, message: `${MEMORY_OFF_MESSAGE}: nothing was searched.` };
        const query = String(args.query || '').trim();
        if (!query) return { error: 'query is required' };
        const limit = clampInt(args.limit, 1, 20, 8);
        const types = Array.isArray(args.types) ? args.types.filter(t => MEMORY_TYPES.includes(t)) : null;
        // A generous token budget, then trim by type and count here — the store
        // ranks by relevance already.
        const found = await getMemoryStore().findRelevantMemories(userId, context.agentId || null, query, 1500, null, { includeGeneral: true, includeSensitive: policy.sensitive === true, search: true });
        const rows = (Array.isArray(found) ? found : [])
            .filter(m => !types || types.length === 0 || types.includes(m.type))
            .slice(0, limit)
            .map(publicShape);
        return { memories: rows, count: rows.length, ...(rows.length === 0 ? { message: 'No relevant memories.' } : {}) };
    }

    if (toolName === 'memory_remember') {
        if (!policy.write) return { stored: false, disabled: true, reason: policy.reason, message: `${MEMORY_OFF_MESSAGE}: nothing was saved.` };
        const type = MEMORY_TYPES.includes(args.type) ? args.type : null;
        const content = String(args.content || '').trim().slice(0, 200);
        if (!type) return { error: `type must be one of ${MEMORY_TYPES.join(', ')}` };
        if (!content) return { error: 'content is required' };
        const importance = Math.max(0, Math.min(1, Number.isFinite(Number(args.importance)) ? Number(args.importance) : 0.6));
        const subject = args.subject ? String(args.subject).trim().slice(0, 120) : null;
        const attribute = args.attribute ? String(args.attribute).trim().slice(0, 80) : null;
        const value = args.value != null ? String(args.value).trim().slice(0, 200) : null;
        const evidence = args.evidence ? String(args.evidence).trim().slice(0, 200) : null;
        const result = await getMemoryWriter().writeMemory(
            { type, content, subject, attribute, value, importance, evidenceQuote: evidence },
            {
                userId, orgId: context.orgId || null, agentId: context.agentId || null, projectId: null,
                conversationId: context.conversationId || null, origin: 'tool',
            },
        );
        return rememberResult(result, { type, content });
    }

    return { error: `Unknown memory tool: ${toolName}` };
}

module.exports = { MEMORY_TOOLS, MEMORY_TYPES, isMemoryTool, executeMemoryTool };
