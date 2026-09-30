/**
 * The trigger's editor — the web's TriggerFields (triggerEditors.jsx): what
 * starts the routine, then that kind's own settings. A flowlet's trigger
 * (`layer_input`) declares its inputs instead and has no kind to switch; an
 * ADDITIONAL trigger may only be a webhook, an app event or a schedule.
 */

import React, { type ReactElement } from 'react';

import { useTranslation } from '@/core/i18n';
import { SelectField } from '@/features/flow-editor/components/fields';

import { AgentCallFields } from './AgentCallFields';
import { say } from '../declarative/runtime';
import { Band } from '../shared/Band';
import type { StepEditorProps } from '../types';
import { AppEventFields } from './AppEventFields';
import { AppTriggerFields } from './AppTriggerFields';
import { FormTriggerFields } from './FormTriggerFields';
import { chooseKind, hasKindForm, isSecondaryTrigger, kindOptions, kindTitle } from './kinds';
import { LayerInputFields } from './LayerInputFields';
import { ScheduleFields } from './ScheduleFields';
import { WebhookPanel } from './WebhookPanel';

const KIND_BODIES: Record<string, (editor: StepEditorProps) => ReactElement> = {
    agent_call: AgentCallFields,
    schedule: ScheduleFields,
    app_event: AppEventFields,
    app_trigger: AppTriggerFields,
    webhook: WebhookPanel,
    form: FormTriggerFields,
};

export function TriggerEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const { draft, step, ctx } = editor;
    const kind = typeof draft.kind === 'string' && draft.kind ? draft.kind : 'manual';
    if (kind === 'layer_input') {
        return (
            <Band editor={editor} sectionKey="inputs" title={t('mobile.flow.section.inputs', 'Inputs')} defaultOpen>
                <LayerInputFields {...editor} />
            </Band>
        );
    }
    const secondary = isSecondaryTrigger(ctx.definition, step.id);
    const Body = hasKindForm(kind) ? KIND_BODIES[kind] : undefined;
    return (
        <>
            <SelectField
                label={t('mobile.flow.trigger.kind', 'Trigger kind')}
                hint={
                    secondary
                        ? t(
                              'mobile.flow.trigger.secondary_hint',
                              'Additional triggers can be webhooks, app events or schedules — manual, form, agent and app triggers can only be the primary trigger.',
                          )
                        : null
                }
                value={kind}
                options={kindOptions(secondary, kind).map((o) => ({ value: o.value, label: say(t, o.label), disabled: o.disabled }))}
                onChange={(next) => editor.setMany(chooseKind(draft, next))}
                disabled={ctx.disabled}
                testID="trigger-kind"
            />
            {Body ? (
                <Band editor={editor} sectionKey="config" title={say(t, kindTitle(kind))} defaultOpen>
                    <Body {...editor} />
                </Band>
            ) : null}
        </>
    );
}
