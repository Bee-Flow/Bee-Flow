/**
 * A reasoning model's effort, and for the non-Claude ones the summary switch
 * (ChatModelsSection.jsx): Claude's adaptive thinking has no summary, and its
 * effort defaults to medium where the others default to none.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Segmented, Text, ToggleRow } from '@/shared/ui';

import { isClaudeReasoning, REASONING_EFFORTS } from '../model/azure';
import type { AzureTier } from '../model/azureTypes';

type Effort = (typeof REASONING_EFFORTS)[number];

function effortLabel(effort: Effort, t: TranslateFn): string {
    if (effort === 'none') return t('azure.reasoning_none', 'None (fastest)');
    if (effort === 'low') return t('azure.reasoning_low', 'Low');
    if (effort === 'medium') return t('azure.reasoning_medium', 'Medium');
    if (effort === 'high') return t('azure.reasoning_high', 'High');
    return t('azure.reasoning_xhigh', 'xHigh (deepest)');
}

export function AzureReasoningFields({ tier, onChange }: { tier: AzureTier; onChange: (patch: Partial<AzureTier>) => void }) {
    const t = useTranslation();
    const claude = isClaudeReasoning(tier.modelId);
    const effort = (REASONING_EFFORTS as readonly string[]).includes(tier.reasoningEffort ?? '')
        ? (tier.reasoningEffort as Effort)
        : claude
          ? 'medium'
          : 'none';
    return (
        <>
            <Text variant="label" tone="secondary">
                {claude ? t('azure.thinking_budget', 'Thinking Effort') : t('azure.reasoning_effort', 'Reasoning Effort')}
            </Text>
            <Segmented
                options={REASONING_EFFORTS.map((e) => ({ value: e, label: effortLabel(e, t) }))}
                value={effort}
                onChange={(v) => onChange({ reasoningEffort: v })}
            />
            {claude ? null : (
                <ToggleRow
                    gutter={false}
                    label={t('azure.reasoning_summary', 'Reasoning Summary')}
                    description={t('mobile.orgIntegrations.reasoning_summary_help', "Show the model's thinking process. Requires Azure API version 2025+.")}
                    value={tier.reasoningSummary}
                    onValueChange={(v) => onChange({ reasoningSummary: v })}
                />
            )}
        </>
    );
}
