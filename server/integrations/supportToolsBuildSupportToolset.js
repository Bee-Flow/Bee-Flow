// @typecheck strict

const SUPPORT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'support_get_requester_profile',
            description: 'Look up the customer behind the current support thread: name, email, whether they are logged-in, their role in their organization, and account age. Use to personalise the reply or verify who you are talking to.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_get_organization_info',
            description: 'Organization metadata for the current thread\'s customer: org name and creation date. Returns null when the thread is anonymous (no linked org).',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_get_subscription_status',
            description: 'Subscription/plan status for the customer\'s organization: plan name, tier, status (active/trialing/past_due/cancelled), and renewal date. Read-only. Returns null for anonymous threads.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_list_recent_threads_for_requester',
            description: 'List up to 10 recent support threads from the same customer (subject, status, resolved date) so you can spot repeat or related issues.',
            parameters: {
                type: 'object',
                properties: { limit: { type: 'integer', description: 'Max threads to return (1-10).' } },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_search_knowledge_base',
            description: 'Search the Bee Flow support knowledge base. Use whenever the question is about features, configuration, billing policy, or known limitations. Returns matching article snippets with titles.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query.' },
                    topK: { type: 'integer', description: 'Number of results (default 4).' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_list_canned_responses',
            description: 'List the canned-response templates available for this thread (already variable-substituted). You may adapt their wording stylistically but must never paste a template verbatim.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

// ── Action tools — let the agent MUTATE the ticket it is handling ─────────────
// Same security model as the read tools: the thread is fixed by the responder
// via context.supportThreadId; the model can never target another ticket. Every
// action is audited and reversible, gated by the inbox reply-mode (see below),
// and never sends customer email (replies always go through the normal path).
const SUPPORT_ACTION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'support_set_priority',
            description: 'Set the priority of the current ticket when the customer message clearly signals urgency (e.g. outage, payment failure) or the opposite. Use sparingly.',
            parameters: { type: 'object', properties: { priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] } }, required: ['priority'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_add_tag',
            description: 'Add an existing organisation tag to the current ticket to aid triage/reporting. Only tags from the team taxonomy are accepted.',
            parameters: { type: 'object', properties: { tag: { type: 'string', description: 'Tag name from the team taxonomy.' } }, required: ['tag'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_set_category',
            description: 'Set a short free-text category for the current ticket (e.g. "billing", "bug", "how-to").',
            parameters: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_set_status',
            description: 'Change the workflow status of the current ticket. "awaiting_user" = you replied and are waiting on the customer; "awaiting_agent" = needs a human; "resolved" = the issue is fully handled.',
            parameters: { type: 'object', properties: { status: { type: 'string', enum: ['awaiting_user', 'awaiting_agent', 'resolved'] } }, required: ['status'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_request_more_info',
            description: 'Mark the current ticket as waiting on the customer because you need more information from them to proceed. Use after your reply asks a clarifying question.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_assign_to_teammate',
            description: 'Assign the current ticket to a specific human teammate by their user id (use only ids surfaced to you).',
            parameters: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_escalate_to_human',
            description: 'Hand the current ticket off to a human agent with a short reason. Use when you cannot safely resolve it yourself.',
            parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
        },
    },
];

// Action levels by reply mode (Tom: actions allowed "fully, but depending on the
// config for full mode"). Each level lists the action tool names it exposes; the
// 'resolved' status value is additionally gated to the 'full' level inside the
// executor. Read tools are always available when 'builtin:read' is enabled.
/** @type {Record<string, string[]>} */
const ACTION_LEVELS = {
    none: [],
    low: ['support_set_priority', 'support_add_tag', 'support_set_category'],
    mid: ['support_set_priority', 'support_add_tag', 'support_set_category',
        'support_set_status', 'support_request_more_info', 'support_assign_to_teammate', 'support_escalate_to_human'],
    full: ['support_set_priority', 'support_add_tag', 'support_set_category',
        'support_set_status', 'support_request_more_info', 'support_assign_to_teammate', 'support_escalate_to_human'],
};

/**
 * @param {string | undefined} replyMode
 */
function actionLevelForMode(replyMode) {
    if (replyMode === 'autonomous') return 'full';
    if (replyMode === 'auto_confident') return 'mid';
    if (replyMode === 'draft') return 'low';
    return 'none'; // legacy / unknown
}

const _READ_NAMES = new Set(SUPPORT_TOOLS.map(t => t.function.name));

const _ACTION_NAMES = new Set(SUPPORT_ACTION_TOOLS.map(t => t.function.name));

/**
 * @param {string} toolName
 */
function isSupportTool(toolName) {
    return _READ_NAMES.has(toolName) || _ACTION_NAMES.has(toolName);
}

/**
 * @param {string} toolName
 */
function isSupportActionTool(toolName) {
    return _ACTION_NAMES.has(toolName);
}

/**
 * Build the tool definitions exposed to the support agent for a run.
 * @param {{enabledToolIds?: string[], toolsEnabled?: boolean, replyMode?: string}} cfg
 * Returns { tools, actionLevel } — `tools` is the OpenAI tool array to inject as
 * extraTools; the model only ever sees tools it is permitted to call.
 */
function buildSupportToolset({ enabledToolIds, toolsEnabled, replyMode } = {}) {
    let ids = Array.isArray(enabledToolIds) ? enabledToolIds.slice() : [];
    if (!ids.length && toolsEnabled) ids = ['builtin:read']; // legacy tools_enabled → read-only
    const tools = [];
    if (ids.includes('builtin:read')) tools.push(...SUPPORT_TOOLS);
    let actionLevel = 'none';
    if (ids.includes('builtin:action')) {
        actionLevel = actionLevelForMode(replyMode);
        const allowedNames = new Set(ACTION_LEVELS[actionLevel] || []);
        tools.push(...SUPPORT_ACTION_TOOLS.filter(t => allowedNames.has(t.function.name)));
    }
    return { tools, actionLevel };
}

module.exports = { SUPPORT_TOOLS, SUPPORT_ACTION_TOOLS, ACTION_LEVELS, actionLevelForMode, isSupportTool, isSupportActionTool, buildSupportToolset };
