/** Rename the document (the web edits the name in its toolbar). */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet, maxLength, required, useForm } from '@/shared/patterns';
import { TextField } from '@/shared/ui';

import type { DocumentWrite } from '../hooks/useDocumentWriter';

export interface RenameSheetProps {
    visible: boolean;
    name: string;
    write: DocumentWrite;
    onClose: () => void;
}

function RenameForm({ name, write, onClose }: Omit<RenameSheetProps, 'visible'>) {
    const t = useTranslation();
    const form = useForm({
        initial: { name },
        validate: {
            name: [
                required(t('mobile.studio_documents.rename_required', 'A document needs a name.')),
                maxLength(200, t('mobile.studio_documents.rename_long', 'A name is at most 200 characters.')),
            ],
        },
        onSubmit: async ({ name: next }) => {
            await write({ name: next.trim() });
            onClose();
        },
    });
    return (
        <FormSheet
            visible
            onClose={onClose}
            title={t('mobile.studio_documents.rename', 'Rename')}
            submitLabel={t('common.save', 'Save')}
            onSubmit={() => void form.submit()}
            submitting={form.submitting}
            canSubmit={form.canSubmit && form.dirty}
            error={form.submitError}
        >
            <TextField label={t('documents.name', 'Document name')} autoFocus {...form.field('name')} />
        </FormSheet>
    );
}

/** Mounted only while open, so each opening starts from the current name. */
export function RenameSheet({ visible, ...rest }: RenameSheetProps) {
    return visible ? <RenameForm {...rest} /> : null;
}
