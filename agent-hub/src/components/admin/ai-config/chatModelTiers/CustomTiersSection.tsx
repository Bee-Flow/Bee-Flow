// The custom tiers of the Models page: extra tiers next to the standard ones,
// and (once there is one) the EU-hosted model of each. Edits go into the page's
// draft; the save bar stores them.
import type { ModelPickerSource } from './modelPicker.types';
import type { CustomTier } from './tierTypes';
import type { CustomTiersState } from './useCustomTiers';
import CustomTierCard from './CustomTierCard';
import CustomTierEuRow from './CustomTierEuRow';
import { QUIET_BUTTON, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { useTranslation } from '@/hooks/useTranslation';

interface CustomTiersSectionProps extends ModelPickerSource {
    customTiers: CustomTier[];
    addCustomTier: CustomTiersState['addCustomTier'];
    expandedCustomId: CustomTiersState['expandedCustomId'];
    setExpandedCustomId: CustomTiersState['setExpandedCustomId'];
    reasoningCapable: (id: string) => boolean;
    updateCustomTier: CustomTiersState['updateCustomTier'];
    renameCustomTier: CustomTiersState['renameCustomTier'];
    removeCustomTier: CustomTiersState['removeCustomTier'];
    toggleCustomTaskType: CustomTiersState['toggleCustomTaskType'];
}

export default function CustomTiersSection({
    customTiers, addCustomTier, expandedCustomId, setExpandedCustomId,
    chatModels, byProvider, hiddenModelIds, toggleHiddenModel, reasoningCapable,
    updateCustomTier, renameCustomTier, removeCustomTier, toggleCustomTaskType,
}: CustomTiersSectionProps) {
    const { t } = useTranslation();
    return (
        <>
            <SettingsGroup
                title={t('admin_ai_config.tier_custom_title', 'Custom Tiers')}
                description={t('ai_model_setup.custom_tiers_hint', 'Extra tiers next to the standard ones. Limit each one to task types here; which groups may use it is set on the group, under People > Groups.')}
                actions={<button type="button" onClick={addCustomTier} className={QUIET_BUTTON}>{t('admin_ai_config.tier_custom_add', '+ Add Custom Tier')}</button>}
            >
                {customTiers.length === 0 ? (
                    <p className="m-0 rounded-lg border border-dashed border-[var(--border-default)] px-4 py-3 text-center text-xs text-[var(--text-tertiary)]">
                        {t('admin_ai_config.tier_custom_none', 'No custom tiers yet.')}
                    </p>
                ) : (
                    <SettingsList>
                        {customTiers.map((tier, position) => (
                            <CustomTierCard
                                // Keyed by position: the id follows the name, and a key that changed on
                                // every keystroke remounted the card and took the focus out of the name field.
                                key={position}
                                tier={tier}
                                expandedCustomId={expandedCustomId}
                                setExpandedCustomId={setExpandedCustomId}
                                chatModels={chatModels}
                                byProvider={byProvider}
                                hiddenModelIds={hiddenModelIds}
                                toggleHiddenModel={toggleHiddenModel}
                                reasoningCapable={reasoningCapable}
                                updateCustomTier={updateCustomTier}
                                renameCustomTier={renameCustomTier}
                                removeCustomTier={removeCustomTier}
                                toggleCustomTaskType={toggleCustomTaskType}
                            />
                        ))}
                    </SettingsList>
                )}
            </SettingsGroup>

            {customTiers.length > 0 && (
                <SettingsGroup
                    title={t('admin_ai_config.tier_eu_custom_title', 'Custom Tiers: EU override')}
                    description={t('admin_ai_config.tier_eu_custom_hint', 'Pick an EU-hosted model for each custom tier. Used automatically when an organization has EU mode enabled.')}
                >
                    <SettingsList>
                        {customTiers.map(tier => (
                            <CustomTierEuRow
                                key={tier.id}
                                tier={tier}
                                chatModels={chatModels}
                                byProvider={byProvider}
                                hiddenModelIds={hiddenModelIds}
                                toggleHiddenModel={toggleHiddenModel}
                                updateCustomTier={updateCustomTier}
                            />
                        ))}
                    </SettingsList>
                </SettingsGroup>
            )}
        </>
    );
}
