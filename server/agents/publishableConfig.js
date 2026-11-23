// @typecheck
/**
 * What an agent's concept may become when it goes live — the anti-leak
 * validation of every cross-element reference in its config, the fold of that
 * verdict into the config that gets written, and the two together for a
 * publish.
 *
 * Moved out of routes/agents/crud.js and routes/agents/publishVersion.js so
 * code below routes/ (the Solution deploy engine) publishes an agent through
 * the same checks POST /agents/:id/publish-version runs. routes/agents/crud.js
 * re-exports validateAgentConfigReferences and applyConfigValidation.
 *
 * Every store is injectable (`deps`, a module or a function returning one) and
 * the defaults are required lazily, at call time.
 */

'use strict';

const log = require('../telemetry/log');
const { fallback } = require('../utils/bestEffort');

/** A dependency given as a module, as a function that loads one, or absent. */
function resolveDep(given, load) {
    if (typeof given === 'function') return given();
    return given || load();
}

/**
 * Knowledge base references of an agent config.
 * Anti-leak invariant: a linked KB must belong to the AGENT'S organisation
 * (org-governed content — org admins curate which org KBs an agent uses),
 * be owned by the agent owner (their personal KB), or be a public system KB.
 * Block ONLY cross-org KBs. We deliberately do NOT require the owner to pass
 * the KB's publish/shared_groups gates — those govern per-user *retrieval* at
 * query time, not whether the KB may be referenced. (The previous
 * canUserAccessKB(owner) check rejected same-org drafts / group-restricted
 * KBs whenever the agent owner wasn't in the KB's shared_groups, which broke
 * KB-linking on agents owned by users outside those per-role groups.)
 *
 * A base that no longer exists, or that its owner has since taken off the
 * agent surface, is DROPPED with a warning rather than refused: the
 * editor sends the whole config on every autosave and cannot show such a
 * base, so a refusal made the agent unsaveable for good. Dropping never
 * widens access. A lookup that FAILS is not "gone": that refuses (503),
 * so a database hiccup never unlinks a base that is still there.
 *
 * Pushes the hard refusals into `errors` and the soft drops into `warnings`;
 * returns the ids the caller must strip before writing.
 *
 * @param {{ owner_id?: string, organization_id?: string | null }} agent
 * @param {Record<string, unknown>} config
 * @param {{ kbStore?: unknown, usageContexts?: unknown }} deps
 * @param {string[]} errors
 * @param {string[]} warnings
 * @returns {Promise<string[]>}
 */
async function checkKnowledgeBases(agent, config, deps, errors, warnings) {
    const ownerId = agent.owner_id;
    const agentOrgId = agent.organization_id || null;
    const kbIds = Array.isArray(config.knowledge_base_ids) ? config.knowledge_base_ids.filter(Boolean) : [];
    /** @type {string[]} */
    const droppedKbIds = [];
    if (kbIds.length === 0) return droppedKbIds;
    const kbStore = resolveDep(deps.kbStore, () => require('../stores/knowledgeBases'));
    const { kbUsableIn } = resolveDep(deps.usageContexts, () => require('../core/kb/usageContexts'));
    for (const kbId of kbIds) {
        let kb;
        try {
            kb = await kbStore.getKB(kbId);
        } catch (e) {
            log.warn('[Agents] Knowledge base lookup failed while validating an agent config:', /** @type {Error} */ (e).message);
            const err = /** @type {Error & { status?: number, expose?: boolean }} */ (
                new Error('The linked knowledge bases could not be checked. Try again.'));
            err.status = 503;
            err.expose = true;
            throw err;
        }
        if (!kb) {
            droppedKbIds.push(kbId);
            warnings.push(`knowledge base ${kbId} (no longer exists)`);
            continue;
        }
        const sameOrg = !!(kb.organization_id && agentOrgId && kb.organization_id === agentOrgId);
        const ownedByOwner = kb.tenant_id === ownerId;
        const isSystem = !!kbStore.isSystemKB(kb);
        if (!(sameOrg || ownedByOwner || isSystem)) {
            errors.push(`knowledge base ${kbId}`);
            continue;
        }
        // The base's owner decides which SURFACES it may be attached to
        // (Knowledge → Settings → "Waar inzetbaar"). A base marked
        // chat-only is not used by the agent: it is unlinked, so the
        // toggle stays a setting and the agent stays saveable.
        //
        // A system base is exempt: it is public reference text with no
        // owner to have expressed a preference.
        if (!isSystem && !kbUsableIn(kb, 'agent')) {
            droppedKbIds.push(kbId);
            warnings.push(`knowledge base ${kbId} (not available for agents)`);
        }
    }
    return droppedKbIds;
}

/**
 * Validate that every cross-element ID referenced from an agent's config is
 * accessible to the AGENT'S OWNER (not the requesting user). This closes the
 * leak path where an editor in org A could attach a KB/skill that belongs to a
 * different org — once the agent is published, anyone who can see the agent
 * would receive cross-org data through it.
 *
 * Throws an Error with `status: 400` for a cross-org knowledge base (the one
 * hard refusal) and `status: 503` when a base cannot be looked up; skills that
 * cannot be resolved and bases that are gone or not for agents are DROPPED
 * (`droppedSkillIds`, `droppedKbIds`, each with a warning) and tool grants are
 * clamped (`tools`).
 *
 * @param {{ id?: string, owner_id?: string, organization_id?: string | null }} agent
 * @param {Record<string, unknown>} config  the config about to be written
 * @param {{ kbStore?: unknown, skillStore?: unknown, usageContexts?: unknown, toolPolicy?: unknown }} [deps]
 *   each a module, or a function that returns one (resolveDep)
 * @returns {Promise<{warnings: string[], droppedSkillIds: string[], droppedKbIds: string[], tools: object|null}>}
 */
async function validateAgentConfigReferences(agent, config, deps = {}) {
    if (!config || typeof config !== 'object') return { warnings: [], droppedSkillIds: [], droppedKbIds: [], tools: null };
    const errors = [];              // hard failures → 400 (cross-org KB leak)
    const warnings = [];            // soft: a reference we drop from the persisted config
    const droppedSkillIds = [];     // skill ids the caller must strip before writing
    let normalisedTools = null;     // clamped config.tools the caller must persist

    const ownerId = agent.owner_id;
    const agentOrgId = agent.organization_id || null;
    // ── Knowledge base references (see checkKnowledgeBases) ──
    const droppedKbIds = await checkKnowledgeBases(agent, config, deps, errors, warnings);

    // ── Skill references (wizard stores them as attachedSkillIds) ──
    // Anti-leak invariant, mirroring the KB block above: a linked skill must
    // belong to the AGENT'S organisation. We check org-membership ONLY — NOT the
    // per-user picker visibility (`getSkill`'s user_id/is_shared/shared_groups
    // clause). The old code used getSkill(sid, org, owner), which wrongly
    // rejected a same-org skill created by a *different* member (is_shared=false)
    // — exactly what the refine flow produces when an org-admin edits another
    // user's agent — and hard-400'd EVERY skill on an org-less agent, breaking
    // every save after a refine that adds one.
    //
    // Instead of failing the whole save, a skill that can't be resolved to the
    // agent's org is DROPPED from the persisted config (recorded as a warning).
    // Dropping is strictly anti-leak-preserving: a cross-org/unknown id is never
    // stored, and runtime skill injection is org-scoped regardless. (KBs stay a
    // hard 400 — cross-org KB linking is the documented high-severity leak.)
    const skillIds = Array.isArray(config.attachedSkillIds) ? config.attachedSkillIds.filter(Boolean) : [];
    if (skillIds.length > 0) {
        const skillStore = resolveDep(deps.skillStore, () => require('../stores/skillStore'));
        for (const sid of skillIds) {
            const scope = await skillStore.getSkillScope(sid).catch((e) => fallback('agents/publishableConfig:validateAgentConfigReferences#2', e, null));
            const sameOrg = !!(scope && scope.org_id && agentOrgId && scope.org_id === agentOrgId);
            // Personal (org-less) skill owned by the agent owner — mirrors the
            // owner-owned KB rule above, so org-less accounts can attach skills.
            const ownedPersonal = !!(scope && !scope.org_id && scope.user_id && scope.user_id === ownerId);
            if (!(sameOrg || ownedPersonal)) {
                droppedSkillIds.push(sid);
                warnings.push(`skill ${sid}`);
            }
        }
    }

    // ── Per-action tool grants (config.tools) ──
    // Clamped rather than rejected: `normaliseToolsConfig` never throws and
    // never widens, so a config that arrives with a `direct` on a tool that
    // mails comes back with `ask` instead of bouncing the whole save. "Never
    // widens" is load-bearing on THIS side, because what comes back is written
    // to the row, and it has two doors. A value the clamp cannot read (a bare
    // string where a list of actions belongs) grants nothing and says so in
    // `warnings`, never as `'*'` — the whole app, persisted, on
    // a client's typo. An app past the size bound does the same: it is kept as
    // `{actions: []}` rather than DROPPED, because a missing entry reads as
    // "every action of this app" to every reader in toolPolicy, so truncating
    // the list was the same widening with no `'*'` anywhere in sight. The
    // runtime re-clamps on every read (agentCrud._clampRuntimeTools) — this
    // side exists so what the editor reads back is what will actually run,
    // and so a legacy editor that rebuilds `config` from a fixed field list
    // cannot silently resurrect a value the runtime would refuse.
    //
    // Skipped entirely when there is no map: an agent that predates the map
    // must not acquire one just by being saved.
    if (config.tools && typeof config.tools === 'object') {
        try {
            const policy = resolveDep(deps.toolPolicy, () => require('../core/agentRuntime/toolPolicy'));
            const lentProviders = await policy.resolveLentProviders({
                agentId: agent.id, ownerId: agent.owner_id,
            });
            const norm = policy.normaliseToolsConfig(config, {
                agentId: agent.id, ownerId: agent.owner_id, lentProviders,
            });
            if (norm.tools) {
                normalisedTools = norm.tools;
                warnings.push(...norm.warnings);
            }
        } catch (e) {
            // Same posture as the store: keep what was sent rather than
            // replacing it. Emptying the map here would silently delete a
            // curation the user can no longer see they had, over a transient
            // module failure — and an unclamped map is re-clamped on the next
            // read, while the two rules that matter (a send is always asked
            // about, a borrowed identity is re-checked at dispatch) never
            // depended on the stored value in the first place.
            log.warn('[Agents] Tool-grant normalisation unavailable — storing the grants as sent:', e.message);
            warnings.push('tool grants could not be validated');
        }
    }

    if (errors.length > 0) {
        const err = new Error(`Agent owner cannot access: ${errors.join(', ')}`);
        err.status = 400;
        throw err;
    }

    return { warnings, droppedSkillIds, droppedKbIds, tools: normalisedTools };
}

/**
 * Fold a validation verdict back into the config that gets persisted.
 *
 * Both writers of the concept AND the publish copy go through here, so the two
 * cannot drift into applying different halves of the same verdict — dropping
 * skills on one path and clamping grants on the other is exactly the kind of
 * gap that only shows up once a grant reaches the runtime.
 */
function applyConfigValidation(config, validation) {
    if (!config || typeof config !== 'object' || !validation) return config;
    let out = config;
    const dropped = validation.droppedSkillIds || [];
    if (dropped.length > 0 && Array.isArray(config.attachedSkillIds)) {
        const drop = new Set(dropped);
        out = { ...out, attachedSkillIds: config.attachedSkillIds.filter(id => !drop.has(id)) };
    }
    const droppedKbs = validation.droppedKbIds || [];
    if (droppedKbs.length > 0 && Array.isArray(config.knowledge_base_ids)) {
        const drop = new Set(droppedKbs);
        out = { ...out, knowledge_base_ids: config.knowledge_base_ids.filter(id => !drop.has(id)) };
    }
    // The clamped map is written back WHOLE — including when it clamps to `{}`.
    //
    // Keeping the caller's raw map whenever the clamp empties it, for
    // fear that a stored `{}` would read as "someone has been through the
    // picker", buys nothing: `hasCuratedGrants` asks the CONTENTS, and `{}` and
    // `{gmail:'nope'}` are the same nothing to every reader there is — grants,
    // curation, confirm, actAs. And it costs
    // one thing the clamp is for: a REFUSED section (`datatables`, an
    // `automations` array, an entry that is not an object) empties the map, and
    // the raw value was then persisted verbatim — after which `GET /agents/:id`
    // handed the editor back a limit that enforces nothing and the owner
    // believed it. A refusal that lasts until the next read is not a refusal.
    //
    // `validation.tools` is null when there was no map to clamp, and also when
    // the clamp itself was unavailable — both keep what the caller sent, which
    // is the deliberate "do not delete a curation over a transient failure"
    // path above.
    if (validation.tools && typeof validation.tools === 'object') {
        out = { ...out, tools: validation.tools };
    }
    return out;
}

/**
 * The concept as it may go live: re-validated against the OWNER, with the
 * verdict applied to a copy (never to the concept — that stays the editor's).
 * Throws what validateAgentConfigReferences throws.
 *
 * `deps.validateAgentConfigReferences` / `deps.applyConfigValidation` replace
 * the two halves (the publish route passes its own, so its tests can stand in
 * for them).
 *
 * @returns {Promise<{warnings: string[], config: object}>}
 */
async function publishableConfig(agent, deps = {}) {
    const validate = deps.validateAgentConfigReferences || validateAgentConfigReferences;
    const apply = deps.applyConfigValidation || applyConfigValidation;
    const v = await validate(agent, agent.config || {});
    return { warnings: v?.warnings || [], config: apply(agent.config || {}, v) };
}

module.exports = { publishableConfig, validateAgentConfigReferences, applyConfigValidation };
