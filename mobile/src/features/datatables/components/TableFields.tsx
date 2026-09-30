/**
 * The two facts every table has — its name and its purpose — with the rules
 * the server judges them by (routes/datatables/schemas.js tableName and
 * tablePurpose), shared by the create sheet and the details sheet.
 */

import React from 'react';

import type { TranslateFn } from '@/core/i18n';
import { useTranslation } from '@/core/i18n';
import { maxLength, required, type FieldBinding, type Validator } from '@/shared/patterns';
import { TextField } from '@/shared/ui';

import { MAX_NAME_LEN } from '../model/columns';

export function nameRules(t: TranslateFn): Validator<unknown>[] {
    return [
        required(t('mobile.datatables.name_required', 'Give the table a name')),
        maxLength(MAX_NAME_LEN, t('mobile.datatables.name_too_long', 'A name may be at most 120 characters')),
    ];
}

/** Never blank: the generated processing register would record nothing. */
export function purposeRules(t: TranslateFn): Validator<unknown>[] {
    return [required(t('mobile.datatables.purpose_required', 'Say what this table is for — it goes in your processing record'))];
}

export function NameField({ binding, hint, testID }: { binding: FieldBinding<string>; hint?: string; testID?: string }) {
    const t = useTranslation();
    return (
        <TextField
            label={t('datatables.field_name', 'Name')}
            value={binding.value}
            onChangeText={binding.onChangeText}
            error={binding.error}
            hint={hint}
            testID={testID}
        />
    );
}

export function PurposeField({ binding, testID }: { binding: FieldBinding<string>; testID?: string }) {
    const t = useTranslation();
    return (
        <TextField
            label={t('datatables.field_purpose', 'What is it for?')}
            value={binding.value}
            onChangeText={binding.onChangeText}
            error={binding.error}
            hint={t('datatables.field_purpose_help', 'Required — this sentence goes into your organisation’s processing record.')}
            multiline
            testID={testID}
        />
    );
}
