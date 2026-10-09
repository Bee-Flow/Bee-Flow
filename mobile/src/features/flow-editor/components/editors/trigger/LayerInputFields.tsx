/**
 * A flowlet's inputs (`layer_input`): the parameters it accepts. The
 * description is what the person wiring the flowlet up reads beside each
 * input (triggerEditors.jsx).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FieldRow } from '@/features/flow-editor/components/fields';

import { msg } from '../declarative/spec';
import { ParamsDesigner } from '../params/ParamsDesigner';
import { CONTRACT_TYPES, type ParamRow } from '../params/paramsModel';
import type { StepEditorProps } from '../types';
import { carryOf } from './paramCarry';

export function LayerInputFields(editor: StepEditorProps) {
    const t = useTranslation();
    return (
        <FieldRow
            label={t('automations.trigger_editors.flowlet_inputs', 'Flowlet inputs')}
            hint={t('mobile.flow.trigger.flowlet_inputs_hint', 'Parameters this flowlet accepts. Inside the flowlet, pick them with Insert data, as Trigger ▸ <name>.')}
        >
            <ParamsDesigner
                rows={editor.draft.params}
                onChange={(next: ParamRow[]) => editor.set('params', next)}
                types={CONTRACT_TYPES}
                addLabel={t('mobile.flow.params.add_input', 'Add input')}
                removeLabel={t('mobile.flow.params.remove_input', 'Remove input')}
                emptyNote={t('mobile.flow.trigger.flowlet_inputs_empty', 'No inputs yet — the flowlet will receive an empty payload.')}
                namePrefix="input"
                descriptionPlaceholder={t('mobile.flow.trigger.flowlet_input_description', 'description (shown where this flowlet is called)')}
                carry={carryOf(editor)}
                takenError={msg('mobile.flow.trigger.flowlet_input_taken', 'Another input on this flowlet already binds that name.')}
                disabled={editor.ctx.disabled}
            />
        </FieldRow>
    );
}
