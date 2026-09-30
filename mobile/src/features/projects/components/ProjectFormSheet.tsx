/**
 * Create a Solution, or edit one's details — the web's General tab
 * (ProjectDetailPage.jsx) as a sheet: name, description, the instructions
 * every chat in the project gets, and its look.
 *
 * The form seeds itself once, on mount; callers give it a `key` that changes
 * each time it opens, so a parent re-render never throws away what is being
 * typed. An edit carries the version it was opened on (see useUpdateProject):
 * a colleague's save in between comes back as a 409 in the server's words.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet, maxLength, required, useForm } from '@/shared/patterns';
import { TextField } from '@/shared/ui';

import { LookPicker } from './LookPicker';
import { DESCRIPTION_MAX, EMPTY_DRAFT, INSTRUCTIONS_MAX, NAME_MAX, type ProjectDraft } from '../model/form';

export function ProjectFormSheet({
    visible,
    initial,
    onClose,
    onSubmit,
}: {
    visible: boolean;
    /** Undefined creates; a draft edits. */
    initial?: ProjectDraft;
    onClose: () => void;
    /** The work; a throw is shown in the sheet. */
    onSubmit: (draft: ProjectDraft) => Promise<unknown>;
}) {
    const t = useTranslation();
    const form = useForm<ProjectDraft>({
        initial: initial ?? EMPTY_DRAFT,
        validate: {
            name: [
                required(t('mobile.projects.name_required', 'Give it a name.')),
                maxLength(NAME_MAX, t('mobile.projects.name_too_long', 'At most {max} characters.', { max: NAME_MAX })),
            ],
            description: [
                maxLength(DESCRIPTION_MAX, t('mobile.projects.too_long', 'At most {max} characters.', { max: DESCRIPTION_MAX })),
            ],
            customInstructions: [
                maxLength(INSTRUCTIONS_MAX, t('mobile.projects.too_long', 'At most {max} characters.', { max: INSTRUCTIONS_MAX })),
            ],
        },
        onSubmit,
    });

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={initial ? t('mobile.projects.edit_title', 'Edit details') : t('solutions.new', 'New Solution')}
            subtitle={initial ? undefined : t('solutions.intro', 'A Solution bundles routines, apps and webpages that work together — and packages as a Blueprint you can install elsewhere.')}
            submitLabel={initial ? t('common.save', 'Save') : t('common.create', 'Create')}
            onSubmit={() => void form.submit()}
            canSubmit={form.canSubmit && (initial ? form.dirty : true)}
            submitting={form.submitting}
            error={form.submitError}
        >
            <TextField
                label={t('common.name', 'Name')}
                placeholder={t('solutions.name_placeholder', 'Name the Solution…')}
                {...form.field('name')}
                autoFocus={!initial}
                maxLength={NAME_MAX + 20}
            />
            <TextField label={t('common.description', 'Description')} {...form.field('description')} multiline maxLines={4} />
            <TextField
                label={t('mobile.projects.field_instructions', 'Instructions')}
                hint={t('mobile.projects.field_instructions_hint', 'Every chat in this project gets these, on top of its own.')}
                {...form.field('customInstructions')}
                multiline
                maxLines={8}
            />
            <LookPicker
                icon={form.values.icon}
                color={form.values.color}
                onIcon={(next) => form.set('icon', next)}
                onColor={(next) => form.set('color', next)}
            />
        </FormSheet>
    );
}
