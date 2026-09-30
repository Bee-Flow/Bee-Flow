/**
 * A new group: its name and an optional description (the web's create form).
 * The server files it under the caller's own organisation whatever is sent;
 * `organizationId` is sent anyway, as the web does, for a super admin.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet, maxLength, required, useForm } from '@/shared/patterns';
import { TextField } from '@/shared/ui';

import { useCreateGroup } from '../hooks/groupMutations';

export function CreateGroupSheet({
    visible,
    onClose,
    orgId,
}: {
    visible: boolean;
    onClose: () => void;
    orgId: string | null;
}) {
    const t = useTranslation();
    const create = useCreateGroup();
    const form = useForm({
        initial: { name: '', description: '' },
        validate: {
            name: [
                required(t('mobile.orgPeople.group_name_required', 'Give the group a name.')),
                maxLength(200, t('mobile.orgPeople.group_name_long', 'A group name is at most 200 characters.')),
            ],
            description: [maxLength(2000, t('mobile.orgPeople.description_long', 'That description is too long.'))],
        },
        onSubmit: async (values) => {
            await create.mutateAsync({
                name: values.name.trim(),
                description: values.description.trim(),
                organizationId: orgId,
            });
            form.reset();
            onClose();
        },
    });
    const close = () => {
        form.reset();
        onClose();
    };
    return (
        <FormSheet
            visible={visible}
            onClose={close}
            title={t('admin.org_new_group', 'Create New Group')}
            submitLabel={t('admin.org_create', 'Create')}
            onSubmit={() => void form.submit()}
            submitting={form.submitting}
            canSubmit={form.canSubmit}
            error={form.submitError}
        >
            <TextField testID="group-name" label={t('mobile.orgPeople.group_name', 'Name')} {...form.field('name')} />
            <TextField
                testID="group-description"
                label={t('mobile.orgPeople.description', 'Description')}
                multiline
                {...form.field('description')}
            />
        </FormSheet>
    );
}
