/**
 * A form trigger — the web's FormTriggerFields: page one of the automation's
 * public form, edited with the same page editor as every later page
 * (form/FormPageEditor). A trigger that has just been switched to `form` has
 * no page yet; it is seeded on a tap, not by opening the editor, so nothing
 * is written until the author asks for it.
 *
 * Where the form is shared, opened and closed, and read back is Forms: the
 * server publishes the link whenever a form trigger is saved, and once it
 * has, "Open in Forms" goes there.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useFormLinks } from '@/features/flow-editor/hooks';
import { defaultFormDeclaration, type FormDeclaration } from '@/features/flow-editor/model';
import { Button } from '@/shared/ui';

import { FormPageEditor } from '../form/FormPageEditor';
import { Note } from '../shared/Note';
import type { StepEditorProps } from '../types';

const BASE = 'trigger.output';

function OpenInForms({ flowKey, stepId, primary }: { flowKey: string; stepId: string; primary: boolean }) {
    const t = useTranslation();
    const router = useRouter();
    const links = useFormLinks(flowKey).list.data ?? [];
    const link = links.find((l) => l.triggerStepId === stepId || (primary && !l.triggerStepId));
    if (!link) return null;
    return (
        <Button
            size="sm"
            variant="secondary"
            iconName="ExternalLink"
            label={t('mobile.flow.trigger.open_in_forms', 'Open in Forms')}
            onPress={() => router.push({ pathname: '/forms/[automationId]', params: { automationId: link.automationId } })}
            testID="form-open-in-forms"
        />
    );
}

export function FormTriggerFields({ step, draft, set, ctx }: StepEditorProps) {
    const t = useTranslation();
    const form = (draft.form as FormDeclaration | null) ?? null;
    const rename = ctx.renameField;
    if (!form) {
        return (
            <>
                <Note>
                    {t(
                        'automations.form_trigger_fields.a_form_trigger_publishes_a_page',
                        'A form trigger publishes a page for the colleagues it is shared with — who that is, you set under Studio → Forms → Share. Every submission runs this automation once.',
                    )}
                </Note>
                <Button
                    size="sm"
                    iconName="Plus"
                    label={t('automations.form_trigger_fields.create_the_form', 'Create the form')}
                    onPress={() => set('form', defaultFormDeclaration())}
                    disabled={ctx.disabled}
                    testID="form-create"
                />
            </>
        );
    }
    return (
        <>
            <OpenInForms flowKey={ctx.flowKey} stepId={String(step.id)} primary={ctx.definition.trigger?.id === step.id} />
            <FormPageEditor
                form={form}
                onChange={(next) => set('form', next)}
                bindingBase={BASE}
                variant="input"
                pickSources={ctx.catalog?.formPickSources ?? []}
                rename={rename ? (from, to) => rename(BASE, from, to) : null}
                disabled={ctx.disabled}
            />
        </>
    );
}
