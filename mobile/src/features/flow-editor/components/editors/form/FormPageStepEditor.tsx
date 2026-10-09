/**
 * A further page of the automation's public form (form_page) — the web's
 * FormPageFields (triggerEditors.jsx): a page that asks the visitor one more
 * thing on the link they are already on, or a closing page that can sum up
 * what the automation did. Its answers are read as `steps.<id>.output.*`, and
 * its text may use values from earlier steps (the run is there to fill them
 * in). How long the automation waits for a real person is its own section, so
 * the Simple view never hides it.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { SelectField } from '@/features/flow-editor/components/fields';
import { defaultFormEndingDeclaration, defaultFormPageDeclaration, type FormDeclaration } from '@/features/flow-editor/model';
import { Button } from '@/shared/ui';

import { FormPageEditor } from './FormPageEditor';
import { say } from '../declarative/runtime';
import { msg } from '../declarative/spec';
import { Band } from '../shared/Band';
import { Note } from '../shared/Note';
import type { StepEditorProps } from '../types';

export const FORM_WAIT_CHOICES = [
    { value: 900, label: msg('mobile.flow.form_page.m15', '15 minutes') },
    { value: 3600, label: msg('mobile.flow.form_page.h1', '1 hour') },
    { value: 86400, label: msg('mobile.flow.form_page.h24', '24 hours') },
    { value: 7 * 24 * 3600, label: msg('mobile.flow.form_page.d7', '7 days') },
] as const;

export function FormPageStepEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const { step, draft, set, ctx } = editor;
    const ending = draft.mode === 'ending';
    const form = (draft.form as FormDeclaration | null) ?? null;
    const base = `steps.${String(step.id || 'this')}.output`;
    const rename = ctx.renameField;
    const title = t('automations.trigger_editors.page', 'Page');
    if (!form) {
        return (
            <Band editor={editor} sectionKey="config" title={title} defaultOpen>
                <Note>
                    {ending
                        ? t('mobile.flow.form_page.ending_intro', 'A closing page is the last thing the visitor sees. It can summarise what the automation did.')
                        : t('mobile.flow.form_page.input_intro', 'This asks the visitor one more thing, on the same link they are already on.')}
                </Note>
                <Button
                    size="sm"
                    iconName="Plus"
                    label={t('automations.trigger_editors.create_the_page', 'Create the page')}
                    onPress={() => set('form', ending ? defaultFormEndingDeclaration() : defaultFormPageDeclaration())}
                    disabled={ctx.disabled}
                    testID="form-page-create"
                />
            </Band>
        );
    }
    const wait = Number(draft.waitSeconds ?? 3600);
    const choices = FORM_WAIT_CHOICES.map((c) => ({ value: String(c.value), label: say(t, c.label) }));
    return (
        <>
            <Band editor={editor} sectionKey="config" title={title} defaultOpen>
                <FormPageEditor
                    form={form}
                    onChange={(next) => set('form', next)}
                    bindingBase={base}
                    variant={ending ? 'ending' : 'input'}
                    allowVariables
                    pickSources={ctx.catalog?.formPickSources ?? []}
                    rename={rename ? (from, to) => rename(base, from, to) : null}
                    disabled={ctx.disabled}
                />
            </Band>
            {ending ? null : (
                <Band editor={editor} sectionKey="waiting" title={t('automations.trigger_editors.waiting', 'Waiting')} defaultOpen>
                    <SelectField
                        label={t('automations.trigger_editors.wait_for_an_answer', 'Wait for an answer')}
                        hint={t('automations.trigger_editors.after_this_the_automation_gives_up', 'After this the automation gives up and the run fails.')}
                        value={String(wait)}
                        options={choices}
                        onChange={(v) => set('waitSeconds', Number(v))}
                        disabled={ctx.disabled}
                        testID="form-page-wait"
                    />
                </Band>
            )}
        </>
    );
}
