// Compact EU model picker for a custom tier, a row of the EU section's
// override list. All bindings are threaded in as props.
import React from 'react';
import type { ModelPickerSource } from './modelPicker.types';
import type { CustomTier } from './tierTypes';
import type { CustomTiersState } from './useCustomTiers';
import { getModelDisplayName } from '@/api/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import { SettingRow } from '../ui/SettingsList';
import { useTranslation } from '@/hooks/useTranslation';

interface CustomTierEuRowProps extends ModelPickerSource {
    tier: CustomTier;
    updateCustomTier: CustomTiersState['updateCustomTier'];
}

export default function CustomTierEuRow({
    tier, chatModels, byProvider, hiddenModelIds, toggleHiddenModel, updateCustomTier,
}: CustomTierEuRowProps) {
    const { t } = useTranslation();
    const selectedModel = chatModels.find(m => m.id === tier.euModelId);
    const displayName = selectedModel ? getModelDisplayName(selectedModel) : null;
    const label = selectedModel
        ? (displayName !== selectedModel.id ? displayName : selectedModel.id)
        : t('admin_ai_config.tier_not_configured', 'Not configured');
    return (
        <SettingRow
            icon={tier.icon ? <span className="text-sm leading-none">{tier.icon}</span> : null}
            label={(
                <>
                    {tier.label}{' '}
                    <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 align-middle text-[10px] font-normal text-[var(--text-secondary)]">{t('admin_ai_config.tier_eu_custom_badge', 'custom')}</span>
                </>
            )}
            hint={tier.description || t('admin_ai_config.tier_eu_custom_tier', 'Custom tier')}
        >
            <SearchableModelSelect
                value={tier.euModelId || ''}
                label={label}
                groups={byProvider}
                onChange={({ modelId }) => updateCustomTier(tier.id, { euModelId: modelId })}
                hiddenIds={hiddenModelIds}
                onToggleHidden={toggleHiddenModel}
            />
        </SettingRow>
    );
}
