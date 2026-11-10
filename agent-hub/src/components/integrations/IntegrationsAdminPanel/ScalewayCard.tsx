import { AlertTriangle } from 'lucide-react';
import type React from 'react';
import { saveTranscriptionConfig } from '@/api/transcriptionConfigApi';
import { useTranslation } from '@/hooks/useTranslation';
import { ALERT_WARNING, CHIP } from '@/components/mcpLibrary/ui';
import { FIELD_INPUT, Field, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import type { TranscriptionSectionProps } from './adminPanel.types';
import { Capabilities, SaveButton } from './ui';

/** Scaleway Whisper (hybrid: cloud speech-to-text, speakers from the local WhisperX). */
export default function ScalewayCard({ scalewayApiKey, setScalewayApiKey, hasScalewayKey, setHasScalewayKey, savingScaleway, setSavingScaleway, hasWhisperxUrl, setMessage }: Pick<TranscriptionSectionProps, 'scalewayApiKey' | 'setScalewayApiKey' | 'hasScalewayKey' | 'setHasScalewayKey' | 'savingScaleway' | 'setSavingScaleway' | 'hasWhisperxUrl' | 'setMessage'>) {
    const { t } = useTranslation();
    const save = async () => {
        if (!scalewayApiKey.trim()) return;
        setSavingScaleway(true);
        try {
            const res = await saveTranscriptionConfig({ scalewayApiKey: scalewayApiKey.trim() });
            if (res.ok) {
                setHasScalewayKey(true);
                setScalewayApiKey('');
                setMessage({ type: 'success', text: 'Scaleway API key saved securely' });
            } else {
                const err = await res.json().catch(() => ({}));
                setMessage({ type: 'error', text: err.error || 'Failed to save Scaleway key' });
            }
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to save Scaleway key' });
        }
        setSavingScaleway(false);
        setTimeout(() => setMessage(null), 3000);
    };
    return (
        <SettingsGroup
            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential
            title={t('integ.transcription_scaleway_api_key', 'Scaleway API Key')}
            description={t('integ.transcription_fast_gdpr_eu_cloud_transcription', 'Fast GDPR-EU cloud transcription (Whisper large-v3) with speaker labels from your local WhisperX diarizer.')}
            actions={hasScalewayKey ? <span className={CHIP}>{t('integ.transcription_key_saved', 'Key saved 🔒')}</span> : undefined}
        >
            {!hasWhisperxUrl && (
                <div className={ALERT_WARNING}>
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{t('integ.transcription_no_whisperx_url_configured_scaleway', '⚠️ No WhisperX URL configured. Scaleway will transcribe but every segment will be one speaker until you set the WhisperX/diarizer URL above.')}</span>
                </div>
            )}
            <SettingsList>
                <div className="flex flex-col gap-3 px-4 py-3">
                    {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a translated field label or i18n key, not a credential */}
                    <Field htmlFor="scaleway-key" label={t('integ.transcription_secret_key_from_the_scaleway_console', 'Secret key from the Scaleway console → Generative APIs → Generate API key')}>
                        <input id="scaleway-key" type="password" value={scalewayApiKey} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setScalewayApiKey(e.target.value)} placeholder={hasScalewayKey ? '••••••••••••••••' : 'Paste your Scaleway secret key'} autoComplete="new-password" className={FIELD_INPUT} />
                    </Field>
                    <div>
                        <SaveButton saving={savingScaleway} disabled={!scalewayApiKey.trim()} onClick={save}>
                            {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                            {t('integ.transcription_save_api_key', 'Save API key')}
                        </SaveButton>
                    </div>
                </div>
                <Capabilities title={t('integ.transcription_capabilities', 'Capabilities')}>
                    <li>{t('integ.transcription_fast_cloud_transcription_gpu_whisper', '✅ Fast cloud transcription — GPU Whisper large-v3, far quicker than local CPU')}</li>
                    <li>{t('integ.transcription_speaker_diarization_2', '✅ Speaker diarization')} <em>{t('integ.transcription_via_your_local_whisperx_diarizer', 'via your local WhisperX diarizer')}</em> {t('integ.transcription_needs_the_whisperx_url_above_set', '(needs the WhisperX URL above set)')}</li>
                    <li>{t('integ.transcription_runs_in_an_eu_region_gdpr_your_own', '✅ Runs in an EU region (GDPR) — your own Scaleway project')}</li>
                    <li>{t('integ.transcription_audio_is_sent_to_your_scaleway_eu', '⚠️ Audio is sent to your Scaleway EU project for transcription — not zero-egress like pure WhisperX')}</li>
                    <li>{t('integ.transcription_key_stored_encrypted_aes_256_gcm', '🔒 Key stored encrypted (AES-256-GCM)')}</li>
                </Capabilities>
            </SettingsList>
        </SettingsGroup>
    );
}
