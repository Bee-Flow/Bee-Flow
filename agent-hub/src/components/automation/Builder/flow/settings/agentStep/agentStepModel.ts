// Pure helpers behind the AI step's "Who does the thinking" block (handoff 5,
// round 3). React-free, so the rules (which skill leads, what a switch writes,
// how tools group per integration) are tested without rendering anything.
import type { AgentPermissions, AgentSkillRef, AgentStepPreview, AgentToolGroup } from '../../../../../../api/queries/automation/agents';
import { AGENT_PERMISSION_KEYS } from '../../../../../../api/queries/automation/agents';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';

export interface StepSkillRow {
    id: string;
    name: string;
    /** 'step' = picked for this step (extra), 'agent' = one of the agent's own. */
    source: 'step' | 'agent';
    enabled: boolean;
    leading: boolean;
}

/**
 * The skill list of one step, in the order the run uses them: the step's own
 * skills first (author's order), then the agent's. The leading skill is the
 * first ENABLED one, the one whose instructions come first and whose output
 * fields the step inherits.
 */
export function stepSkillRows(
    stepSkillIds: string[],
    agentSkills: AgentSkillRef[] | null,
    disabledAgentSkillIds: string[],
    nameById: Map<string, string>,
): StepSkillRow[] {
    const rows: StepSkillRow[] = stepSkillIds.map((id) => ({
        id, name: nameById.get(id) || id, source: 'step', enabled: true, leading: false,
    }));
    const taken = new Set(stepSkillIds);
    const off = new Set(disabledAgentSkillIds);
    for (const s of agentSkills || []) {
        if (!s.fromAgent || taken.has(s.id)) continue;
        taken.add(s.id);
        rows.push({ id: s.id, name: s.name || nameById.get(s.id) || s.id, source: 'agent', enabled: !off.has(s.id), leading: false });
    }
    const lead = rows.find((r) => r.enabled);
    if (lead) lead.leading = true;
    return rows;
}

/** The three switches, always all three and always real booleans. */
export function withPermission(current: Partial<AgentPermissions> | null | undefined, key: keyof AgentPermissions, on: boolean): AgentPermissions {
    const next = {} as AgentPermissions;
    for (const k of AGENT_PERMISSION_KEYS) next[k] = k === key ? on === true : current?.[k] === true;
    return next;
}

export function allPermissionsOff(): AgentPermissions {
    return { startAutomations: false, useKnowledge: false, useTools: false };
}

/** Toggle one agent skill off/on for this step, as the stored exclusion list. */
export function toggleDisabledSkill(disabled: string[], id: string, enabled: boolean): string[] {
    const rest = disabled.filter((d) => d !== id);
    return enabled ? rest : [...rest, id];
}

interface CatalogApp {
    id?: string;
    label?: string;
    actions?: Array<{ name?: string; label?: string; integrationLabel?: string }>;
}

/**
 * The agent's tools grouped per integration, for the chips under "The agent's
 * tools". The server's own `tools` groups win; an older server only sends the
 * `allowed`/`withheld` names, which are grouped here by the catalog's apps.
 * A group is struck through only when EVERY tool in it is withheld.
 */
export function toolGroupsOf(preview: AgentStepPreview | null | undefined, apps: CatalogApp[] = []): AgentToolGroup[] {
    if (!preview) return [];
    if (Array.isArray(preview.tools)) return preview.tools;
    const appOf = new Map<string, CatalogApp>();
    for (const app of apps) for (const a of app.actions || []) if (a.name) appOf.set(a.name, app);
    const groups = new Map<string, AgentToolGroup>();
    const add = (name: string, withheld: boolean, reason: string | null) => {
        const app = appOf.get(name);
        const key = app?.id || app?.label || name;
        const label = app?.label || app?.actions?.find((a) => a.name === name)?.integrationLabel || name;
        const g = groups.get(key) || { integration: key, label, tools: [], withheld: true, reason: null };
        g.tools.push(name);
        if (!withheld) { g.withheld = false; g.reason = null; } else if (g.withheld) g.reason = reason;
        groups.set(key, g);
    };
    for (const name of preview.allowed) add(name, false, null);
    for (const w of preview.withheld) add(w.name, true, w.reason);
    return [...groups.values()];
}

/** Why a struck-through chip is struck through, as a tooltip. */
export function withheldReasonText(t: TranslateFn, reason: string | null): string {
    switch (reason) {
        case 'confirm':
            return t('routines.agent_step.withheld_confirm', 'Off here: it would ask someone to confirm first.');
        case 'permission':
            return t('routines.agent_step.withheld_permission', 'Off here: switched off above.');
        default:
            return t('routines.agent_step.withheld_unavailable', 'Not available to this step.');
    }
}

/** "v8 · organisation · knows A, B · 2 skills" under the agent's name. */
export function agentMetaLine(t: TranslateFn, preview: AgentStepPreview | null | undefined, skillCount: number): string {
    if (!preview) return '';
    const parts: string[] = [];
    if (preview.version != null) parts.push(t('routines.agent_step.meta_version', 'v{n}', { n: preview.version }));
    if (preview.scope === 'org') parts.push(t('routines.agent_step.meta_scope_org', 'organisation'));
    if (preview.scope === 'personal') parts.push(t('routines.agent_step.meta_scope_personal', 'personal'));
    const kbs = preview.knowledgeBases || [];
    if (kbs.length > 0) parts.push(t('routines.agent_step.meta_knows', 'knows {names}', { names: kbs.map((k) => k.name).join(', ') }));
    if (skillCount > 0) {
        parts.push(skillCount === 1
            ? t('routines.agent_step.meta_skills', '{count} skill', { count: skillCount })
            : t('routines.agent_step.meta_skills_plural', '{count} skills', { count: skillCount }));
    }
    return parts.join(' · ');
}

/** The type word under a "Continues as" field. */
export function fieldTypeWord(t: TranslateFn, type: string): string {
    switch (type) {
        case 'number': return t('routines.agent_step.type_number', 'number');
        case 'boolean': return t('routines.agent_step.type_boolean', 'yes or no');
        case 'datetime': return t('routines.agent_step.type_datetime', 'date');
        case 'array': return t('routines.agent_step.type_array', 'list');
        case 'object': return t('routines.agent_step.type_object', 'group of fields');
        default: return t('routines.agent_step.type_string', 'text');
    }
}
