/**
 * Agent CRUD: the write side of `agents.persona` (structured role, A1c).
 * Normalising an incoming persona, verifying the hand-off automation it points
 * at (and binding it when this save is what chooses it), and deriving the
 * system prompt and the config keys the persona is the source of. Split out of
 * crud.js, which runs it BEFORE the config validation; behaviour unchanged.
 */

const log = require('../../telemetry/log');

// ── Structured role (A1c) ───────────────────────────────────────────
//
// The whole write side of `agents.persona` lives here, next to the config
// validation it has to run BEFORE: a persona can add an automation grant to
// `config.tools`, and a grant that skips `normaliseToolsConfig` is a grant
// nothing clamped.

/**
 * Is this an automation the AGENT'S OWNER may hand off to? Returns the verified
 * `{id, label}` or null — and null is the only answer for anything we could
 * not confirm, including a lookup that threw.
 *
 * The check is against `agent.owner_id`, never the person doing the editing.
 * An org-admin may edit someone else's agent; letting them attach one of THEIR
 * OWN automations to it would mint a grant the agent's owner never made, on an
 * agent that runs under a different identity. Same rule the KB and skill blocks
 * above already apply ("accessible to the AGENT'S OWNER, not the requesting
 * user"), and the same reason.
 *
 * `automationToTool` does the rest of the narrowing: it returns null unless the
 * automation really declares `trigger.kind === 'agent_call'`, and it produces the
 * EXACT tool name the runtime will offer — so the prompt line names the action
 * the model actually has instead of one it has to invent.
 *
 * It must also be BOUND to this agent (automation_agent_bindings): the runtime
 * offers an automation only to the agents it is bound to, so a hand-off to an
 * unbound one would put "hand off via <tool>" in the prompt for a tool that never
 * exists. See `ensureHandoffBinding` for when a missing binding is made here.
 * @param {string} automationId
 * @param {{ actorId: string | null; session: object | null; newSelection: boolean; }} [opts]
 */
async function verifyHandoffAutomation(agent, automationId, opts = {}) {
    if (!automationId || !agent || !agent.owner_id) return null;
    try {
        const automationStore = require('../../stores/automationStore');
        const automation = await automationStore.getAutomation(automationId);
        if (!automation) return null;
        if (automation.userId !== agent.owner_id) return null;
        if (!automation.isActive) return null;
        const { automationToTool } = require('../../automation/agentCallableTools');
        const tool = automationToTool(automation);
        const label = tool && tool.function && tool.function.name;
        if (!label) return null;
        if (!(await ensureHandoffBinding(agent, automation, opts))) return null;
        return { id: automationId, label, title: automation.title || null };
    } catch (e) {
        // "I could not check" is not "yes". No grant, no prompt line promising
        // a hand-off, and the persona keeps the mode but loses the id.
        log.warn(`[Agents] hand-off automation ${automationId} could not be verified:`, /** @type {Error} */ (e).message);
        return null;
    }
}

/**
 * Is `automation` bound to this agent, binding it now when this save is what
 * CHOOSES it?
 *
 * The binding is the grant and the persona only points at it, so:
 *   - already bound: yes;
 *   - not bound and the persona merely echoes a hand-off that was already stored
 *     (an autosave): no. The owner unlinked it since, and a save of something
 *     else must not undo that;
 *   - not bound and the hand-off is newly picked here: bind it through
 *     `agentBinding.setAgentBindings`, the one write gate (edit rights on the
 *     automation AND on this agent, the automation's owner may use the agent, no
 *     tool-name clash). Any refusal throws and the caller drops the hand-off.
 * A new agent has no id yet, so nothing can be bound for it: link it after the
 * first save.
 */
async function ensureHandoffBinding(agent, automation, { actorId = null, session = null, newSelection = false } = {}) {
    if (!agent.id) return false;
    const automationStore = require('../../stores/automationStore');
    if (await automationStore.hasAgentBinding(automation.id, agent.id)) return true;
    if (!newSelection || !actorId) return false;
    const agentBinding = require('../../automation/agentBinding');
    const current = await automationStore.listBindingsForAutomation(automation.id);
    await agentBinding.setAgentBindings({
        automation,
        agentIds: [...current.map((b) => b.agentId), agent.id],
        actorId,
        session,
    });
    return true;
}

/**
 * Normalise an incoming persona, verify what it points at, and derive the two
 * things it is the source of: the system prompt and a small, additive set of
 * config keys.
 *
 * @param {object} agent   the agent being written (needs `owner_id`)
 * @param {*} rawPersona   whatever the client sent
 * @param {object|undefined} config  the config the SAME request is writing, or
 *   undefined when it is not writing one
 * @param {object} [opts]
 * @param {string} [opts.sentSystemPrompt] the `systemPrompt` field of the SAME
 *   request, when it sent one. Only an UPDATE passes it — a create has no
 *   stored state to compare against.
 * @param {string} [opts.actorId] the person saving; without one a hand-off
 *   automation that is not bound to the agent is dropped instead of linked.
 * @param {object} [opts.session] their session, for the edit-rights checks.
 * @returns {Promise<{persona: object, config: object|undefined, systemPrompt: string|null, warnings: string[]}>}
 *   `systemPrompt` is null for "leave the stored prompt alone" — see
 *   `renderedPromptFor`; `config` comes back untouched when the request did not
 *   send one.
 */
async function resolvePersonaWrite(agent, rawPersona, config, opts = {}) {
    const personaPrompt = require('../../core/agentRuntime/personaPrompt');
    let { persona, warnings } = personaPrompt.normalisePersona(rawPersona);

    // ── WHICHEVER FIELD THE REQUEST ACTUALLY CHANGED IS THE ONE THAT WINS ──
    //
    // A client that edits the prompt box and echoes the persona back unchanged
    // has said something precise: this text is new, those fields are not.
    // Rendering the unchanged fields over the new text would delete the edit
    // and answer 200. So when the persona matches what is stored and the
    // prompt does not, the persona FOLLOWS the prompt into free mode — which
    // is the true statement about that row: the text is the source now.
    //
    // Every editor that predates A1c rebuilds its PUT body from a fixed field
    // list and never sends a persona at all, so this costs them nothing. It is
    // here for the one that echoes a whole GET response back, which is a save
    // shape this codebase already has elsewhere.
    //
    // Compared against the STORED PROMPT, never against a fresh render of the
    // stored persona: a later change to the renderer would otherwise read as
    // "the client edited the prompt" for every agent at once and freeze the lot
    // into free mode.
    if (agent && agent.persona !== undefined && typeof opts.sentSystemPrompt === 'string') {
        const storedPersona = personaPrompt.normalisePersona(agent.persona).persona;
        const personaUntouched = JSON.stringify(storedPersona) === JSON.stringify(persona);
        const promptEdited = opts.sentSystemPrompt !== (agent.system_prompt || '');
        if (personaUntouched && promptEdited) {
            persona = personaPrompt.normalisePersona({
                ...persona, mode: 'free', freeText: opts.sentSystemPrompt,
            }).persona;
        }
    }

    let handoff = null;
    if (persona.unknown.mode === 'handoff' && persona.unknown.automationId) {
        const storedUnknown = agent && agent.persona !== undefined && agent.persona !== null
            ? personaPrompt.normalisePersona(agent.persona).persona.unknown
            : null;
        const newSelection = !(storedUnknown && storedUnknown.mode === 'handoff'
            && storedUnknown.automationId === persona.unknown.automationId);
        handoff = await verifyHandoffAutomation(agent, persona.unknown.automationId, {
            actorId: opts.actorId || null, session: opts.session || null, newSelection,
        });
        if (!handoff) {
            // Dropped, not kept-and-ignored: a stored id that resolves to
            // nothing is a hand-off the editor keeps drawing and the runtime
            // never performs.
            warnings.push(`persona.unknown: automation ${persona.unknown.automationId} is not an active agent tool of this agent's owner that is linked to this agent (a new agent has to be saved first) — dropped`);
            persona.unknown.automationId = null;
        }
    }

    let systemPrompt = personaPrompt.renderedPromptFor(persona, { handoffLabel: handoff ? handoff.label : null });

    // ── A PROJECTION HANDED BACK UNCHANGED MAY NOT SHORTEN WHAT IS STORED ──
    //
    // `personaOf` shows an agent whose instruction is only a prompt as free
    // mode over that prompt — clamped to LIMITS.freeText. For an instruction
    // longer than that, what GET hands out is a TRUNCATION, and rendering it
    // back is a write that silently drops the tail. Measured: a 20 050-char
    // prompt comes back as 20 000, and the 50 characters that go are the last
    // paragraph, which in an instruction is usually the sharpest one.
    //
    // The guard is deliberately not a warning for the client to honour: an
    // editor cannot be relied on to notice, and the editor that round-trips a
    // whole GET response is exactly the shape this fires for. So the check is
    // "is this byte-for-byte the projection we would have handed out, over a
    // prompt that did not fit?" — if so the request changed nothing here, and
    // `null` lets the caller keep the stored prompt. Any real edit differs
    // from the projection and writes normally, including one that deliberately
    // shortens the instruction.
    if (persona.mode === 'free' && agent && typeof agent.system_prompt === 'string') {
        const projected = personaPrompt.personaOf(agent);
        if (projected.mode === 'free'
            && projected.freeText === persona.freeText
            && agent.system_prompt.length > persona.freeText.length) {
            warnings.push('persona.freeText: this instruction is longer than the editor can show, so it was left as it is rather than saved back truncated');
            systemPrompt = null;
        }
    }

    // The config side effects are applied ONLY to a config this request is
    // already writing. Folding them onto the stored config instead would turn
    // a persona-only PUT into a config write nobody asked for, and a request
    // that sends no config is exactly the one whose stored config we have the
    // least reason to trust ourselves to rebuild.
    let outConfig = config;
    if (config && typeof config === 'object') {
        const folded = personaPrompt.applyPersonaToConfig(config, persona, {
            handoffAutomationId: handoff ? handoff.id : null,
        });
        outConfig = folded.config;
        warnings.push(...folded.warnings);
    } else if (persona.mode === 'fields') {
        // No config in this request. Say so only when it MATTERS: fold against
        // the stored config and throw the result away, so the editor hears
        // about a setting that did not land and hears nothing when the stored
        // config already says the same thing.
        const stored = agent && agent.config && typeof agent.config === 'object' ? agent.config : {};
        const probe = personaPrompt.applyPersonaToConfig(stored, persona, {
            handoffAutomationId: handoff ? handoff.id : null,
        });
        if (probe.warnings.length > 0) {
            warnings.push('persona: the matching app/knowledge setting was not applied — this save carried no app configuration');
        }
    }

    return { persona, config: outConfig, systemPrompt, warnings };
}

module.exports = { verifyHandoffAutomation, ensureHandoffBinding, resolvePersonaWrite };
