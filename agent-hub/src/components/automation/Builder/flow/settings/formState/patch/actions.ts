/**
 * buildPatch for the steps that act: the AI step, an app action, code, a
 * notification and an HTTP request.
 */
import { buildReliabilityPatch } from '../../aiStepReliability/reliabilityModel';
import { MAX_AI_STEP_SKILL_IDS, readAgentPermissions, readSkillIds } from '../aiStepAgent';
import { sanitizeInputs } from '../bindings';
import { fieldsToSchema } from '../outputSchema';
import { clamp } from '../primitives';
import { applyAskOncePatch, applyCacheIntoPatch, applyForEachPatch } from '../stepOptions';
import type { TypePatcher } from '../types';

export const actionPatchers: Record<string, TypePatcher> = {
    ai_step: (patch, step, draft) => {
        patch.prompt = draft.prompt || '';
        patch.systemPrompt = draft.systemPrompt?.trim() ? draft.systemPrompt.trim() : null;
        patch.modelTier = draft.modelTier || 'auto';
        // When the user has made an explicit tool selection, persist the
        // allowlist and derive allowTools from it (the runner only loads tools
        // when allowTools is on). Untouched legacy steps keep `tools` absent and
        // their original allowTools, so "all permitted tools" behaviour stays.
        if (Array.isArray(draft.tools)) {
            patch.tools = draft.tools;
            patch.allowTools = draft.tools.length > 0;
        } else {
            patch.allowTools = !!draft.allowTools;
        }
        patch.inputs = sanitizeInputs(draft.inputs || {});
        patch.outputSchema = fieldsToSchema(draft.outputFields || []);
        patch.knowledgeBaseIds = Array.isArray(draft.knowledgeBaseIds)
            ? draft.knowledgeBaseIds.filter((id) => typeof id === 'string' && id)
            : [];
        // R2. `agentPermissions` is REBUILT here as well as read: the patch is
        // what reaches the server, and sending a half-object would let a key
        // arrive as `undefined` — the shape this whole feature refuses. The
        // skill list keeps the author's ORDER (the first is the leading skill)
        // and is cut at the cap here so the editor can say which ones would be
        // dropped, instead of the runner dropping them silently.
        patch.agentId = typeof draft.agentId === 'string' && draft.agentId.trim() ? draft.agentId.trim() : null;
        patch.skillIds = readSkillIds(draft.skillIds).slice(0, MAX_AI_STEP_SKILL_IDS);
        patch.agentPermissions = readAgentPermissions(draft.agentPermissions);
        // Only meaningful with an agent: without one there are no agent skills
        // to switch off, and a stale list would silently apply to the next agent.
        patch.disabledAgentSkillIds = patch.agentId ? readSkillIds(draft.disabledAgentSkillIds) : [];
        applyForEachPatch(patch, step, draft); // C12 — was dropped both ways
        Object.assign(patch, buildReliabilityPatch(draft, step));
        applyAskOncePatch(patch, step, draft);
    },
    integration_action: (patch, step, draft) => {
        patch.inputs = sanitizeInputs(draft.inputs || {});
        // Operation switcher (single-node, n8n-style): the node's tool can
        // change in place. Persist tool + appId + the authoritative sideEffect
        // flag so the badge, dry-run handling, and downstream schema stay
        // correct after a switch. Always send tool (unchanged on normal edits).
        patch.tool = draft.tool || step.tool || '';
        if (draft.appId || step.appId) patch.appId = draft.appId || step.appId;
        if (draft.sideEffect != null) patch.sideEffect = draft.sideEffect;
        applyForEachPatch(patch, step, draft);
        applyAskOncePatch(patch, step, draft);
    },
    code: (patch, step, draft) => {
        patch.code = draft.code || '';
        // BOTH directions or neither. extractFormState carrying `inputs`
        // while this did not would lose every edit; this carrying them while
        // extractFormState did not would ship `inputs: {}` on every unrelated
        // save and wipe the step's real inputs. codeFields.jsx's probe checks
        // both for that reason.
        patch.inputs = sanitizeInputs(draft.inputs || {});
        // Where ctx.http may go besides the hosts the code names (the
        // runner's host list, core/automationRunner/codeStepGuard.js).
        const hosts = (Array.isArray(draft.allowedHosts) ? draft.allowedHosts : []).filter(h => typeof h === 'string' && h.trim());
        if (hosts.length || Array.isArray(step.allowedHosts)) patch.allowedHosts = hosts;
        applyForEachPatch(patch, step, draft); // C16/C18
    },
    notification: (patch, step, draft) => {
        patch.title = draft.title || '';
        patch.body = draft.body || '';
        // Omitted rather than defaulted when untouched: the runner already
        // treats a missing `channels` as the bell, and writing one in would
        // dirty every notification step the user merely opened.
        if (Array.isArray(draft.channels)) patch.channels = draft.channels;
        applyForEachPatch(patch, step, draft); // C18 — runner honours it, form never exposed it
    },
    http_request: (patch, step, draft) => {
        patch.url = draft.url || '';
        patch.method = (draft.method || 'GET').toUpperCase();
        patch.headers = draft.headers && typeof draft.headers === 'object' ? draft.headers : {};
        patch.body = draft.body || '';
        // Off (null) is stored as absence, so a step without parameters stays as it was.
        patch.query = draft.query && typeof draft.query === 'object' ? draft.query : undefined;
        patch.timeoutMs = clamp(Number(draft.timeoutMs) || 10_000, 1000, 60_000);
        // Optional per-step security toggle (default true = blocked) — not
        // mandatory, but always persisted explicitly so the definition
        // never depends on the "defaults true" convention silently.
        patch.blockPrivateTargets = draft.blockPrivateTargets !== false;
        // 'auto' is the default, so it is stored as absence rather than a value.
        patch.parseResponse = ['never', 'always'].includes(draft.parseResponse) ? draft.parseResponse : undefined;
        // Credential reference — explicit null clears it in the definition
        // (same "persist explicitly" style as blockPrivateTargets).
        patch.auth = draft.auth?.connectionId ? { connectionId: draft.auth.connectionId } : null;
        applyForEachPatch(patch, step, draft);
        applyAskOncePatch(patch, step, draft);
        applyCacheIntoPatch(patch, step, draft);
    },
};
