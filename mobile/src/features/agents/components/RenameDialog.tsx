/**
 * Rename a conversation, in the kit's FormSheet (Alert.prompt is iOS-only).
 *
 * It was a card centred on the screen, and Android pans rather than resizes
 * a modal for the keyboard, so Save sat under it. The FormSheet docks its
 * button above the keyboard (Sheet's KeyboardAvoidingView), shows a refused
 * rename in the sheet, and stays open until the rename has landed.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet } from '@/shared/patterns';
import { TextField } from '@/shared/ui';

export interface RenameTarget {
    id: string;
    title: string;
}

export interface RenameDialogProps {
    value: RenameTarget | null;
    onChange: (next: RenameTarget | null) => void;
    onSubmit: (title: string) => void;
    submitting?: boolean;
    /** What the rename threw; FormSheet words it through describeError. */
    error?: unknown;
}

export function RenameDialog({ value, onChange, onSubmit, submitting = false, error }: RenameDialogProps) {
    const t = useTranslation();
    const trimmed = value?.title.trim() ?? '';
    const submit = () => {
        if (trimmed && !submitting) onSubmit(trimmed);
    };

    return (
        <FormSheet
            visible={Boolean(value)}
            onClose={() => onChange(null)}
            title={t('mobile.agents.rename_conversation', 'Rename conversation')}
            submitLabel={t('common.save', 'Save')}
            onSubmit={submit}
            submitting={submitting}
            canSubmit={Boolean(trimmed)}
            error={error}
        >
            <TextField
                value={value?.title ?? ''}
                onChangeText={(title) => onChange(value ? { ...value, title } : null)}
                autoFocus
                accessibilityLabel={t('mobile.agents.conversation_title', 'Conversation title')}
                returnKeyType="done"
                onSubmitEditing={submit}
            />
        </FormSheet>
    );
}
