// @typecheck strict

const DEFAULT_TIMEOUT_MS = 90_000;

// The lock must outlive the call it guards, or a slow answer loses its turn.
const LOCK_MARGIN_MS = 30_000;

/** How often an explicit ask that found the turn held looks again. */
const DEFAULT_LOCK_POLL_MS = 1000;

const EXPLICIT_TRIGGERS = Object.freeze(['ask', 'mention', 'always']);

/**
 * @param {string} s
 */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ASSISTANT_MENTION = /(^|[^\w@])@(ai|assistant)(?![\w-])/i;

/**
 * Does this text address the assistant?
 * @param {string} content
 * @param {string|null} [agentName]
 */
function mentionsAssistant(content, agentName = null) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a fixed mention pattern and an escapeRegExp()d agent name with no nested repeats: linear
    const text = String(content || '');
    if (ASSISTANT_MENTION.test(text)) return true;
    const name = typeof agentName === 'string' ? agentName.trim() : '';
    if (!name) return false;
    return new RegExp(`(^|[^\\w@])@${escapeRegExp(name)}(?![\\w-])`, 'i').test(text);
}

// In Auto, an unambiguous direct address is an explicit request too. Do this
// before the delayed relevance gate and PII masking can mistake "AI" for a name.
/**
 * @param {string} content
 */
function addressesAssistant(content) {
    const text = String(content || '').trim();
    return /^(?:(?:hoi|hey|hi|hello|hallo|beste)\s+)?(?:ai|assistant|assistent)\s*(?:[,!:]|\b(?:(?:kun|kan|wil|zou)\s+(?:je|jij|u)|(?:can|could|would)\s+you|please|help)\b)/iu.test(text)
        || (/\b(?:je|jij|you)\b/iu.test(text) && /\b(?:ai|assistant|assistent)\s*[?？]$/iu.test(text));
}

/**
 * Does this post get an answer now, and why (`kind` is stored on the answer
 * as its `ai_trigger`)? In `auto` mode a post that does not ask is
 * `auto_pending`: the participation engine takes it from there.
 *
 * @param {{ aiMode: string, content: string, askAi?: boolean, agentName?: string|null }} p
 * @returns {{ trigger: true, kind: 'ask'|'mention'|'always' } | { trigger: false, reason: string }}
 */
function decideAiTrigger({ aiMode, content, askAi = false, agentName = null }) {
    if (aiMode === 'off') return { trigger: false, reason: 'ai_off' };
    if (aiMode === 'always') return { trigger: true, kind: 'always' };
    if (askAi === true) return { trigger: true, kind: 'ask' };
    if (mentionsAssistant(content, agentName)) return { trigger: true, kind: 'mention' };
    if (aiMode === 'auto' && addressesAssistant(content)) return { trigger: true, kind: 'ask' };
    if (aiMode === 'auto') return { trigger: false, reason: 'auto_pending' };
    return { trigger: false, reason: 'not_mentioned' };
}

/**
 * The agent behind a chat, as the ASKING member may use it, or null.
 * Owner: always. Anyone else: only a published agent of their organisation
 * that is shared with them (or with everyone there) and that serves a
 * published version — the rule core/automationRunner/aiStepAgent applies to a
 * automation's owner, reused rather than restated.
 *
 * @param {{ agentId: string, userId: string }} p
 * @param {{ getUser?: Function, resolveUserGroups?: Function, agentStore?: any }} [deps]
 * @returns {Promise<{ agentId: string, name: string, systemPrompt: string }|null>}
 */
async function resolveUsableAgent({ agentId, userId }, deps = {}) {
    if (!agentId || !userId) return null;
    const getUser = deps.getUser || ((/** @type {string} */ id) => require('../stores/userStore').getUser(id));
    const resolveUserGroups = deps.resolveUserGroups || ((/** @type {string} */ id) => require('../auth/audience').resolveUserGroups(id));
    /** @type {{ userId: string, userHomeOrgId: string|null, userGroupIds: string[], identityError: string|null }} */
    const ctx = { userId, userHomeOrgId: null, userGroupIds: [], identityError: null };
    try {
        const user = await getUser(userId);
        ctx.userHomeOrgId = user?.organizationId || null;
        ctx.userGroupIds = (await resolveUserGroups(userId)) || [];
    } catch (err) {
        // An identity we could not read is not a yes (only the owner branch,
        // which needs no identity, can still pass).
        ctx.identityError = /** @type {Error} */ (err)?.message || 'identity lookup failed';
    }
    try {
        const { resolveStepAgent } = require('../core/automationRunner/aiStepAgent');
        const binding = await resolveStepAgent({ agentId }, ctx, deps.agentStore ? { agentStore: deps.agentStore } : {});
        if (!binding) return null;
        return {
            agentId: binding.agentId,
            name: typeof binding.agent?.name === 'string' && binding.agent.name.trim() ? binding.agent.name.trim() : 'Agent',
            systemPrompt: binding.systemPrompt || '',
        };
    } catch (err) {
        if (err?.errorClass === 'agent_unavailable') return null;
        throw err;
    }
}

/**
 * Passages from the project's knowledge bases, as prompt text, or ''.
 *
 * A project chat or comment answer is read by the whole project, asked for
 * or not, so the callers pass the audience (`audienceIds`, from
 * listProjectAudience) and the project's linked bases are narrowed to what
 * EVERY member may read — the intersection, the asker included — before
 * anything is searched; an unknown audience (null) keeps no linked base at
 * all, because a passage one member may read must not reach the others
 * through the answer. Without `audienceIds` (undefined) the bases are
 * narrowed to what the asking member may read, as the agent path does: only
 * right for an answer that member alone will see. The project's own files base is
 * searchable by every member once it is verified to be this project's
 * (core/kb/projectFilesKb.js). The passages are stripped by the shield's
 * own-server list.
 *
 * A project with files but no linked base still has something to search, so
 * an empty `knowledgeBaseIds` is not a reason to stop here.
 *
 * @param {{ project: any, userId: string, query: string, session?: any|null, shield?: any|null,
 *           audienceIds?: string[]|null }} p
 * @param {{ visibleKbIdsFor?: Function, quickKBSearch?: Function, injectedPassagesPrompt?: Function, kbStore?: any }} [deps]
 */
async function searchProjectKnowledge({ project, userId, query, session = null, shield = null, audienceIds = undefined }, deps = {}) {
    if (!project || !query) return '';
    const visibleKbIdsFor = deps.visibleKbIdsFor || require('../core/agentRuntime/testAs').visibleKbIdsFor;
    const quickKBSearch = deps.quickKBSearch || require('../core/agentRuntime/knowledgeSearch').quickKBSearch;
    const injectedPassagesPrompt = deps.injectedPassagesPrompt || require('../core/privacy/toolPiiGate').injectedPassagesPrompt;
    const { searchableProjectKbIds } = require('../core/kb/projectFilesKb');
    /** @param {string[]} ids */
    const forEveryone = async (ids) => {
        if (!Array.isArray(audienceIds) || audienceIds.length === 0) return [];
        let kept = ids;
        for (const memberId of new Set([userId, ...audienceIds])) {
            if (kept.length === 0) break;
            const visible = new Set(await visibleKbIdsFor(kept, { userId: memberId, context: 'project_kb' }));
            kept = kept.filter((id) => visible.has(id));
        }
        return kept;
    };
    const kbIds = await searchableProjectKbIds(project, {
        filterAttached: audienceIds === undefined
            ? (ids) => visibleKbIdsFor(ids, { userId, context: 'project_kb' })
            : forEveryone,
        deps: deps.kbStore ? { kbStore: deps.kbStore } : {},
    });
    if (!kbIds || kbIds.length === 0) return '';
    const chunks = await quickKBSearch(userId, kbIds, query, { topK: 6, session: session || null });
    if (!chunks || chunks.length === 0) return '';
    return injectedPassagesPrompt(chunks, { shield, tag: 'ProjectChat' });
}

module.exports = { DEFAULT_TIMEOUT_MS, LOCK_MARGIN_MS, DEFAULT_LOCK_POLL_MS, EXPLICIT_TRIGGERS, mentionsAssistant, decideAiTrigger, resolveUsableAgent, searchProjectKnowledge };
