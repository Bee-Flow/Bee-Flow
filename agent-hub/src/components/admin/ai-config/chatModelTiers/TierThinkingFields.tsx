// Claude's thinking mode and budget, as fields of a tier's expanded settings.
// Only Sonnet 4.6 / Opus 4.6 honour budget_tokens: the adaptive-only family
// (Opus 4.7/4.8, Sonnet 5, Fable 5) rejects a manual budget and Haiku has no
// thinking at all, so the callers show this for the others only.
import { FIELD_INPUT, Field } from '@/components/shared/SettingsList';
import { useTranslation } from '@/hooks/useTranslation';

interface TierThinkingFieldsProps {
    budgetTokens: number | undefined;
    adaptiveHint: string;
    extendedHint: string;
    onAdaptive: () => void;
    onExtended: () => void;
    onBudget: (value: number | undefined) => void;
}

const MODE_BUTTON = 'flex-1 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors';
const MODE_ON = 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]';
const MODE_OFF = 'border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]';

export default function TierThinkingFields({ budgetTokens, adaptiveHint, extendedHint, onAdaptive, onExtended, onBudget }: TierThinkingFieldsProps) {
    const { t } = useTranslation();
    const extended = !!budgetTokens && budgetTokens > 0;
    return (
        <>
            <Field label={t('admin_ai_config.tier_thinking_mode', 'Thinking Mode')} hint={extended ? extendedHint : adaptiveHint}>
                <div className="flex gap-2">
                    <button type="button" onClick={onAdaptive} aria-pressed={!extended} className={`${MODE_BUTTON} ${extended ? MODE_OFF : MODE_ON}`}>
                        {t('admin_ai_config.tier_adaptive', 'Adaptive')}
                    </button>
                    <button type="button" onClick={onExtended} aria-pressed={extended} className={`${MODE_BUTTON} ${extended ? MODE_ON : MODE_OFF}`}>
                        {t('admin_ai_config.tier_extended', 'Extended (fixed budget)')}
                    </button>
                </div>
            </Field>
            {extended && (
                <Field label={t('admin_ai_config.tier_thinking_budget', 'Thinking Budget')} hint={t('admin_ai_config.tier_budget_hint', 'Tokens reserved for thinking. Must be < Max Tokens.')}>
                    <input
                        type="number"
                        value={budgetTokens || ''}
                        onChange={e => {
                            const v = parseInt(e.target.value, 10);
                            onBudget(isNaN(v) || v <= 0 ? undefined : v);
                        }}
                        min={1024} max={64000} step={1024}
                        placeholder="10000"
                        className={FIELD_INPUT}
                    />
                </Field>
            )}
        </>
    );
}
