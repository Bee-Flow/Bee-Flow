/**
 * The AI step's editor — the web's AiStepFields (aiStepEditors.jsx): who does
 * the thinking first (it changes what everything below means: with an agent
 * the prompt is the brief for THIS step), then the prompt, the advanced
 * settings (system prompt, model tier, tools, memory, knowledge, iteration,
 * retry), the named inputs the prompt can mention, and the structured output.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTiers } from '@/features/chat';
import { BindingInput, FieldRow, MultilineField, RowsEditor, SelectField, ToggleField } from '@/features/flow-editor/components/fields';
import type { OutputField } from '@/features/flow-editor/formState';
import type { Inputs } from '@/features/flow-editor/schemaForm';

import { msg } from '../declarative/spec';
import { Band } from '../shared/Band';
import { SpecFields } from '../shared/SpecFields';
import type { StepEditorProps } from '../types';
import { AgentFields } from './AgentFields';
import { KnowledgeChooser } from './KnowledgeChooser';
import { StructuredOutput } from './StructuredOutput';
import { tierOptions, type TierConfig } from './tiers';
import { ToolSelect } from './ToolSelect';
import { FOR_EACH, RETRY, retryIsSet } from '../declarative/specs/common';

const ITERATION = [
    {
        ...FOR_EACH,
        hint: msg(
            'mobile.flow.ai.iteration_hint',
            'Off by default: the AI runs once and sees all mapped data at once. Turn on to run the prompt once per item of an upstream list (then pick the item’s fields with Insert data, under Current item).',
        ),
    },
    RETRY,
];

function Advanced(editor: StepEditorProps) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const tiers = (useTiers('direct_chat').data ?? {}) as TierConfig;
    const current = typeof draft.modelTier === 'string' && draft.modelTier ? draft.modelTier : 'auto';
    return (
        <>
            <MultilineField
                label={t('automations.ai_step_editors.system_prompt', 'System prompt')}
                hint={t('mobile.flow.ai.system_prompt_hint', "Optional. Overrides the default 'You are a step inside a no-code automation' framing — set a tone, role, or domain.")}
                value={draft.systemPrompt}
                onChange={(v) => set('systemPrompt', v)}
                prompt={t('automations.ai_step_editors.default_a_generic_automation_step_system', '(default: a generic automation-step system prompt)')}
                lines={3}
                disabled={ctx.disabled}
            />
            <SelectField label={t('automations.model_tier', 'Model tier')} value={current} options={tierOptions(tiers, current, t)} onChange={(v) => set('modelTier', v)} disabled={ctx.disabled} />
            <FieldRow
                label={t('automations.ai_step_editors.tools', 'Tools')}
                hint={t('automations.ai_step_editors.choose_which_tools_the_ai_may', 'Choose which tools the AI may call during this step. Only tools you have permission for are listed. Leave empty for a pure text answer.')}
            >
                <ToolSelect {...editor} />
            </FieldRow>
            <ToggleField
                value={draft.useMemory === true}
                onChange={(on) => set('useMemory', on)}
                label={t('automations.ai_step_editors.use_my_personal_memory', 'Use my personal memory')}
                description={t(
                    'mobile.flow.ai.use_memory_hint',
                    "Ground this step in what you have told the assistant about yourself, your preferences and your contacts. The memories closest to this step's prompt are added before the model answers. Good for steps that write in your name or decide on your behalf.",
                )}
                disabled={ctx.disabled}
            />
            <KnowledgeChooser {...editor} />
            <SpecFields editor={editor} fields={ITERATION} />
        </>
    );
}

function advancedIsSet(editor: StepEditorProps): boolean {
    const d = editor.draft;
    const listed = (v: unknown) => Array.isArray(v) && v.length > 0;
    return !!d.systemPrompt || (!!d.modelTier && d.modelTier !== 'auto') || !!d.forEach || retryIsSet(d) || !!d.allowTools || listed(d.tools) || listed(d.knowledgeBaseIds) || d.useMemory === true;
}

export function AiStepEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const agentSet = !!draft.agentId || (Array.isArray(draft.skillIds) && draft.skillIds.length > 0);
    const inputs = (draft.inputs || {}) as Inputs;
    const outputFields = (Array.isArray(draft.outputFields) ? draft.outputFields : []) as OutputField[];
    return (
        <>
            <Band editor={editor} sectionKey="agent" title={t('automation_editor.agent_section_title', 'Who does the thinking')} defaultOpen={agentSet} hasContent={agentSet}>
                <AgentFields {...editor} />
            </Band>
            <BindingInput
                mode="template"
                multiline
                required
                value={typeof draft.prompt === 'string' ? draft.prompt : ''}
                onChange={(v) => set('prompt', String(v ?? ''))}
                label={t('automations.prompt', 'Prompt')}
                hint={t('mobile.flow.ai.prompt_hint', "What the AI should do. Tap Insert data to drop in a value from a previous step — it's filled in with the real value when the step runs.")}
                prompt={t('automations.ai_step_editors.summarise_this_email_and_decide_if', 'Summarise this email and decide if it needs an urgent reply.')}
                disabled={ctx.disabled}
                testID="ai-prompt"
            />
            <Band editor={editor} sectionKey="advanced" title={t('mobile.flow.section.advanced', 'Advanced')} hasContent={advancedIsSet(editor)}>
                <Advanced {...editor} />
            </Band>
            <Band editor={editor} sectionKey="inputs" title={t('automations.ai_step_editors.inputs', 'Inputs')} defaultOpen={Object.keys(inputs).length > 0}>
                <RowsEditor
                    value={inputs}
                    onChange={(next) => set('inputs', next)}
                    hint={t('automations.ai_step_editors.named_values_the_ai_can_read', 'Named values the AI can read alongside the prompt. Mention a name in the prompt to use it.')}
                    disabled={ctx.disabled}
                />
            </Band>
            <Band editor={editor} sectionKey="output" title={t('automations.ai_step_editors.structured_output', 'Structured output')} defaultOpen={outputFields.length > 0} hasContent={outputFields.length > 0}>
                <StructuredOutput fields={outputFields} onChange={(next) => set('outputFields', next)} disabled={ctx.disabled} />
            </Band>
        </>
    );
}
