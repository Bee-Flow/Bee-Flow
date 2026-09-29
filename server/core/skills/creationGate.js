/**
 * May this caller ADD a skill to the library? And the one thing that never
 * needs Skills: removing one.
 *
 * Skills are Enterprise (server/license/tiers.js). The /api/skills mount holds
 * the capability for the library's own routes, but a skill can also be born
 * outside that mount: the agent wizard proposes and creates skills
 * (routes/agents/wizard.js), a chat can import a session skill
 * (routes/ai/directChat/conversationRoutes.js) and the model can publish one
 * through a tool (core/tools/sessionSkillRuntime.js). Each of those asks here,
 * so the three doors share one question and one refusal. (GitHub sync,
 * services/githubSyncService.js, only pushes skills OUT; a future pull that
 * creates skills from a repository is a fourth door and must ask here too.)
 *
 * What is deliberately NOT asked here: using a skill that already exists.
 * Attached skills keep working at runtime after a lapse or a downgrade
 * (core/tools/skillInjection.js, core/agentRuntime/contextBuilder.js,
 * core/automationRunner/aiStepSkills.js), and deleting one is never gated
 * (exceptRemoval below, on the /api/skills mount). Only new creation is
 * refused.
 *
 * Fails CLOSED: hasCapability itself answers false on an unknown capability or
 * a degraded resolve, and a throw from it is treated the same way.
 */

// Written for the person, not for a parser: the web client toasts `error`
// verbatim and the phone shows it under "Not available on your plan". The
// machine-readable part is `code` / `feature` / `required`.
const SKILLS_LOCKED_MESSAGE = 'Adding skills needs Skills, which is part of the Enterprise plan. '
    + 'Skills you already have keep working. Ask an administrator if you need to add new ones.';

/**
 * @param {{ userId?: string|null, orgId?: string|null, session?: object|null, req?: object|null }} ctx
 * @param {{ hasCapability?: Function }} [deps] test seam; defaults to the real entitlements resolver
 * @returns {Promise<boolean>}
 */
async function canCreateSkills({ userId = null, orgId = null, session = null, req = null } = {}, deps = {}) {
    const has = deps.hasCapability || require('../entitlements/entitlements').hasCapability;
    try {
        return (await has('skills', { userId, orgId, session, req })) === true;
    } catch (_) {
        return false;
    }
}

/** The 403 body every HTTP door answers with. A fresh object per call. */
function skillsLockedBody() {
    return {
        error: SKILLS_LOCKED_MESSAGE,
        code: 'feature_locked',
        feature: 'skills',
        required: 'enterprise',
    };
}

// DELETE /:id and nothing else: a removal further down the tree (a test run, an
// example) is not a skill being removed, and gets no free pass by accident.
const REMOVE_ONE_SKILL = /^\/[^/]+\/?$/;

/**
 * Wrap the /api/skills mount's capability gate so REMOVING a skill passes
 * without it (server/index.js). An organisation whose plan lapsed can still
 * delete the skills it made; everything else under the mount, reading
 * included, still needs Skills. The owner-or-admin rule for a delete lives in
 * the route itself and is untouched.
 *
 * The wrapper carries the inner gate's tag (auth/gateMeta.js) plus the
 * exemption, so a route walk still reads it as the skills capability.
 */
function exceptRemoval(capabilityGate) {
    const { tagGate, readGate } = require('../../auth/gateMeta');
    const gate = function skillsCapabilityExceptRemoval(req, res, next) {
        if (req.method === 'DELETE' && REMOVE_ONE_SKILL.test(req.path || '')) return next();
        return capabilityGate(req, res, next);
    };
    return tagGate(gate, { ...(readGate(capabilityGate) || { axis: 'capability', id: 'skills' }), exempt: 'DELETE /:id' });
}

module.exports = { canCreateSkills, skillsLockedBody, exceptRemoval, SKILLS_LOCKED_MESSAGE };
