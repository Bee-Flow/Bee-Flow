// "Reliability" on the Models page: retry once without thinking when a turn
// ends with thinking but no answer. The server applies it to Claude models
// (usecases/ai/directChat/finalizeContent.js), so the panel shows it only when
// one is configured. A switch: it saves on its own, with a SaveStatus.
import type { ReliabilitySettingsState } from './useReliabilitySettings';
import SaveStatus from '@/components/shared/SaveStatus';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import { useTranslation } from '@/hooks/useTranslation';

export default function ReliabilitySection({ reliability }: { reliability: ReliabilitySettingsState }) {
    const { t } = useTranslation();
    const label = t('ai_model_setup.reliability_retry_title', 'Retry once without thinking when the answer is empty');
    return (
        <SettingsGroup
            title={t('ai_model_setup.reliability_title', 'Reliability')}
            description={t('ai_model_setup.reliability_subtitle', 'Applies immediately.')}
            actions={<SaveStatus saveState={reliability.saveState} lastSavedAt={reliability.lastSavedAt} onRetry={() => { void reliability.setAutoRetry(reliability.autoRetry); }} size={12} />}
        >
            <SettingsList>
                <SettingRow
                    label={label}
                    hint={t('ai_model_setup.reliability_retry_hint', 'When a Claude model ends a turn with thinking but no text (the thinking used up the whole budget), it is asked once more without thinking, so it writes an answer from what it already worked out. Recommended.')}
                >
                    <div className="flex justify-end">
                        <Toggle
                            checked={reliability.autoRetry}
                            onChange={(next) => { void reliability.setAutoRetry(next); }}
                            disabled={reliability.saveState === 'saving'}
                            ariaLabel={label}
                        />
                    </div>
                </SettingRow>
            </SettingsList>
        </SettingsGroup>
    );
}
