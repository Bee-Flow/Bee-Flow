/**
 * The transcription language of the org's meeting notes (the web's "Default
 * language" select, settingsPrimitives.jsx LANGS). The phone offers the
 * recorder's own list, which starts with the web's seven. A stored code the
 * list does not know is kept and shown as itself.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ChoiceGroup, type Choice } from '@/features/org';
import { TRANSCRIPTION_LANGUAGES } from '@/features/recording';

export function NotesLanguageGroup({
    value,
    footer,
    disabled,
    onChange,
}: {
    value: string | null;
    footer: string;
    disabled: boolean;
    onChange: (code: string) => void;
}) {
    const t = useTranslation();
    const current = value || 'nl';
    const choices: Choice<string>[] = TRANSCRIPTION_LANGUAGES.map((l) => ({ value: l.code, label: l.label }));
    if (!choices.some((c) => c.value === current)) choices.unshift({ value: current, label: current });
    return (
        <ChoiceGroup
            title={t('mobile.orgIntegrations.notes_language', 'Default language')}
            footer={footer}
            choices={choices}
            value={current}
            onChange={onChange}
            disabled={disabled}
        />
    );
}
