/**
 * "Only through agents" (skills.agent_only, 2026-11).
 *
 * A skill's owner can say a skill is used through agents only: an agent that
 * attaches it (`agent.config.attachedSkillIds`), a Cowork run or an
 * automation AI step bound to such an agent. It is then NOT usable on its own
 * in a direct chat: arriving as a session skill (the composer's skill picker,
 * `activeSkillIds`) without an agent that brings it, it is ignored.
 *
 * The rule is decided here, on the server, in the readers the prompt and the
 * tool stack go through (core/tools/skillInjection.js). Hiding the skill in
 * the chat picker is presentation only; a hand-made request with its id in
 * `activeSkillIds` lands here and is refused the same way.
 *
 * `agentSkillIds` are the ids an AGENT brings in for this turn. In an agent
 * chat that is the agent's attached list; an AI step bound to an agent passes
 * its step skills and the agent's skills (core/automationRunner/aiStepAgent.js
 * skillIdsForStep). An id outside that set is a session id and may not be an
 * agent-only skill.
 */

export interface AgentOnlyAware {
    id: string;
    agentOnly?: boolean | null;
}

/** Keep every skill except an agent-only one that no agent brought in. */
export function keepUsableSkills<T extends AgentOnlyAware>(skills: readonly T[], agentSkillIds: Iterable<string> | null | undefined): T[] {
    const viaAgent = new Set(agentSkillIds ?? []);
    return skills.filter((s) => s.agentOnly !== true || viaAgent.has(s.id));
}

/**
 * The `activate_skill` tool has no attached list at hand, only whether an
 * agent runs the turn. Without one (direct chat), an agent-only skill is not
 * loaded by id either.
 */
export function keepActivatableSkills<T extends AgentOnlyAware>(skills: readonly T[], runsAsAgent: boolean): T[] {
    return runsAsAgent ? [...skills] : skills.filter((s) => s.agentOnly !== true);
}
