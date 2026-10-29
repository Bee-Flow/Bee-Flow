/** Delete a template. Documents already filled in from it are unaffected. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ConfirmSheet, useToast } from '@/shared/ui';

import { useDeleteTemplate } from '../hooks/mutations';
import type { Template } from '../model/types';

export function DeleteTemplateSheet({
    template,
    onCancel,
    onDeleted,
}: {
    template: Template | null;
    onCancel: () => void;
    /** Also closes the detail sheet the delete was started from. */
    onDeleted: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const remove = useDeleteTemplate({
        onSuccess: () => {
            toast(t('mobile.templates.deleted', 'Template deleted'), 'success');
            onDeleted();
        },
    });

    return (
        <ConfirmSheet
            visible={Boolean(template)}
            title={t('mobile.templates.delete_title', 'Delete “{name}”?', { name: template?.name ?? '' })}
            message={t(
                'mobile.templates.delete_message',
                'The template file is removed from your server. Documents you already filled in from it are unaffected.',
            )}
            confirmLabel={t('mobile.templates.delete_confirm', 'Delete template')}
            busy={remove.isPending}
            onCancel={onCancel}
            onConfirm={() => template && remove.mutate(template.id)}
        />
    );
}
