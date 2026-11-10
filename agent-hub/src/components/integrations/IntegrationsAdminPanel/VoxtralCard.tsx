import { ExternalLink } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { SECONDARY_BTN } from '@/components/mcpLibrary/ui';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { Capabilities } from './ui';

/** Voxtral (Mistral cloud). Nothing to configure here; it reuses the Mistral API key. */
export default function VoxtralCard() {
    const { t } = useTranslation();
    return (
        <SettingsGroup
            title={t('integ.transcription_configuration', 'Configuration')}
            description={<>{t('integ.transcription_uses_mistral_s', 'Uses Mistral\'s')} <code>voxtral-mini-latest</code> {t('integ.transcription_model_fast_and_accurate_with_speaker', 'model. Fast and accurate with speaker diarization.')}</>}
        >
            <SettingsList>
                <SettingRow
                    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential
                    label={t('integ.transcription_mistral_api_key', 'Mistral API Key')}
                    hint={<>
                        {t('integ.transcription_voxtral_uses_your_existing_mistral_api', 'Voxtral uses your existing Mistral API key configured in')}{' '}
                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                        <strong>{t('integ.transcription_admin_ai_config_api_keys_mistral', 'Admin → AI Config → API Keys → Mistral')}</strong>{t('integ.transcription_no_additional_setup_needed_here', '. No additional setup needed here.')}
                    </>}
                >
                    <div className="flex md:justify-end">
                        <a href="https://console.mistral.ai" target="_blank" rel="noopener noreferrer" className={SECONDARY_BTN}>
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> {t('integ.transcription_open_mistral_console', 'Open Mistral Console')}
                        </a>
                    </div>
                </SettingRow>
                <Capabilities title={t('integ.transcription_capabilities', 'Capabilities')}>
                    <li>{t('integ.transcription_speaker_diarization_who_said_what', '✅ Speaker diarization (who said what)')}</li>
                    <li>{t('integ.transcription_word_and_segment_timestamps', '✅ Word and segment timestamps')}</li>
                    <li>{t('integ.transcription_30_languages', '✅ 30+ languages')}</li>
                    <li>{t('integ.transcription_context_terms_to_boost_accuracy', '✅ Context terms to boost accuracy')}</li>
                    <li>{t('integ.transcription_audio_sent_to_mistral_cloud_servers', 'ℹ️ Audio sent to Mistral cloud servers')}</li>
                </Capabilities>
            </SettingsList>
        </SettingsGroup>
    );
}
