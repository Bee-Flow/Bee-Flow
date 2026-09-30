/** Rename a meeting. The draft is the screen's, seeded when the sheet opens. */

import React from 'react';

import { FormSheet } from '@/shared/patterns';
import { TextField } from '@/shared/ui';

export function RenameMeetingSheet({
    visible,
    value,
    onChange,
    saving,
    onSave,
    onClose,
}: {
    visible: boolean;
    value: string;
    onChange: (next: string) => void;
    saving: boolean;
    onSave: (title: string) => void;
    onClose: () => void;
}) {
    const title = value.trim();
    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title="Rename meeting"
            submitLabel="Save"
            onSubmit={() => onSave(title)}
            submitting={saving}
            canSubmit={Boolean(title)}
        >
            <TextField
                label="Title"
                value={value}
                onChangeText={onChange}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => title && onSave(title)}
            />
        </FormSheet>
    );
}
