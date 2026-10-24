import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';

export type TierKey = 'fast' | 'thinking' | 'writer' | 'pro';

export interface Tier {
    key: TierKey;
    icon: string;
    label: string;
    desc: string;
}

const TIERS: Tier[] = [
    { key: 'fast', icon: '⚡', label: 'Fast', desc: 'Quick responses' },
    { key: 'thinking', icon: '🧠', label: 'Thinking', desc: 'Complex reasoning' },
    { key: 'writer', icon: '✍️', label: 'Writer', desc: 'Long-form content' },
    { key: 'pro', icon: '✨', label: 'Deep Thinking', desc: 'Maximum quality' },
];

export { TIERS };

interface TierRowProps {
    tier: Tier;
    value: string;
    onChange: (value: string) => void;
    modelOptions: string[];
    inputStyle: React.CSSProperties;
}

const TierRow = ({ tier, value, onChange, modelOptions, inputStyle }: TierRowProps) => {
    const { t } = useTranslation();
    return (
    <div className="flex items-center gap-3 p-3 rounded-xl border bg-[var(--bg-primary)] border-[var(--border-default)]">
        <span className="text-lg">{tier.icon}</span>
        <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)]">{tier.label}</div>
            {tier.desc && <div className="text-xs text-[var(--text-muted)]">{tier.desc}</div>}
        </div>
        {modelOptions.length > 0 ? (
            <select value={value} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
                className="px-3 py-2 rounded-lg border text-sm outline-none" style={inputStyle}>
                <option value="">{t('init_setup.step_tiers_select', '— Select —')}</option>
                {modelOptions.map((m: string) => <option key={m} value={m}>{m}</option>)}
            </select>
        ) : (
            <input type="text" value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
                placeholder={t('init_setup.step_tiers_model_id', 'Model ID')} className="w-40 px-3 py-2 rounded-lg border text-sm outline-none" style={inputStyle} />
        )}
    </div>
);
};

export type TierConfig = Record<TierKey, { modelId: string; label: string }>;

interface StepTiersProps {
    tierConfig: TierConfig;
    updateTier: (key: TierKey, value: string) => void;
    euTierConfig: TierConfig;
    updateEuTier: (key: TierKey, value: string) => void;
    isAzure: boolean;
    modelOptions: string[];
    inputStyle: React.CSSProperties;
}

const StepTiers = ({ tierConfig, updateTier, euTierConfig, updateEuTier, isAzure, modelOptions, inputStyle }: StepTiersProps) => {
    const { t } = useTranslation();
    return (
    <>
        <div className="space-y-3">
            <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">💬</span>
                <span className="text-sm font-semibold text-[var(--text-primary)]">{t('init_setup.step_tiers_chat_model_tiers', 'Chat Model Tiers')}</span>
            </div>
            {TIERS.map((t: Tier) => (
                <TierRow key={t.key} tier={t} value={tierConfig[t.key]?.modelId || ''}
                    onChange={(v: string) => updateTier(t.key, v)} modelOptions={modelOptions} inputStyle={inputStyle} />
            ))}
        </div>

        {!isAzure && (
            <div className="space-y-3 pt-4 border-t border-[var(--border-subtle)]">
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">🇪🇺</span>
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{t('init_setup.step_tiers_eu_chat_model_tiers', 'EU Chat Model Tiers')}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full [background:rgba(0,51,153,0.1)] [color:#003399]!">{t('init_setup.step_tiers_optional', 'Optional')}</span>
                </div>
                <p className="text-xs text-[var(--text-muted)]">
                    {t('init_setup.step_tiers_eu_hosted_models_for_organizations', 'EU-hosted models for organizations with EU privacy mode enabled.')}
                </p>
                {TIERS.map((t: Tier) => (
                    <TierRow key={`eu-${t.key}`} tier={{ ...t, desc: '' }} value={euTierConfig[t.key]?.modelId || ''}
                        onChange={(v: string) => updateEuTier(t.key, v)} modelOptions={[]} inputStyle={inputStyle} />
                ))}
            </div>
        )}

        {isAzure && (
            <p className="text-xs pt-2 text-[var(--text-muted)]">
                {t('init_setup.step_tiers_eu_tiers_are_hidden_azure_endpoints', '💡 EU tiers are hidden — Azure endpoints are region-specific. Configure regions in your Azure portal.')}
            </p>
        )}
    </>
);
};

export default StepTiers;
