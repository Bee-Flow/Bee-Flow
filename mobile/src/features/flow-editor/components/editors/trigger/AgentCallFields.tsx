/**
 * An agent tool trigger (`agent_call`): a tool name, what the agent reads to
 * decide when to call it, and its arguments (triggerEditors.jsx).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FieldRow, MultilineField } from '@/features/flow-editor/components/fields';
import { TextField } from '@/shared/ui';

import { msg } from '../declarative/spec';
import { ParamsDesigner } from '../params/ParamsDesigner';
import { CONTRACT_TYPES, type ParamRow } from '../params/paramsModel';
import type { StepEditorProps } from '../types';
import { carryOf } from './paramCarry';

/** An example tool name: an identifier, not copy. */
const TOOL_NAME_EXAMPLE = 'summarise_inbox';

export function AgentCallFields(editor: StepEditorProps) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    return (
        <>
            <TextField
                label={t('automations.trigger_editors.tool_name', 'Tool name')}
                hint={t('automations.trigger_editors.what_the_agent_calls_lowercased_sanitized', 'What the agent calls. Lowercased & sanitized; blank → automation_<id>.')}
                value={typeof draft.toolName === 'string' ? draft.toolName : ''}
                onChangeText={(v) => set('toolName', v)}
                placeholder={TOOL_NAME_EXAMPLE}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!ctx.disabled}
            />
            <MultilineField
                label={t('common.description', 'Description')}
                hint={t('automations.trigger_editors.the_agent_reads_this_to_decide', 'The agent reads this to decide when to call the automation.')}
                value={draft.description}
                onChange={(v) => set('description', v)}
                prompt={t('mobile.flow.trigger.tool_description_example', "Summarise the user's unread email and return the highlights.")}
                lines={2}
                disabled={ctx.disabled}
            />
            <FieldRow
                label={t('automations.trigger_editors.input_parameters', 'Input parameters')}
                hint={t('mobile.flow.trigger.input_parameters_hint', 'Arguments the agent passes. Later steps pick them with Insert data, as Trigger ▸ <name>.')}
            >
                <ParamsDesigner
                    rows={draft.params}
                    onChange={(next: ParamRow[]) => set('params', next)}
                    types={CONTRACT_TYPES}
                    addLabel={t('mobile.flow.params.add_parameter', 'Add parameter')}
                    removeLabel={t('mobile.flow.params.remove_parameter', 'Remove parameter')}
                    emptyNote={t('mobile.flow.trigger.parameters_empty', 'No inputs — the agent calls it with no arguments.')}
                    namePrefix="arg"
                    defaults={{ description: '' }}
                    descriptionPlaceholder={t('mobile.flow.trigger.parameter_description', 'description (helps the agent fill this in)')}
                    carry={carryOf(editor)}
                    takenError={msg('mobile.flow.trigger.parameter_taken', 'Another parameter of this tool already binds that name.')}
                    disabled={ctx.disabled}
                />
            </FieldRow>
        </>
    );
}
