/**
 * Skill injection — shared logic for resolving active/attached skills into
 * a system-prompt addendum + an optional on-demand tool registration.
 *
 * Split behavior:
 *   - Static skills (dynamic_activation = false): full body injected into the
 *     system prompt on every turn (the original behavior).
 *   - Dynamic skills (dynamic_activation = true): only a 1-line manifest entry
 *     injected. The AI calls `activate_skill` to pull the full body into the
 *     conversation when it's actually relevant. Saves tokens when an agent
 *     has many skills attached but only a few apply per message.
 *
 * ── Structured skills (Bee Flow Builder redesign, Sep 2026, S1) ──────
 * A skill row now carries structure (`steps`, `rulesV2`, `examplesV2`,
 * `outputSchema`, `knowledgeBaseIds`, `allowedAutomationIds`) NEXT TO the
 * text columns the prompt is built from. The store keeps the text in sync
 * on every write, so the prompt still renders from `workflow` / `rules` /
 * `examples` and a migrated skill renders byte-identically; only a row
 * that has structure but no text (never written by the store — a
 * defensive case) is rendered from the structure.
 *
 * What an ACTIVE skill grants, beyond its prompt text, is answered by ONE
 * adapter — `resolveSkillGrants` (per skill: `skillGrantsOf`):
 *   { automationIds, tableRefs, kbIds }
 *   - automationIds  `allowed_automation_ids` — automations the agent may call
 *                    as tools (only `agent_call`-trigger automations are meant
 *                    here; the A-chain's agent-grant path decides at
 *                    dispatch time, never a stored definition).
 *   - tableRefs      `steps[].refs` of kind `table` → `{ id, scope:'own',
 *                    readOnly:true }` for the `datatable_query` allowlist.
 *   - kbIds          `knowledge_base_ids` ∪ `steps[].refs` of kind `kb` →
 *                    added to the agent's KB search allowlist
 *                    (`resolveSkillKbAllowlist` is the KB-only view, next to
 *                    `resolveSkillAppAllowlist`).
 * Same static/dynamic partition as the prompt: a dynamic skill contributes
 * nothing until its id is in `activatedSkillIds`.
 *
 * Both the static path (`buildSkillInjection`) and `executeActivateSkill`
 * record a `skill_activations` row (stores/skillActivations.js) so the
 * Studio can show "last used"; the write is fire-and-forget.
 */

const skillStore = require('../../stores/skillStore');
const {
    textOrRender,
    renderStepsToWorkflow,
    renderRulesToText,
    renderExamplesToText,
    tableRefsOf,
    refIdsOf,
} = require('../skills/skillStructure');
const log = require('../../telemetry/log');

const SKILL_CAP = 5;
const ACTIVATE_SKILL_TOOL_NAME = 'activate_skill';
const SKILL_INTEGRATIONS_CAP = 50;

/**
 * Merge attached + session skill ids: attached first (so they survive the
 * cap), deduped, truncated at SKILL_CAP. Shared by buildSkillInjection and
 * resolveSkillAppAllowlist so prompt injection and the app allowlist can
 * never diverge on cap or order.
 */
function mergeSkillIds(attachedSkillIds = [], sessionSkillIds = []) {
    const seen = new Set();
    const mergedIds = [];
    for (const id of [...attachedSkillIds, ...sessionSkillIds]) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        mergedIds.push(id);
        if (mergedIds.length >= SKILL_CAP) break;
    }
    return mergedIds;
}

/**
 * Coerce a skill's enabledIntegrations payload to a clean array of known
 * integration ids. Unknown ids are dropped when the capability registry is
 * available; if the registry can't be loaded we fail open with the sanitized
 * list (same posture as integrationTools' isKnownIntegration) — the runtime
 * entitlement gate still decides what actually turns on.
 */
function sanitizeEnabledIntegrations(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const cleaned = [];
    for (const raw of list) {
        if (typeof raw !== 'string') continue;
        const id = raw.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        cleaned.push(id);
        if (cleaned.length >= SKILL_INTEGRATIONS_CAP) break;
    }
    try {
        const capReg = require('../entitlements/capabilityRegistry');
        return cleaned.filter(id => capReg.getCapability(id)?.kind === 'integration');
    } catch (_) {
        return cleaned;
    }
}

/**
 * Resolve which integration apps the active skills contribute to the tool
 * allowlist for this conversation.
 *
 * Static skills (always-on) contribute their apps unconditionally; dynamic
 * skills only once their id appears in `activatedSkillIds` (persisted per
 * conversation after the model calls activate_skill).
 *
 * Returns:
 *   allowedApps      — app ids to pass as getIntegrationTools extraEnabledApps
 *   dynamicSkillApps — Map<skillId, appIds[]> for not-yet-activated dynamic
 *                      skills (used by the onSkillsActivated callback)
 *   mergedIds        — the capped merged skill id list (diagnostics)
 */
async function resolveSkillAppAllowlist({ attachedSkillIds = [], sessionSkillIds = [], activatedSkillIds = [], orgId, userId, forceDynamicSkills = false }) {
    const empty = { allowedApps: [], dynamicSkillApps: new Map(), mergedIds: [] };
    if (!orgId) return empty;
    const mergedIds = mergeSkillIds(attachedSkillIds, sessionSkillIds);
    if (mergedIds.length === 0) return empty;

    let skills;
    try {
        skills = await skillStore.getSkillsByIds(mergedIds, orgId, userId);
    } catch (err) {
        log.warn('[skillInjection] resolveSkillAppAllowlist getSkillsByIds failed:', err.message);
        return empty;
    }
    if (!skills || skills.length === 0) return empty;

    const activatedSet = new Set(activatedSkillIds);
    const allowed = new Set();
    const dynamicSkillApps = new Map();
    for (const s of skills) {
        const apps = sanitizeEnabledIntegrations(s.enabledIntegrations);
        if (apps.length === 0) continue;
        // Same partition as buildSkillInjection: automation-linked skills are
        // always dynamic; forceDynamicSkills (Flow tier) demotes everything.
        const isDynamic = forceDynamicSkills || s.dynamicActivation || !!s.automationId;
        if (!isDynamic || activatedSet.has(s.id)) {
            apps.forEach(a => allowed.add(a));
        } else {
            dynamicSkillApps.set(s.id, apps);
        }
    }
    return { allowedApps: [...allowed], dynamicSkillApps, mergedIds };
}

// ── Structured grants (S1 adapter for the A chain) ───────────────────

/**
 * Same partition everywhere: an automation-linked skill is always dynamic;
 * forceDynamicSkills (Flow tier) demotes everything.
 */
function isDynamicSkill(skill, forceDynamicSkills = false) {
    return forceDynamicSkills || skill.dynamicActivation === true || !!skill.automationId;
}

/**
 * What ONE skill grants while it is active. Pure — reads the mapped row.
 *
 * @param {Object} skill  a mapped skill row (stores/skillStore.js mapRow)
 * @returns {{ automationIds: string[], tableRefs: Array<{id:string,scope:'own',readOnly:true}>, kbIds: string[] }}
 */
function skillGrantsOf(skill) {
    const steps = Array.isArray(skill?.steps) ? skill.steps : [];
    const kbIds = new Set();
    for (const id of Array.isArray(skill?.knowledgeBaseIds) ? skill.knowledgeBaseIds : []) if (typeof id === 'string' && id) kbIds.add(id);
    for (const id of refIdsOf(steps, 'kb')) kbIds.add(id);
    const automationIds = new Set();
    for (const id of Array.isArray(skill?.allowedAutomationIds) ? skill.allowedAutomationIds : []) if (typeof id === 'string' && id) automationIds.add(id);
    // A step that references an automation is presentation only unless the
    // automation is also in `allowed_automation_ids` — "may use" is the grant.
    return {
        automationIds: [...automationIds],
        tableRefs: tableRefsOf(steps),
        kbIds: [...kbIds],
    };
}

function emptyGrants() {
    return { automationIds: [], tableRefs: [], kbIds: [], dynamicSkillGrants: new Map(), mergedIds: [] };
}

/**
 * The adapter the tool stack consumes (A1b / toolStackAssembly): everything
 * the ACTIVE skills of this conversation grant, merged and deduped.
 *
 *   automationIds      — offer these automations as agent-callable tools (via
 *                        the agent-grant path; ownership/activity is checked
 *                        at dispatch, this list is never trusted on its own)
 *   tableRefs          — add to the `datatable_query` allowlist, scope `own`,
 *                        read-only, for this conversation only
 *   kbIds              — union into the agent's KB search allowlist (the
 *                        per-asker filter of K5 still applies on top)
 *   dynamicSkillGrants — Map<skillId, grants> for dynamic skills not yet
 *                        activated (for the onSkillsActivated refresh)
 *   mergedIds          — the capped merged skill id list (diagnostics)
 *
 * Same inputs and same static/dynamic partition as resolveSkillAppAllowlist.
 */
async function resolveSkillGrants({ attachedSkillIds = [], sessionSkillIds = [], activatedSkillIds = [], orgId, userId, forceDynamicSkills = false }) {
    const empty = emptyGrants();
    if (!orgId) return empty;
    const mergedIds = mergeSkillIds(attachedSkillIds, sessionSkillIds);
    if (mergedIds.length === 0) return empty;

    let skills;
    try {
        skills = await skillStore.getSkillsByIds(mergedIds, orgId, userId);
    } catch (err) {
        log.warn('[skillInjection] resolveSkillGrants getSkillsByIds failed:', err.message);
        return empty;
    }
    if (!skills || skills.length === 0) return empty;

    const activatedSet = new Set(activatedSkillIds);
    const automationIds = new Set();
    const tableRefs = new Map();
    const kbIds = new Set();
    const dynamicSkillGrants = new Map();
    for (const s of skills) {
        const g = skillGrantsOf(s);
        if (g.automationIds.length === 0 && g.tableRefs.length === 0 && g.kbIds.length === 0) continue;
        if (!isDynamicSkill(s, forceDynamicSkills) || activatedSet.has(s.id)) {
            g.automationIds.forEach(id => automationIds.add(id));
            g.tableRefs.forEach(r => { if (!tableRefs.has(r.id)) tableRefs.set(r.id, r); });
            g.kbIds.forEach(id => kbIds.add(id));
        } else {
            dynamicSkillGrants.set(s.id, g);
        }
    }
    return {
        automationIds: [...automationIds],
        tableRefs: [...tableRefs.values()],
        kbIds: [...kbIds],
        dynamicSkillGrants,
        mergedIds,
    };
}

/**
 * KB-only view of resolveSkillGrants, next to resolveSkillAppAllowlist:
 * the knowledge bases the active skills add to the agent's search allowlist.
 *
 * @returns {Promise<{ kbIds: string[], dynamicSkillKbs: Map<string,string[]>, mergedIds: string[] }>}
 */
async function resolveSkillKbAllowlist(opts) {
    const g = await resolveSkillGrants(opts);
    const dynamicSkillKbs = new Map();
    for (const [id, grants] of g.dynamicSkillGrants) if (grants.kbIds.length > 0) dynamicSkillKbs.set(id, grants.kbIds);
    return { kbIds: g.kbIds, dynamicSkillKbs, mergedIds: g.mergedIds };
}

/** The three prompt facets, from the stored text — or, for a row without text, from its structure. */
function skillBodyText(skill) {
    return {
        workflow: textOrRender(skill.workflow, skill.steps, renderStepsToWorkflow),
        rules: textOrRender(skill.rules, skill.rulesV2, renderRulesToText),
        examples: textOrRender(skill.examples, skill.examplesV2, renderExamplesToText),
    };
}

/** Fire-and-forget "this skill was used" write; never throws, never awaited by the prompt path. */
function recordSkillActivations(skillIds, { agentId = null, conversationId = null, userId = null, source = 'static' } = {}) {
    if (!Array.isArray(skillIds) || skillIds.length === 0) return;
    try {
        const activations = require('../../stores/skillActivations');
        Promise.resolve(activations.recordActivations({ skillIds, agentId, conversationId, userId, source }))
            .catch(err => log.warn('[skillInjection] recordActivations failed:', err.message));
    } catch (err) {
        log.warn('[skillInjection] skillActivations unavailable:', err.message);
    }
}

/**
 * Resolve merged skill ids into prompt text + tool registration data.
 *
 * @param {Object}   opts
 * @param {string[]} opts.sessionSkillIds  — user-toggled skills (activeSkillIds)
 * @param {string[]} opts.attachedSkillIds — agent.config.attachedSkillIds
 * @param {string}   opts.orgId
 * @param {string}   opts.userId
 * @param {string}   [opts.agentId]        — for the skill_activations row ("last used by")
 * @param {string}   [opts.conversationId] — dedupes the static write to one per conversation
 * @returns {Promise<{
 *   systemPromptAddendum: string,
 *   tools: Array,
 *   dynamicSkillIds: string[],
 *   staticCount: number,
 * }>}
 */
async function buildSkillInjection({ sessionSkillIds = [], attachedSkillIds = [], orgId, userId, forceDynamicSkills = false, agentId = null, conversationId = null, preloadedSkills = null }) {
    if (!orgId) return { systemPromptAddendum: '', tools: [], dynamicSkillIds: [], automationSkillIds: [], staticCount: 0 };

    const mergedIds = mergeSkillIds(attachedSkillIds, sessionSkillIds);
    if (mergedIds.length === 0) return { systemPromptAddendum: '', tools: [], dynamicSkillIds: [], automationSkillIds: [], staticCount: 0 };

    let skills;
    if (Array.isArray(preloadedSkills)) {
        // Rows the caller already loaded with loadSkillsForIds (same ids, same
        // org and asker), so one AI step does not read the same skills twice.
        // Kept to the merged ids, in the caller's order.
        const wanted = new Set(mergedIds);
        skills = preloadedSkills.filter(s => s && wanted.has(s.id));
    } else {
        try {
            skills = await skillStore.getSkillsByIds(mergedIds, orgId, userId);
        } catch (err) {
            log.warn('[skillInjection] getSkillsByIds failed:', err.message);
            return { systemPromptAddendum: '', tools: [], dynamicSkillIds: [], automationSkillIds: [], staticCount: 0 };
        }
    }
    if (!skills || skills.length === 0) return { systemPromptAddendum: '', tools: [], dynamicSkillIds: [], automationSkillIds: [], staticCount: 0 };

    // Flow tier (forceDynamicSkills) treats every skill as dynamic so the
    // model lazy-loads bodies via activate_skill instead of paying the static
    // injection cost on every turn — matches how session skills work.
    // Skills linked to an automation are also forced dynamic regardless of
    // their per-row flag, since their "body" is the automation run output.
    const staticSkills = skills.filter(s => !isDynamicSkill(s, forceDynamicSkills));
    const dynamicSkills = skills.filter(s => isDynamicSkill(s, forceDynamicSkills));

    let addendum = '';

    if (staticSkills.length > 0) {
        const blocks = staticSkills.map(s => {
            const body = skillBodyText(s);
            let b = `\n### SKILL — "${s.name}"`;
            if (s.instructions) b += `\nInstructions: ${s.instructions}`;
            if (body.workflow)  b += `\nWorkflow: ${body.workflow}`;
            if (body.rules)     b += `\nRules: ${body.rules}`;
            if (body.examples)  b += `\nExamples: ${body.examples}`;
            return b;
        }).join('\n');
        addendum += `\n\n[ACTIVE SKILLS]\nThe user has activated the following skills. Follow their instructions precisely when the task matches.${blocks}`;
        // "Last used": one row per conversation (the static path runs every turn).
        recordSkillActivations(staticSkills.map(s => s.id), { agentId, conversationId, userId, source: 'static' });
    }

    const tools = [];
    if (dynamicSkills.length > 0) {
        const manifest = dynamicSkills
            .map(s => {
                const flowTag = s.automationId ? ' [runs an automation]' : '';
                return `- ${s.id} · ${s.name}${flowTag} — ${s.description || '(no description)'}`;
            })
            .join('\n');
        addendum += `\n\n[AVAILABLE SKILLS — ON DEMAND]\nThese skills are available but not yet loaded. Their full instructions cost tokens, so only load what you need.\nWhen a user request matches one or more of these skills, call the \`${ACTIVATE_SKILL_TOOL_NAME}\` tool with the matching skill id(s) BEFORE replying. Do NOT call it speculatively. Once loaded within a conversation, the full instructions stay in context — don't call the tool again for the same skill.\n${manifest}`;

        tools.push({
            type: 'function',
            function: {
                name: ACTIVATE_SKILL_TOOL_NAME,
                description: 'Load the full instructions, workflow, rules, and examples for one or more skills listed under [AVAILABLE SKILLS — ON DEMAND]. Only call this when the user\'s request matches one of the listed skills. After this returns, follow the loaded skill\'s guidance for the rest of the conversation.',
                parameters: {
                    type: 'object',
                    properties: {
                        skill_ids: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Array of skill ids (UUIDs) from the manifest to load.',
                        },
                    },
                    required: ['skill_ids'],
                },
            },
        });
    }

    return {
        systemPromptAddendum: addendum,
        tools,
        dynamicSkillIds: dynamicSkills.map(s => s.id),
        // De ids waarvan `activate_skill` een AUTOMATISERING start: hun "body" is een
        // automation, en `executeActivateSkill` draait die hieronder met
        // `mode: 'live'`. Meegegeven omdat de aanroeper anders niet kan weten
        // dat de ene tool die hij terugkrijgt méér doet dan tekst laden — en op
        // een onbewaakt oppervlak (de ai_step van een automatisering) hangt dat aan een
        // andere schakelaar dan gewone skills. Leeg voor elke bestaande
        // aanroeper, dus niets verandert er voor de chat.
        automationSkillIds: dynamicSkills.filter(s => s.automationId).map(s => s.id),
        staticCount: staticSkills.length,
    };
}

/**
 * Load the skills of one merged id list (attached first, capped at SKILL_CAP),
 * as the asker may see them, IN MERGED ORDER. The store returns rows in its
 * own order; the first id is the leading skill, so the order is restored here.
 * Throws when the store does; the caller decides what a failed read means.
 *
 * @returns {Promise<{ mergedIds: string[], skills: Object[] }>}
 */
async function loadSkillsForIds({ attachedSkillIds = [], sessionSkillIds = [], orgId, userId, deps = {} }) {
    const store = deps.skillStore || skillStore;
    const mergedIds = mergeSkillIds(attachedSkillIds, sessionSkillIds);
    if (mergedIds.length === 0) return { mergedIds, skills: [] };
    const rows = await store.getSkillsByIds(mergedIds, orgId, userId);
    const byId = new Map((Array.isArray(rows) ? rows : []).filter(r => r && r.id).map(r => [r.id, r]));
    return { mergedIds, skills: mergedIds.map(id => byId.get(id)).filter(Boolean) };
}

/**
 * Handler invoked when the model calls `activate_skill`. Returns a string
 * that the dispatcher feeds back as the tool result; the model then has the
 * full skill bodies available in conversation context for subsequent turns.
 */
async function executeActivateSkill({ args, orgId, userId, onSkillsActivated, agentId = null, conversationId = null, callerAgentId = null, runScope = null }) {
    const ids = Array.isArray(args?.skill_ids) ? args.skill_ids.filter(Boolean) : [];
    if (ids.length === 0) return 'No skill_ids provided.';
    if (!orgId) return 'Cannot load skills without an organization context.';

    let skills;
    try {
        skills = await skillStore.getSkillsByIds(ids, orgId, userId);
    } catch (err) {
        return `Failed to load skills: ${err.message}`;
    }
    if (!skills || skills.length === 0) {
        return `None of the requested skill ids were found or accessible: ${ids.join(', ')}`;
    }
    recordSkillActivations(skills.map(s => s.id), { agentId, conversationId, userId, source: 'activate_skill' });

    // Skill-scoped app enablement: tell the runtime which skills just became
    // active so it can widen the integration-tool allowlist mid-conversation.
    // Non-fatal by design — activation must still succeed if the tool refresh
    // fails; the model just won't get the extra tools this turn.
    let appNote = '';
    const skillsWithApps = skills.filter(s => Array.isArray(s.enabledIntegrations) && s.enabledIntegrations.length > 0);
    if (typeof onSkillsActivated === 'function' && skillsWithApps.length > 0) {
        try {
            const result = await onSkillsActivated(skills.map(s => s.id));
            const addedTools = Array.isArray(result?.addedTools) ? result.addedTools : [];
            const unavailableApps = Array.isArray(result?.unavailableApps) ? result.unavailableApps : [];
            if (addedTools.length > 0) {
                appNote += `\n\nThis skill enabled additional app tools: ${addedTools.join(', ')}. They are available from your next step.`;
            }
            if (unavailableApps.length > 0) {
                appNote += `\n\n(Note: the app(s) ${unavailableApps.join(', ')} configured on this skill are not available — not connected or not permitted by the organization. Do not attempt to use their tools.)`;
            }
        } catch (err) {
            log.warn('[skillInjection] onSkillsActivated failed:', err.message);
        }
    }

    // Lazily required to avoid pulling automation runtime into modules that
    // don't need it. Falls back gracefully if the modules aren't available.
    let automationStore = null;
    let automationRunner = null;
    try {
        automationStore = require('../../stores/automationStore');
        automationRunner = require('../automationRunner');
    } catch (_) { /* automation runtime not available — skill→automation links will be skipped */ }

    const blocks = await Promise.all(skills.map(async (s) => {
        // Linked automation: dispatch the flow and return its output instead of
        // injecting the skill's text body. The text fields (instructions, etc.)
        // become irrelevant — the automation IS the implementation.
        if (s.automationId && automationStore && automationRunner) {
            try {
                const automation = await automationStore.getAutomation(s.automationId);
                if (!automation) {
                    return `### SKILL — "${s.name}" (id: ${s.id})\n_Linked automation ${s.automationId} not found._`;
                }
                // Handoff 5: a skill that runs an automation is an agent starting
                // an automation, so it counts against the same nesting limit and
                // records who started it (automation/automationCallDepth.js).
                const { runNestedAutomationCall } = require('../../automation/automationCallDepth');
                const trace = {
                    callerAgentId: callerAgentId || agentId || null,
                    callerConversationId: conversationId || null,
                    callerRunId: (runScope && runScope.runId) || null,
                };
                const run = await runNestedAutomationCall({ automationId: automation.id, ...trace }, () => automationRunner.executeAutomation(automation, {
                    triggerKind: 'manual',
                    triggerPayload: { invokedBy: 'skill', skillId: s.id, args: args || {} },
                    mode: 'live',
                    callerAgentId: trace.callerAgentId,
                    callerConversationId: trace.callerConversationId,
                }));
                const status = run?.status || 'unknown';
                const summary = run?.summary || '';
                // Read the last RECORDED step rather than run.lastOutput: this
                // is the persisted source, so it still answers for a run that
                // paused and resumed (approval, form page) in another process.
                // `run.lastOutput` is the in-memory alternative and is now
                // populated too — either works here; this one is the sturdier.
                let lastOutput = null;
                try {
                    const steps = run?.id ? await automationStore.getRunSteps(run.id) : [];
                    // Skip a trailing `wait`: it is dead time, not a result,
                    // and runDag now defers waits to the END of a fan-out
                    // (BFSF-371), so the last row is often the sleep.
                    const last = Array.isArray(steps) ? steps.findLast(s => s.stepType !== 'wait') : null;
                    if (last) lastOutput = last.output;
                } catch (_) { /* non-fatal */ }
                let body = `### SKILL — "${s.name}" (id: ${s.id})\nThis skill ran the linked automation "${automation.title || automation.id}".\nStatus: ${status}`;
                if (summary) body += `\nSummary: ${summary}`;
                if (lastOutput !== undefined && lastOutput !== null) {
                    const rendered = typeof lastOutput === 'string'
                        ? lastOutput
                        : JSON.stringify(lastOutput, null, 2);
                    body += `\n\nResult:\n${rendered.length > 4000 ? rendered.slice(0, 4000) + '\n…(truncated)' : rendered}`;
                }
                return body;
            } catch (err) {
                return `### SKILL — "${s.name}" (id: ${s.id})\n_Linked automation failed: ${err.message}_`;
            }
        }
        // Plain text-instructions skill — original behaviour.
        const body = skillBodyText(s);
        let b = `### SKILL — "${s.name}" (id: ${s.id})`;
        if (s.description)  b += `\n${s.description}`;
        if (s.instructions) b += `\n\nInstructions:\n${s.instructions}`;
        if (body.workflow)  b += `\n\nWorkflow:\n${body.workflow}`;
        if (body.rules)     b += `\n\nRules:\n${body.rules}`;
        if (body.examples)  b += `\n\nExamples:\n${body.examples}`;
        return b;
    }));

    const joined = blocks.join('\n\n---\n\n');
    const missing = ids.filter(id => !skills.some(s => s.id === id));
    const missingNote = missing.length > 0
        ? `\n\n(Note: ${missing.length} id(s) not found or not accessible: ${missing.join(', ')})`
        : '';

    return `Loaded ${skills.length} skill(s). Follow their guidance from this point on — you do NOT need to call activate_skill again for these in this conversation.\n\n${joined}${missingNote}${appNote}`;
}

module.exports = {
    buildSkillInjection,
    loadSkillsForIds,
    executeActivateSkill,
    mergeSkillIds,
    sanitizeEnabledIntegrations,
    resolveSkillAppAllowlist,
    resolveSkillKbAllowlist,
    resolveSkillGrants,
    skillGrantsOf,
    isDynamicSkill,
    ACTIVATE_SKILL_TOOL_NAME,
    SKILL_CAP,
};
