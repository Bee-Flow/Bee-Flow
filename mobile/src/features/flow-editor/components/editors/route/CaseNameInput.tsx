/**
 * An output's name, committed when the box loses focus or on submit — never
 * per keystroke (the web's CaseNameInput). A select-all-and-retype passes
 * through '' on the way, and a save of that state reads as "output removed":
 * the output's canvas connection would be dropped mid-typing. So only a
 * valid final name is ever written; an empty one reverts, a sibling's is
 * refused. Leaving the editor with the box still focused commits too.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useCommitText } from '@/features/flow-editor/components/fields';
import { TextField } from '@/shared/ui';

import { checkCaseName } from './routeEdits';

export function CaseNameInput({
    name,
    siblingNames,
    onCommit,
    disabled = false,
    testID,
}: {
    name: string;
    siblingNames: readonly string[];
    onCommit: (name: string) => void;
    disabled?: boolean;
    testID?: string;
}) {
    const t = useTranslation();
    const box = useCommitText(name, (typed) => {
        const out = checkCaseName(typed, name, siblingNames);
        if (!('error' in out)) {
            if (out.name !== name) onCommit(out.name);
            return { error: null };
        }
        return out.error === 'required'
            ? { error: t('mobile.flow.route.name_required', 'Name required — reverted.'), revert: true }
            : { error: t('mobile.flow.route.name_taken', 'A case named “{name}” already exists.', { name: out.name }) };
    });
    return (
        <TextField
            label={t('common.name', 'Name')}
            value={box.text}
            onChangeText={box.change}
            onBlur={box.commit}
            onSubmitEditing={box.commit}
            placeholder={t('automations.route_editors.name_this_output_for_example_invoices', 'Name this output — for example invoices')}
            error={box.error}
            editable={!disabled}
            testID={testID}
        />
    );
}
