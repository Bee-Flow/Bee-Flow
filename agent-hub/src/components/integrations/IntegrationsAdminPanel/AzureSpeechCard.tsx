import type React from 'react';
import { saveTranscriptionConfig } from '@/api/transcriptionConfigApi';
import { useTranslation } from '@/hooks/useTranslation';
import { CHIP } from '@/components/mcpLibrary/ui';
import { FIELD_INPUT, Field, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import type { TranscriptionSectionProps } from './adminPanel.types';
import { Capabilities, HINT_LINK, Hint, SaveButton } from './ui';

/** Azure AI Speech (region and key); also what Azure Whisper uses. */
export default function AzureSpeechCard({ hasAzureSpeechKey, setHasAzureSpeechKey, azureSpeechKey, setAzureSpeechKey, azureSpeechRegion, setAzureSpeechRegion, savingAzureSpeech, setSavingAzureSpeech, setMessage }: Pick<TranscriptionSectionProps, 'hasAzureSpeechKey' | 'setHasAzureSpeechKey' | 'azureSpeechKey' | 'setAzureSpeechKey' | 'azureSpeechRegion' | 'setAzureSpeechRegion' | 'savingAzureSpeech' | 'setSavingAzureSpeech' | 'setMessage'>) {
    const { t } = useTranslation();
    const save = async () => {
        if (!azureSpeechRegion.trim() && !azureSpeechKey.trim()) return;
        setSavingAzureSpeech(true);
        try {
            const body: Record<string, string> = {};
            if (azureSpeechRegion.trim()) body.azureSpeechRegion = azureSpeechRegion.trim();
            if (azureSpeechKey.trim()) body.azureSpeechKey = azureSpeechKey.trim();
            const res = await saveTranscriptionConfig(body);
            if (res.ok) {
                if (azureSpeechKey.trim()) setHasAzureSpeechKey(true);
                setAzureSpeechKey('');
                setMessage({ type: 'success', text: 'Azure Speech credentials saved securely' });
            } else {
                const err = await res.json().catch(() => ({}));
                setMessage({ type: 'error', text: err.error || 'Failed to save credentials' });
            }
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to save credentials' });
        }
        setSavingAzureSpeech(false);
        setTimeout(() => setMessage(null), 3000);
    };
    return (
        <SettingsGroup
            title={t('integ.transcription_credentials', 'Credentials')}
            description={t('integ.transcription_azure_cognitive_services_speech_with', 'Azure Cognitive Services Speech with optional Whisper model. Enterprise SLAs, GDPR-compliant regions available.')}
            actions={hasAzureSpeechKey ? <span className={CHIP}>{t('integ.transcription_key_saved', 'Key saved 🔒')}</span> : undefined}
        >
            <SettingsList>
                <div className="flex flex-col gap-3 px-4 py-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field htmlFor="azure-speech-region" label={<>{t('integ.transcription_region_e_g', 'Region (e.g.')} <code>westeurope</code>, <code>eastus</code>)</>}>
                            <input
                                id="azure-speech-region"
                                type="text"
                                value={azureSpeechRegion}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAzureSpeechRegion(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                                placeholder={t('integ.transcription_westeurope', 'westeurope')}
                                className={FIELD_INPUT}
                            />
                        </Field>
                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                        <Field htmlFor="azure-speech-key" label={t('integ.transcription_api_key_key_1', 'API Key (Key 1)')}>
                            <input
                                id="azure-speech-key"
                                type="password"
                                value={azureSpeechKey}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAzureSpeechKey(e.target.value)}
                                placeholder={hasAzureSpeechKey ? '••••••••••••••••' : 'Paste your subscription key'}
                                autoComplete="new-password"
                                className={FIELD_INPUT}
                            />
                        </Field>
                    </div>
                    <div>
                        <SaveButton saving={savingAzureSpeech} disabled={!azureSpeechRegion.trim() && !azureSpeechKey.trim()} onClick={save}>
                            {t('integ.transcription_save_credentials', 'Save credentials')}
                        </SaveButton>
                    </div>
                </div>
                <Capabilities title={t('integ.transcription_capabilities', 'Capabilities')}>
                    <li>{t('integ.transcription_speaker_diarization_2', '✅ Speaker diarization')}</li>
                    <li>{t('integ.transcription_whisper_model_available', '✅ Whisper model available')}</li>
                    <li>{t('integ.transcription_gdpr_compliant_regions_e_g', '✅ GDPR-compliant regions (e.g.')} <code>westeurope</code>)</li>
                    <li>{t('integ.transcription_enterprise_sla', '✅ Enterprise SLA')}</li>
                    <li>{t('integ.transcription_key_encrypted_at_rest_aes_256_gcm', '🔒 Key encrypted at rest (AES-256-GCM) — never exposed in API responses')}</li>
                </Capabilities>
            </SettingsList>
            <Hint>
                {t('integ.transcription_create_a_resource_in_the', 'Create a resource in the')}{' '}
                <a href="https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices" target="_blank" rel="noopener noreferrer" className={HINT_LINK}>{t('integ.transcription_azure_portal_ai_speech', 'Azure Portal → AI Speech')}</a>{t('integ.transcription_copy', '. Copy')} <strong>{t('integ.transcription_key_1', 'Key 1')}</strong> {t('integ.transcription_and_the', 'and the')} <strong>{t('integ.transcription_location_region', 'Location / Region')}</strong>.
            </Hint>
        </SettingsGroup>
    );
}
