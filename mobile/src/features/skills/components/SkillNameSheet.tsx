/**
 * Rename a skill, and change its icon — the web's rename-in-the-header. The
 * sheet only hands the two values back; the autosave carries them.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet, required, useForm } from '@/shared/patterns';

import { NameIconFields } from './NameIconFields';

export function SkillNameSheet({
    visible,
    name,
    icon,
    onClose,
    onSave,
}: {
    visible: boolean;
    name: string;
    icon: string;
    onClose: () => void;
    onSave: (next: { name: string; icon: string }) => void;
}) {
    const t = useTranslation();
    const form = useForm({
        initial: { name, icon },
        validate: { name: [required(t('mobile.skills.err_name', 'A skill needs a name.'))] },
        onSubmit: (values) => {
            onSave({ name: values.name.trim(), icon: values.icon.trim() || '⚡' });
            onClose();
        },
    });
    const nameField = form.field('name');
    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('studio.header.rename', 'Rename')}
            submitLabel={t('common.save', 'Save')}
            canSubmit={form.canSubmit}
            onSubmit={() => void form.submit()}
        >
            <NameIconFields
                name={nameField.value}
                icon={form.values.icon}
                onName={nameField.onChangeText}
                onIcon={(value) => form.set('icon', value)}
                nameError={nameField.error}
                autoFocus
            />
        </FormSheet>
    );
}
