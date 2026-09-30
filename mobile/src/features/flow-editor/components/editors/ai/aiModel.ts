/**
 * The AI step's choices, pure — from the web's aiStepEditors.jsx and
 * agentStepFields.jsx:
 *
 *   - who does the thinking: the agent list (and "could not read the list",
 *     which is not "there are none"), picking one (its three permissions all
 *     start off again: another agent is another toolbelt), and each switch;
 *   - the skills, in the author's order (the first leads), capped;
 *   - the knowledge bases;
 *   - the tools the step may call: an explicit allowlist, or a legacy step's
 *     "all available tools" until the author chooses specific ones.
 * Pinned by ai.lockstep.test.ts.
 */

import type { CatalogAgent, CatalogAppRow, FlowCatalog } from '@/features/flow-editor/api';
import { AI_STEP_AGENT_PERMISSION_KEYS, MAX_AI_STEP_SKILL_IDS, type FormDraft } from '@/features/flow-editor/formState';
import { humanizeToolName } from '@/features/flow-editor/model';

import { msg, type Msg } from '../declarative/spec';

/** The agents the picker shows, or null when the list could not be read (not the same as none). */
export function agentRowsOf(catalog: Pick<FlowCatalog, 'agents' | 'agentsError'> | null | undefined): CatalogAgent[] | null {
    if (!catalog || typeof catalog !== 'object') return null;
    if (catalog.agentsError) return null;
    if (!Array.isArray(catalog.agents)) return null;
    return catalog.agents;
}

/** Why an agent cannot be picked — never a silent omission. */
export function agentReason(reason: string | null | undefined): Msg {
    switch (reason) {
        case 'not_published':
            return msg('routine_editor.agent_reason_not_published', 'Not published yet — publish it to use it in a routine.');
        case 'other_org':
            return msg('routine_editor.agent_reason_other_org', 'Belongs to another workspace.');
        case 'not_shared':
            return msg('routine_editor.agent_reason_not_shared', 'Not shared with you.');
        default:
            return msg('routine_editor.agent_reason_unavailable', 'Not available to this routine.');
    }
}

/** What each permission switch turns on, in one line. */
export function permissionWords(key: string): { label: Msg; hint: Msg } {
    if (key === 'startAutomations') {
        return {
            label: msg('routine_editor.agent_perm_start_automations', 'Start other routines'),
            hint: msg('routine_editor.agent_perm_start_automations_hint', 'The agent may run the routines its owner granted it — and only the ones you could run yourself.'),
        };
    }
    if (key === 'useKnowledge') {
        return {
            label: msg('routine_editor.agent_perm_use_knowledge', 'Use its knowledge bases'),
            hint: msg(
                'routine_editor.agent_perm_use_knowledge_hint',
                "Adds the agent's own knowledge bases to this step, on top of the ones picked below. Only bases you may read are searched.",
            ),
        };
    }
    return {
        label: msg('routine_editor.agent_perm_use_tools', 'Use its tools'),
        hint: msg(
            'routine_editor.agent_perm_use_tools_hint',
            'Lets the agent call the apps its owner granted it. Anything that needs a person to approve it is left out — see below.',
        ),
    };
}

type Permissions = Record<string, boolean>;

const permissionsOf = (draft: FormDraft): Permissions => (draft.agentPermissions as Permissions | undefined) ?? {};

/** Another agent is another toolbelt: its permissions start off. */
export function chooseAgent(id: string | null): FormDraft {
    return { agentId: id, agentPermissions: Object.fromEntries(AI_STEP_AGENT_PERMISSION_KEYS.map((k) => [k, false])) };
}

/** One switch, the other two REBUILT from the known names — never a half-object. */
export function setPermission(draft: FormDraft, key: string, on: boolean): FormDraft {
    const current = permissionsOf(draft);
    return { agentPermissions: Object.fromEntries(AI_STEP_AGENT_PERMISSION_KEYS.map((k) => [k, k === key ? on === true : current[k] === true])) };
}

const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** A skill ticked or unticked; appended so the FIRST pick stays the leading one; the cap is real. */
export function toggleSkill(draft: FormDraft, id: string): FormDraft | null {
    const selected = idsOf(draft.skillIds);
    if (selected.includes(id)) return { skillIds: selected.filter((s) => s !== id) };
    if (selected.length >= MAX_AI_STEP_SKILL_IDS) return null;
    return { skillIds: [...selected, id] };
}

export function toggleKnowledgeBase(draft: FormDraft, id: string): FormDraft {
    const selected = idsOf(draft.knowledgeBaseIds);
    return { knowledgeBaseIds: selected.includes(id) ? selected.filter((k) => k !== id) : [...selected, id] };
}

// ── Tools ──────────────────────────────────────────────────────────────

/** Apps the caller can actually use, with something to call. */
export function toolApps(catalog: Pick<FlowCatalog, 'apps'> | null | undefined): CatalogAppRow[] {
    return (catalog?.apps || []).filter((a) => a.available !== false && (a.actions || []).length > 0);
}

/** `tools` unset + allowTools on: the legacy "every permitted tool". */
export function isLegacyAllTools(draft: FormDraft): boolean {
    return !Array.isArray(draft.tools) && !!draft.allowTools;
}

const toolsOf = (draft: FormDraft): string[] => (Array.isArray(draft.tools) ? idsOf(draft.tools) : []);

export function toggleTool(draft: FormDraft, name: string): FormDraft {
    const base = toolsOf(draft);
    return { tools: base.includes(name) ? base.filter((n) => n !== name) : [...base, name] };
}

export function toggleApp(draft: FormDraft, app: CatalogAppRow, on: boolean): FormDraft {
    const names = (app.actions || []).map((a) => a.name);
    const base = new Set(toolsOf(draft));
    for (const n of names) {
        if (on) base.add(n);
        else base.delete(n);
    }
    return { tools: [...base] };
}

/** Legacy "all" → explicit: start from every available tool, so nothing changes until the author unticks. */
export function chooseSpecificTools(apps: readonly CatalogAppRow[]): FormDraft {
    return { tools: apps.flatMap((a) => (a.actions || []).map((x) => x.name)) };
}

/** "Gmail: Send email", or the tool's name made readable. */
export function toolLabel(name: string, apps: readonly CatalogAppRow[]): string {
    for (const app of apps) {
        const action = (app.actions || []).find((a) => a.name === name);
        if (!action) continue;
        const appLabel = app.label || action.integrationLabel || '';
        const actionLabel = action.label || humanizeToolName(name);
        return appLabel ? `${appLabel}: ${actionLabel}` : actionLabel;
    }
    return humanizeToolName(name);
}
