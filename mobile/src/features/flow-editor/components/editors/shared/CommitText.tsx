/**
 * A name typed whole, committed when the box is left or submitted — the web's
 * NameInput (SetOperationsEditor.jsx), the CaseNameInput pattern. A live name
 * would hand the autosave half-typed states; committing whole names keeps
 * every saved patch clean. The committed text is trimmed; '' is allowed
 * (the validator calls it incomplete, never a lost row). Leaving the editor
 * with the box still focused commits too.
 */

import React from 'react';

import { useCommitText } from '@/features/flow-editor/components/fields';
import { TextField } from '@/shared/ui';

import { Warn } from './Warn';

export function CommitText({
    value,
    onCommit,
    label,
    placeholder,
    warning = null,
    disabled = false,
    testID,
}: {
    value: string;
    onCommit: (next: string) => void;
    label?: string;
    placeholder?: string;
    warning?: string | null;
    disabled?: boolean;
    testID?: string;
}) {
    const box = useCommitText(value, (typed) => {
        const next = typed.trim();
        if (next !== value) onCommit(next);
        return { error: null };
    });
    return (
        <>
            <TextField
                label={label}
                value={box.text}
                onChangeText={box.change}
                onBlur={box.commit}
                onSubmitEditing={box.commit}
                placeholder={placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!disabled}
                testID={testID}
            />
            {warning ? <Warn>{warning}</Warn> : null}
        </>
    );
}
