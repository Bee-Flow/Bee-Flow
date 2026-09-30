/**
 * One chat tier (ChatModelsSection.jsx tier card): the deployment it uses,
 * its token budget and temperature, and — for a reasoning model — how hard it
 * reasons (Claude's adaptive thinking has no summary switch).
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { ChoiceGroup } from '@/features/org';
import { Sheet, TextField } from '@/shared/ui';

import { AzureReasoningFields } from './AzureReasoningFields';
import { isReasoningCapable, temperatureFromText, tierFields, type TierKey } from '../model/azure';
import type { AzureTier } from '../model/azureTypes';

/** A whole number from a field, or null while it is empty or not one. */
const numberOf = (text: string) => (text.trim() === '' || Number.isNaN(Number(text)) ? null : Number(text));

/**
 * The temperature. While it has focus the field shows what was typed, so "0."
 * and "0," survive on the way to 0.7; the tier gets the number, within 0–2,
 * once the text is one. Leaving the field shows the tier's value again.
 */
function TemperatureField({ value, fallback, onChange }: { value: string; fallback: number; onChange: (next: number | null) => void }) {
    const t = useTranslation();
    const [typed, setTyped] = useState<string | null>(null);
    return (
        <TextField
            testID="azure-tier-temperature"
            label={t('azure.temperature', 'Temperature')}
            hint={t('azure.temperature_help', '0 = deterministic, 1 = creative. Default: {value}', { value: fallback })}
            keyboardType="decimal-pad"
            value={typed ?? value}
            placeholder={String(fallback)}
            onChangeText={(v) => {
                setTyped(v);
                const next = temperatureFromText(v);
                if (next !== undefined) onChange(next);
            }}
            onBlur={() => setTyped(null)}
        />
    );
}

export function AzureTierSheet({
    tierKey,
    title,
    tier,
    models,
    onChange,
    onClose,
}: {
    tierKey: TierKey | null;
    title: string;
    tier: AzureTier | null;
    models: readonly string[];
    onChange: (patch: Partial<AzureTier>) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const f = tierFields(tierKey, tier);
    return (
        <Sheet visible={tierKey !== null && tier !== null} onClose={onClose} title={title} tall>
            <ChoiceGroup
                title={t('azure.select_model', 'Select Model')}
                choices={[{ value: '', label: t('azure.not_configured_option', '— Not configured —') }, ...models.map((m) => ({ value: m, label: m }))]}
                value={f.modelId}
                onChange={(v) => onChange({ modelId: v })}
            />
            <TextField
                testID="azure-tier-max-tokens"
                label={t('azure.max_tokens', 'Max Tokens')}
                hint={t('mobile.orgIntegrations.tier_default', 'Default: {value}', { value: f.defaults.maxTokens.toLocaleString() })}
                keyboardType="number-pad"
                value={f.maxTokens}
                placeholder={String(f.defaults.maxTokens)}
                onChangeText={(v) => onChange({ maxTokens: numberOf(v) })}
            />
            <TemperatureField
                key={tierKey ?? ''}
                value={f.temperature}
                fallback={f.defaults.temperature}
                onChange={(temperature) => onChange({ temperature })}
            />
            {tier && isReasoningCapable(f.modelId) ? <AzureReasoningFields tier={tier} onChange={onChange} /> : null}
        </Sheet>
    );
}
