// @typecheck strict
/**
 * Who is asking: a signed-in person, or a visitor of a public embed.
 *
 * A published agent with the web embed on takes turns from visitors without
 * an account; the chat route gives such a visitor a `guest_…` id
 * (utils/routeHelpers.getEffectiveUserId) and that id is what the turn runs
 * under. Tools that act with the agent OWNER's standing — an automation bound
 * to the agent that runs on the owner's connections, a component whose fixed
 * parameters hold the owner's keys — are for the owner's colleagues, not for
 * whoever finds the page, unless the owner said otherwise for this agent.
 *
 * Only the id decides. A headless run (a schedule, an AI task) runs under the
 * owner's id with no session at all, and must keep the owner's tools.
 */

const { isAnonymousUserId } = require('../../utils/anonymousUser');

/** The one place the owner can open owner-standing tools to visitors. */
const VISITOR_TOOLS_FLAG = 'publicVisitorsMayCallAutomations';

/** @param {{ userId?: string | null }} who */
function isGuestAsker({ userId }) {
    return isAnonymousUserId(userId);
}

/**
 * Whether the person a tool call runs for (the asker, else the caller) is a guest.
 * @param {{ askerUserId?: string | null, userId?: string | null } | null | undefined} ctx
 */
function isGuestCaller(ctx) {
    const askerId = (ctx && (ctx.askerUserId || ctx.userId)) || null;
    return !!askerId && isGuestAsker({ userId: askerId });
}

/**
 * Whether the agent's owner opened owner-standing tools to public visitors.
 * Read off the raw tools section: the flag is a per-agent choice, not a tool.
 * @param {unknown} agentConfig
 */
function visitorsMayUseOwnerTools(agentConfig) {
    const tools = agentConfig && typeof agentConfig === 'object'
        ? /** @type {Record<string, unknown>} */ (agentConfig).tools : null;
    return !!tools && typeof tools === 'object' && !Array.isArray(tools)
        && /** @type {Record<string, unknown>} */ (tools)[VISITOR_TOOLS_FLAG] === true;
}

/**
 * Owner-standing tools are withheld from a visitor unless the owner opted in.
 * @param {{ userId?: string | null, agentConfig?: unknown }} turn
 */
function withholdOwnerToolsFrom({ userId, agentConfig }) {
    return isGuestAsker({ userId }) && !visitorsMayUseOwnerTools(agentConfig);
}

/**
 * A public-embed visitor runs an automation (owner standing) only when the
 * agent's owner opened owner tools to visitors.
 * @param {boolean} guest
 * @param {unknown} agentConfig
 */
function visitorRefused(guest, agentConfig) {
    return guest && !visitorsMayUseOwnerTools(agentConfig);
}

module.exports = { isGuestAsker, isGuestCaller, visitorRefused, visitorsMayUseOwnerTools, withholdOwnerToolsFrom, VISITOR_TOOLS_FLAG };
