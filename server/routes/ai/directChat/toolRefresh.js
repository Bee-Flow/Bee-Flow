/**
 * Direct Chat — the two ways the live tool list grows mid-turn.
 *
 * `applyLoadTools` answers a `load_tools` call by injecting a progressive-
 * disclosure group's real schemas; `onSkillsActivated` widens the integration
 * allowlist when the model activates dynamic library skills. Both push onto
 * `turn.directChatTools`, which the very next streamed round re-reads, and
 * both keep the assembly's name order so the prompt cache is rebuilt once and
 * not on every turn after. Moved verbatim out of streamTurn.js.
 */

const agentStore = require('../../../stores/agentStore');
const { encryptionOpts } = require('./shared');
const log = require('../../../telemetry/log');

function applyLoadTools(turn, toolArgs) {
    const { send, toolDisclosure, disclosureLazyByGroup, directChatTools, activatedToolGroups } = turn;
    if (!disclosureLazyByGroup) return 'Tool groups are not available in this conversation.';
    const loadedNames = new Set(directChatTools.map(t => t.function?.name || t.name));
    const res = toolDisclosure.expandGroups(toolArgs?.groups, {
        lazyByGroup: disclosureLazyByGroup,
        loadedNames,
        currentToolCount: directChatTools.length,
    });
    for (const def of res.addedDefs) {
        const { _mcp, _n8n, ...clean } = def;
        const cname = clean.function?.name || clean.name;
        if (!directChatTools.find(t => (t.function?.name || t.name) === cname)) {
            directChatTools.push(clean);
        }
    }
    // Keep the same deterministic order the initial assembly used, so
    // later turns of this conversation match once the activation is
    // persisted. Expanding a group is a deliberate one-off cache
    // rebuild; drifting order would make every turn after it one too.
    directChatTools.sort((a, b) =>
        (a.function?.name || a.name || '').localeCompare(b.function?.name || b.name || ''));
    for (const key of res.added) activatedToolGroups.add(key);
    if (res.added.length) send('tools_loaded', { groups: res.added });
    return toolDisclosure.buildLoadResult(res);
}

async function onSkillsActivated(turn, justActivatedIds) {
    const { req, userId, convId, skillApps, activatedLibrarySkillIds, directChatTools, baseDirectToolNames } = turn;
    const result = { addedTools: [], unavailableApps: [] };
    const newApps = [];
    let activationChanged = false;
    for (const sid of justActivatedIds || []) {
        const apps = skillApps.dynamicSkillApps.get(sid);
        if (!apps) continue;
        if (!activatedLibrarySkillIds.includes(sid)) {
            activatedLibrarySkillIds.push(sid);
            activationChanged = true;
        }
        for (const a of apps) {
            if (!skillApps.allowedApps.includes(a) && !newApps.includes(a)) newApps.push(a);
        }
    }
    if (activationChanged && convId) {
        // Fire-and-forget; also folded into the end-of-turn updateMeta.
        agentStore.updateDirectConversationMeta(convId, userId, { activatedSkillIds: [...activatedLibrarySkillIds] }, encryptionOpts(req))
            .catch(err => log.warn('[DirectChat] Persisting activatedSkillIds failed:', err.message));
    }
    if (newApps.length === 0) return result;

    skillApps.allowedApps.push(...newApps);
    try {
        const { getIntegrationTools } = require('../../../core/integrations/integrationTools');
        const fresh = await getIntegrationTools({
            userId,
            session: req.session,
            isAdmin: req.session?.isAdmin,
            extraEnabledApps: skillApps.allowedApps,
        });
        const loadedNames = new Set(directChatTools.map(t => t.function?.name || t.name));
        for (const def of fresh.tools) {
            const { _mcp, _n8n, ...clean } = def;
            const cname = clean.function?.name;
            if (!cname || baseDirectToolNames.has(cname) || loadedNames.has(cname)) continue;
            directChatTools.push(clean);
            baseDirectToolNames.add(cname);
            result.addedTools.push(cname);
        }
        if (result.addedTools.length > 0) {
            log.info(`[DirectChat] Skill activation added ${result.addedTools.length} integration tool(s): ${result.addedTools.join(', ')}`);
        } else {
            // Entitlement/credential gates blocked the apps (or their
            // tools were already present) — tell the model.
            result.unavailableApps = newApps;
        }
    } catch (err) {
        log.warn('[DirectChat] Skill-app tool refresh failed:', err.message);
        result.unavailableApps = newApps;
    }
    return result;
}

module.exports = { applyLoadTools, onSkillsActivated };
