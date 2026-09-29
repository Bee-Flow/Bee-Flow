// State and reads behind the AI step's "Who does the thinking" block: the
// mode, the agent preview, the skill list and the leading skill's contract,
// plus the writes each control makes. Kept out of the component so the
// component is layout only.
//
// Two builders of the SAME shape: `useAgentStepState` reads from the server,
// `plainAgentStepState` is the bare step (no agent, no skill, nothing asked
// for) and calls no hooks at all. A plain AI step therefore needs no query
// client, and nothing is fetched for a step that does not use any of this.
import { useMemo } from 'react';
import type { AgentPermissions, AgentStepPreview, SkillOutputField, SkillRow } from '../../../../../../api/queries/automation/agents';
import {
    useAgentStepPreviewQuery, useCatalogSkillQuery, useStepSkillsQuery,
} from '../../../../../../api/queries/automation/agents';
import { MAX_AI_STEP_SKILL_IDS, readAgentPermissions, readSkillIds } from '../formState';
import { allPermissionsOff, stepSkillRows, toggleDisabledSkill, withPermission } from './agentStepModel';
import type { StepSkillRow } from './agentStepModel';
import type { ThinkingMode } from './ThinkingModeCards';

export type QueryStatus = 'loading' | 'error' | 'ok';

interface OutputFieldDraft { key?: string; type?: string }

export interface AiStepDraft {
    agentId?: string | null;
    skillIds?: string[];
    disabledAgentSkillIds?: string[];
    agentPermissions?: Partial<AgentPermissions> | null;
    tools?: string[] | null;
    outputFields?: OutputFieldDraft[];
    [key: string]: unknown;
}

export type SetField = (key: string, value: unknown) => void;

/** UI state that outlives the switch from the plain to the live block. */
export interface AgentStepUi {
    wantAgent: boolean;
    setWantAgent: (v: boolean) => void;
    adding: boolean;
    setAdding: (v: boolean) => void;
}

const statusOf = (q: { isError: boolean; data: unknown }): QueryStatus => (q.isError ? 'error' : q.data ? 'ok' : 'loading');

/** The draft's agent fields, read once into plain values. */
function readAgentStepDraft(draft: AiStepDraft) {
    const stepFields: SkillOutputField[] = (draft.outputFields || []).flatMap((f) => (
        typeof f?.key === 'string' && f.key ? [{ key: f.key, type: f.type || 'string', title: null }] : []));
    return {
        agentId: typeof draft.agentId === 'string' && draft.agentId ? draft.agentId : null,
        permissions: readAgentPermissions(draft.agentPermissions) as AgentPermissions,
        skillIds: readSkillIds(draft.skillIds) as string[],
        disabled: readSkillIds(draft.disabledAgentSkillIds) as string[],
        allowList: Array.isArray(draft.tools) ? draft.tools : null,
        stepFields,
    };
}

type DraftValues = ReturnType<typeof readAgentStepDraft>;

/** What each control writes. */
function agentStepActions(set: SetField, v: DraftValues, ui: AgentStepUi) {
    const atCap = v.skillIds.length >= MAX_AI_STEP_SKILL_IDS;
    // Another agent is another toolbelt: the three yeses do not carry over,
    // and neither do the agent-skill exclusions.
    const resetAgentScope = () => {
        set('agentPermissions', allPermissionsOff());
        set('disabledAgentSkillIds', []);
    };
    return {
        chooseMode: (next: ThinkingMode) => {
            ui.setWantAgent(next === 'agent');
            if (next === 'instruction' && v.agentId) { set('agentId', null); resetAgentScope(); }
        },
        chooseAgent: (id: string) => { set('agentId', id); resetAgentScope(); },
        addSkill: (id: string) => {
            // Appended, so the first pick keeps leading; the cap is the runner's.
            if (!v.skillIds.includes(id) && !atCap) set('skillIds', [...v.skillIds, id]);
        },
        removeSkill: (id: string) => set('skillIds', v.skillIds.filter((s) => s !== id)),
        toggleAgentSkill: (id: string, on: boolean) => set('disabledAgentSkillIds', toggleDisabledSkill(v.disabled, id, on)),
        setPermission: (key: keyof AgentPermissions, on: boolean) => set('agentPermissions', withPermission(v.permissions, key, on)),
        setAdding: ui.setAdding,
    };
}

interface Reads {
    preview: AgentStepPreview | null;
    previewForbidden: boolean;
    previewStatus: QueryStatus;
    skillRows: StepSkillRow[];
    skillList: SkillRow[] | null;
    skillListStatus: QueryStatus;
    leadName: string | null;
    skillFields: SkillOutputField[] | null;
}

/** The parts both builders share, given what the reads produced. */
function assemble(set: SetField, v: DraftValues, ui: AgentStepUi, reads: Reads) {
    const mode: ThinkingMode = v.agentId || ui.wantAgent ? 'agent' : 'instruction';
    return {
        ...reads,
        agentId: v.agentId,
        mode,
        permissions: v.permissions,
        stepFields: v.stepFields,
        adding: ui.adding,
        atCap: v.skillIds.length >= MAX_AI_STEP_SKILL_IDS,
        cap: MAX_AI_STEP_SKILL_IDS,
        withAgentOrSkill: mode === 'agent' || v.skillIds.length > 0,
        actions: agentStepActions(set, v, ui),
    };
}

export type AgentStepState = ReturnType<typeof assemble>;

/** True when the block has something to read from the server. */
export function agentStepIsLive(draft: AiStepDraft, ui: AgentStepUi): boolean {
    const v = readAgentStepDraft(draft);
    return !!v.agentId || v.skillIds.length > 0 || ui.wantAgent || ui.adding;
}

/** The bare step: nothing to read, so no hooks. */
export function plainAgentStepState(draft: AiStepDraft, set: SetField, ui: AgentStepUi): AgentStepState {
    return assemble(set, readAgentStepDraft(draft), ui, {
        preview: null, previewForbidden: false, previewStatus: 'loading',
        skillRows: [], skillList: null, skillListStatus: 'loading', leadName: null, skillFields: null,
    });
}

/** The skill reads: the list (names, add menu) and the leading skill's contract. */
function useSkillReads(v: DraftValues, previewData: AgentStepPreview | null, adding: boolean) {
    const skillList = useStepSkillsQuery(v.skillIds.length > 0 || adding);
    const nameById = useMemo(() => new Map((skillList.data || []).map((s) => [s.id, s.name])), [skillList.data]);
    const skillRows = stepSkillRows(v.skillIds, previewData?.skills ?? null, v.disabled, nameById);
    const lead = skillRows.find((r) => r.leading) || null;
    const leadSkill = useCatalogSkillQuery(lead?.id ?? null);
    return {
        skillRows,
        skillList: skillList.data || null,
        skillListStatus: statusOf(skillList),
        leadName: leadSkill.data?.name || lead?.name || null,
        skillFields: leadSkill.data?.outputFields ?? null,
    };
}

export function useAgentStepState(draft: AiStepDraft, set: SetField, ui: AgentStepUi): AgentStepState {
    const v = readAgentStepDraft(draft);
    const preview = useAgentStepPreviewQuery(v.agentId, v.permissions, v.allowList, {
        skillIds: v.skillIds, disabledAgentSkillIds: v.disabled,
    });
    const previewData: AgentStepPreview | null = v.agentId && preview.data?.canUse ? preview.data : null;
    const skills = useSkillReads(v, previewData, ui.adding);
    return assemble(set, v, ui, {
        ...skills,
        preview: previewData,
        previewForbidden: preview.data?.canUse === false,
        previewStatus: statusOf(preview),
    });
}
