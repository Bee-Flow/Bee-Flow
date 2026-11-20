/**
 * Unit tests for skillInjection: mergeSkillIds, sanitizeEnabledIntegrations,
 * resolveSkillAppAllowlist and the executeActivateSkill onSkillsActivated
 * callback (skill-scoped app enablement).
 *
 * Run: node core/skillInjection.test.js
 *
 * DB-free: skillStore is stubbed via require.cache BEFORE requiring
 * skillInjection (same pattern as sessionSkillRuntime.test.js). The real
 * capabilityRegistry is used for id validation — it is static config.
 */

const assert = require('assert');

// Stub skillStore before skillInjection captures the import.
const skillStorePath = require.resolve('../../stores/skillStore');
let mockSkills = [];
require.cache[skillStorePath] = {
    id: skillStorePath,
    filename: skillStorePath,
    loaded: true,
    exports: {
        createSkill: async () => { throw new Error('not stubbed'); },
        getSkillsByIds: async (ids) => {
            return mockSkills.filter(s => ids.includes(s.id));
        },
    },
};

const {
    mergeSkillIds,
    sanitizeEnabledIntegrations,
    resolveSkillAppAllowlist,
    resolveSkillGrants,
    buildSkillInjection,
    loadSkillsForIds,
    executeActivateSkill,
    SKILL_CAP,
} = require('./skillInjection');

const { executeTool } = require('./toolDispatcher');

const staticSkill = (id, apps = []) => ({ id, name: `S-${id}`, description: '', instructions: 'do it', workflow: '', rules: '', examples: '', dynamicActivation: false, automationId: null, enabledIntegrations: apps });
const dynamicSkill = (id, apps = []) => ({ ...staticSkill(id, apps), dynamicActivation: true });

(async () => {
    // ── mergeSkillIds ───────────────────────────────────────────────
    {
        assert.deepStrictEqual(mergeSkillIds(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'], 'attached first, deduped');
        assert.deepStrictEqual(mergeSkillIds([], []), [], 'empty in, empty out');
        assert.deepStrictEqual(mergeSkillIds([null, 'a'], [undefined, '']), ['a'], 'falsy ids dropped');
        const many = mergeSkillIds(['1', '2', '3', '4'], ['5', '6', '7']);
        assert.strictEqual(many.length, SKILL_CAP, `capped at SKILL_CAP (${SKILL_CAP})`);
        assert.deepStrictEqual(many, ['1', '2', '3', '4', '5'], 'attached survive the cap');
        console.log('✓ mergeSkillIds order/dedupe/cap');
    }

    // ── sanitizeEnabledIntegrations ─────────────────────────────────
    {
        assert.deepStrictEqual(sanitizeEnabledIntegrations(null), [], 'null → []');
        assert.deepStrictEqual(sanitizeEnabledIntegrations('gmail'), [], 'non-array → []');
        assert.deepStrictEqual(sanitizeEnabledIntegrations([42, {}, null]), [], 'non-strings dropped');
        const clean = sanitizeEnabledIntegrations([' gmail ', 'gmail', 'fireflies', 'definitely-not-an-app-xyz']);
        assert.deepStrictEqual(clean, ['gmail', 'fireflies'], 'trims, dedupes, drops unknown ids');
        console.log('✓ sanitizeEnabledIntegrations');
    }

    // ── resolveSkillAppAllowlist ────────────────────────────────────
    {
        // No orgId → empty (mirrors buildSkillInjection's bail-out)
        mockSkills = [staticSkill('s1', ['gmail'])];
        let r = await resolveSkillAppAllowlist({ attachedSkillIds: ['s1'], orgId: null, userId: 'u1' });
        assert.deepStrictEqual(r.allowedApps, [], 'no orgId → no apps');

        // Static skill apps always allowed
        r = await resolveSkillAppAllowlist({ attachedSkillIds: ['s1'], orgId: 'o1', userId: 'u1' });
        assert.deepStrictEqual(r.allowedApps, ['gmail'], 'static skill apps in allowlist');
        assert.strictEqual(r.dynamicSkillApps.size, 0);

        // Dynamic skill: gated until activated
        mockSkills = [dynamicSkill('d1', ['fireflies'])];
        r = await resolveSkillAppAllowlist({ sessionSkillIds: ['d1'], orgId: 'o1', userId: 'u1' });
        assert.deepStrictEqual(r.allowedApps, [], 'unactivated dynamic skill contributes nothing');
        assert.deepStrictEqual(r.dynamicSkillApps.get('d1'), ['fireflies'], 'but is tracked for activation');

        r = await resolveSkillAppAllowlist({ sessionSkillIds: ['d1'], activatedSkillIds: ['d1'], orgId: 'o1', userId: 'u1' });
        assert.deepStrictEqual(r.allowedApps, ['fireflies'], 'activated dynamic skill apps allowed');

        // forceDynamicSkills demotes static skills to activation-gated
        mockSkills = [staticSkill('s1', ['gmail'])];
        r = await resolveSkillAppAllowlist({ attachedSkillIds: ['s1'], orgId: 'o1', userId: 'u1', forceDynamicSkills: true });
        assert.deepStrictEqual(r.allowedApps, [], 'forceDynamicSkills: static apps gated');
        assert.deepStrictEqual(r.dynamicSkillApps.get('s1'), ['gmail']);

        // automationId forces dynamic regardless of the flag
        mockSkills = [{ ...staticSkill('a1', ['gmail']), automationId: 'auto-1' }];
        r = await resolveSkillAppAllowlist({ attachedSkillIds: ['a1'], orgId: 'o1', userId: 'u1' });
        assert.deepStrictEqual(r.allowedApps, [], 'automation-linked skill treated as dynamic');
        assert.deepStrictEqual(r.dynamicSkillApps.get('a1'), ['gmail']);

        // Skills without apps never appear anywhere
        mockSkills = [staticSkill('s2', []), dynamicSkill('d2', [])];
        r = await resolveSkillAppAllowlist({ attachedSkillIds: ['s2', 'd2'], orgId: 'o1', userId: 'u1' });
        assert.deepStrictEqual(r.allowedApps, []);
        assert.strictEqual(r.dynamicSkillApps.size, 0);

        // Unknown app ids on a skill are sanitized out at resolve time
        mockSkills = [staticSkill('s3', ['gmail', 'definitely-not-an-app-xyz'])];
        r = await resolveSkillAppAllowlist({ attachedSkillIds: ['s3'], orgId: 'o1', userId: 'u1' });
        assert.deepStrictEqual(r.allowedApps, ['gmail'], 'unknown ids dropped from allowlist');
        console.log('✓ resolveSkillAppAllowlist static/dynamic/forceDynamic/automation');
    }

    // ── executeActivateSkill: orgId regression pin ──────────────────
    {
        const out = await executeActivateSkill({ args: { skill_ids: ['x'] }, orgId: null, userId: 'u1' });
        assert.strictEqual(out, 'Cannot load skills without an organization context.',
            'missing orgId still returns the error string (chatStream must pass orgId)');
        console.log('✓ executeActivateSkill missing-orgId contract pinned');
    }

    // ── executeActivateSkill: onSkillsActivated callback ────────────
    {
        // Callback invoked with loaded ids; notes appended to the result
        mockSkills = [dynamicSkill('d1', ['fireflies'])];
        let calledWith = null;
        let out = await executeActivateSkill({
            args: { skill_ids: ['d1'] }, orgId: 'o1', userId: 'u1',
            onSkillsActivated: async (ids) => { calledWith = ids; return { addedTools: ['fireflies_search'], unavailableApps: [] }; },
        });
        assert.deepStrictEqual(calledWith, ['d1'], 'callback got the loaded skill ids');
        assert.ok(out.includes('SKILL — "S-d1"'), 'skill body still returned');
        assert.ok(out.includes('fireflies_search'), 'added-tools note appended');

        // Unavailable apps note
        out = await executeActivateSkill({
            args: { skill_ids: ['d1'] }, orgId: 'o1', userId: 'u1',
            onSkillsActivated: async () => ({ addedTools: [], unavailableApps: ['fireflies'] }),
        });
        assert.ok(out.includes('not connected or not permitted'), 'unavailable-apps note appended');
        assert.ok(out.includes('fireflies'), 'unavailable app named');

        // Callback throw is non-fatal
        out = await executeActivateSkill({
            args: { skill_ids: ['d1'] }, orgId: 'o1', userId: 'u1',
            onSkillsActivated: async () => { throw new Error('boom'); },
        });
        assert.ok(out.includes('SKILL — "S-d1"'), 'activation still succeeds when the callback throws');

        // Skills without apps: callback NOT invoked
        mockSkills = [dynamicSkill('d2', [])];
        calledWith = null;
        out = await executeActivateSkill({
            args: { skill_ids: ['d2'] }, orgId: 'o1', userId: 'u1',
            onSkillsActivated: async (ids) => { calledWith = ids; return { addedTools: [], unavailableApps: [] }; },
        });
        assert.strictEqual(calledWith, null, 'no apps → no callback');
        assert.ok(out.includes('SKILL — "S-d2"'));

        // No callback provided → unchanged behavior
        mockSkills = [dynamicSkill('d1', ['fireflies'])];
        out = await executeActivateSkill({ args: { skill_ids: ['d1'] }, orgId: 'o1', userId: 'u1' });
        assert.ok(out.includes('SKILL — "S-d1"'));
        console.log('✓ executeActivateSkill onSkillsActivated callback');
    }

    // ── toolDispatcher forwards onSkillsActivated ───────────────────
    {
        mockSkills = [dynamicSkill('d1', ['fireflies'])];
        let calledWith = null;
        const out = await executeTool('activate_skill', { skill_ids: ['d1'] }, {
            userId: 'u1', orgId: 'o1',
            onSkillsActivated: async (ids) => { calledWith = ids; return { addedTools: [], unavailableApps: [] }; },
        });
        assert.deepStrictEqual(calledWith, ['d1'], 'dispatcher forwarded the callback');
        assert.ok(typeof out === 'string' && out.includes('SKILL — "S-d1"'));
        console.log('✓ toolDispatcher forwards onSkillsActivated');
    }

    // ── "Only through agents" (skills.agent_only, core/skills/agentOnlySkills.mts) ──
    // Ignored as a SESSION skill (the composer's picker, activeSkillIds) unless
    // an agent brings it in; enforced in every reader the turn goes through.
    {
        const kept = { ...staticSkill('kept', ['gmail']), instructions: 'body of kept', knowledgeBaseIds: ['kb-kept'], steps: [], allowedAutomationIds: [], agentOnly: true };
        const open = { ...staticSkill('open'), instructions: 'body of open' };
        mockSkills = [open, kept];
        const direct = await buildSkillInjection({ sessionSkillIds: ['open', 'kept'], attachedSkillIds: [], orgId: 'o1', userId: 'u1' });
        assert.ok(direct.systemPromptAddendum.includes('body of open') && !direct.systemPromptAddendum.includes('body of kept'), 'direct chat: agent-only session skill left out');
        assert.strictEqual(direct.staticCount, 1);
        const attached = await buildSkillInjection({ sessionSkillIds: [], attachedSkillIds: ['kept'], orgId: 'o1', userId: 'u1', agentId: 'a1' });
        assert.ok(attached.systemPromptAddendum.includes('body of kept'), 'an agent that attaches it keeps it');
        const otherAgent = await buildSkillInjection({ sessionSkillIds: ['kept'], attachedSkillIds: ['open'], orgId: 'o1', userId: 'u1', agentId: 'a1' });
        assert.ok(!otherAgent.systemPromptAddendum.includes('body of kept'), 'an agent that does NOT attach it: still a session skill, ignored');
        const preloaded = await buildSkillInjection({ sessionSkillIds: ['kept'], attachedSkillIds: [], orgId: 'o1', userId: 'u1', preloadedSkills: [kept] });
        assert.strictEqual(preloaded.systemPromptAddendum, '', 'preloaded rows: same rule');
        const viaAgent = await buildSkillInjection({ sessionSkillIds: ['kept'], attachedSkillIds: [], agentSkillIds: ['kept'], orgId: 'o1', userId: 'u1' });
        assert.ok(viaAgent.systemPromptAddendum.includes('body of kept'), 'agentSkillIds (an AI step bound to an agent) widens the rule');

        mockSkills = [{ ...kept, dynamicActivation: true }];
        const dyn = await buildSkillInjection({ sessionSkillIds: ['kept'], attachedSkillIds: [], orgId: 'o1', userId: 'u1' });
        assert.deepStrictEqual([dyn.systemPromptAddendum, dyn.tools, dyn.dynamicSkillIds], ['', [], []], 'not in the on-demand manifest either');

        mockSkills = [open, kept];
        assert.deepStrictEqual((await resolveSkillAppAllowlist({ sessionSkillIds: ['kept'], attachedSkillIds: [], orgId: 'o1', userId: 'u1' })).allowedApps, [], 'no apps from it');
        assert.deepStrictEqual((await resolveSkillGrants({ sessionSkillIds: ['kept'], attachedSkillIds: [], orgId: 'o1', userId: 'u1' })).kbIds, [], 'no grants from it');
        assert.deepStrictEqual((await resolveSkillGrants({ sessionSkillIds: [], attachedSkillIds: ['kept'], orgId: 'o1', userId: 'u1' })).kbIds, ['kb-kept'], 'grants when attached');
        const loaded = await loadSkillsForIds({ sessionSkillIds: ['kept', 'open'], attachedSkillIds: [], orgId: 'o1', userId: 'u1' });
        assert.deepStrictEqual(loaded.skills.map(s => s.id), ['open'], 'loadSkillsForIds: same rule');
        const loadedViaAgent = await loadSkillsForIds({ sessionSkillIds: ['kept'], attachedSkillIds: [], agentSkillIds: ['kept'], orgId: 'o1', userId: 'u1' });
        assert.deepStrictEqual(loadedViaAgent.skills.map(s => s.id), ['kept']);

        const noAgent = await executeActivateSkill({ args: { skill_ids: ['kept'] }, orgId: 'o1', userId: 'u1', onSkillsActivated: null });
        assert.ok(!noAgent.includes('body of kept'), 'activate_skill without an agent does not load it by id');
        const withAgent = await executeActivateSkill({ args: { skill_ids: ['kept'] }, orgId: 'o1', userId: 'u1', agentId: 'a1', onSkillsActivated: null });
        assert.ok(withAgent.includes('body of kept'), 'with an agent it does');
        console.log('✓ agent-only skills are ignored as session skills without an agent');
    }

    console.log('\nALL SKILL INJECTION TESTS PASSED');
    process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
