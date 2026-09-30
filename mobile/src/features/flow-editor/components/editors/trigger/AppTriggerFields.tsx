/**
 * A Studio App trigger (`app_trigger`): typed inputs, a file among them,
 * whose names are identifiers — a stray space is dropped as it is typed
 * (triggerEditors.jsx).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FieldRow } from '@/features/flow-editor/components/fields';

import { msg } from '../declarative/spec';
import { ParamsDesigner } from '../params/ParamsDesigner';
import { APP_TRIGGER_TYPES, type ParamRow } from '../params/paramsModel';
import type { StepEditorProps } from '../types';
import { carryOf } from './paramCarry';

const identifierOnly = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '');

export function AppTriggerFields(editor: StepEditorProps) {
    const t = useTranslation();
    return (
        <FieldRow
            label={t('mobile.flow.trigger.app_inputs', 'App inputs')}
            hint={t(
                'mobile.flow.trigger.app_inputs_hint',
                'Inputs the app action must provide. Later steps pick them with Insert data, as Trigger ▸ <name>; a file input arrives as { fileId, name, mime, size, url }.',
            )}
        >
            <ParamsDesigner
                rows={editor.draft.params}
                onChange={(next: ParamRow[]) => editor.set('params', next)}
                types={APP_TRIGGER_TYPES}
                addLabel={t('mobile.flow.params.add_input', 'Add input')}
                removeLabel={t('mobile.flow.params.remove_input', 'Remove input')}
                emptyNote={t('mobile.flow.trigger.app_inputs_empty', 'No inputs yet — the app calls it with an empty payload.')}
                namePrefix="input"
                defaults={{ description: '' }}
                descriptionPlaceholder={t('mobile.flow.trigger.app_input_description', 'description (shown to the app builder)')}
                sanitizeName={identifierOnly}
                carry={carryOf(editor)}
                takenError={msg('mobile.flow.trigger.app_input_taken', 'Another input on this trigger already binds that name.')}
                disabled={editor.ctx.disabled}
            />
        </FieldRow>
    );
}
