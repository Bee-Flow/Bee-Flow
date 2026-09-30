/**
 * Rename a form: its heading, the title a colleague sees at the top of the
 * page (`trigger.form.title`) — not the routine's name, which is the
 * builder's. Saved into the form as it is saved, leaving any unsaved question
 * edits where they are.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { MAX_LABEL_LEN } from '@/features/forms/model/contract';
import { FormSheet } from '@/shared/patterns';
import { TextField } from '@/shared/ui';


export function RenameFormSheet({
    visible,
    title,
    locked = false,
    error = null,
    onClose,
    onRename,
}: {
    visible: boolean;
    title: string;
    /** The AI builder holds the routine: a rename could not be written. */
    locked?: boolean;
    /** Why the last save failed. */
    error?: unknown;
    onClose: () => void;
    onRename: (next: string) => Promise<boolean>;
}) {
    const t = useTranslation();
    const [text, setText] = useState(title);
    const [shownFor, setShownFor] = useState<boolean>(false);
    const [busy, setBusy] = useState(false);
    if (visible !== shownFor) {
        setShownFor(visible);
        if (visible) setText(title);
    }
    const name = text.trim();
    const submit = async () => {
        if (!name || busy || locked) return;
        setBusy(true);
        try {
            if (await onRename(name)) onClose();
        } finally {
            setBusy(false);
        }
    };
    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.forms.rename_title', 'Rename the form')}
            submitLabel={t('forms.page.save', 'Save')}
            onSubmit={() => void submit()}
            submitting={busy}
            canSubmit={!!name && name !== title && !locked}
            error={busy ? null : error}
        >
            <TextField
                label={t('forms.new.name_label', 'Name')}
                value={text}
                onChangeText={setText}
                maxLength={MAX_LABEL_LEN}
                autoFocus
                onSubmitEditing={() => void submit()}
                testID="form-rename-input"
            />
        </FormSheet>
    );
}
