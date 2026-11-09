import type React from 'react';
import { saveTranscriptionConfig } from '@/api/transcriptionConfigApi';
import { useTranslation } from '@/hooks/useTranslation';
import { CHIP } from '@/components/mcpLibrary/ui';
import { FIELD_INPUT, Field, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import type { TranscriptionSectionProps } from './adminPanel.types';
import { Capabilities, HINT_LINK, SaveButton } from './ui';

/** WhisperX, self-hosted (server URL and optional bearer token). */
export default function WhisperxCard({ whisperxUrl, setWhisperxUrl, whisperxToken, setWhisperxToken, hasWhisperxUrl, setHasWhisperxUrl, hasWhisperxToken, setHasWhisperxToken, savingWhisperx, setSavingWhisperx, setMessage }: Pick<TranscriptionSectionProps, 'whisperxUrl' | 'setWhisperxUrl' | 'whisperxToken' | 'setWhisperxToken' | 'hasWhisperxUrl' | 'setHasWhisperxUrl' | 'hasWhisperxToken' | 'setHasWhisperxToken' | 'savingWhisperx' | 'setSavingWhisperx' | 'setMessage'>) {
    const { t } = useTranslation();
    const save = async () => {
        if (!whisperxUrl.trim() && !whisperxToken.trim()) return;
        setSavingWhisperx(true);
        try {
            const body: Record<string, string> = {};
            if (whisperxUrl.trim()) body.whisperxUrl = whisperxUrl.trim();
            if (whisperxToken !== '') body.whisperxToken = whisperxToken;
            const res = await saveTranscriptionConfig(body);
            if (res.ok) {
                if (whisperxUrl.trim()) setHasWhisperxUrl(true);
                if (whisperxToken.trim()) setHasWhisperxToken(true);
                setWhisperxUrl('');
                setWhisperxToken('');
                setMessage({ type: 'success', text: 'WhisperX server URL saved securely' });
            } else {
                const err = await res.json().catch(() => ({}));
                setMessage({ type: 'error', text: err.error || 'Failed to save WhisperX settings' });
            }
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to save WhisperX settings' });
        }
        setSavingWhisperx(false);
        setTimeout(() => setMessage(null), 3000);
    };
    return (
        <>
            <SettingsGroup
                title={t('integ.transcription_server_configuration', 'Server Configuration')}
                description={t('integ.transcription_point_beeflow_at_your_own_whisperx_or', 'Point BeeFlow at your own WhisperX or Faster-Whisper server. Audio never leaves your network.')}
                actions={hasWhisperxUrl ? <span className={CHIP}>{t('integ.transcription_url_saved', 'URL saved 🔒')}</span> : undefined}
            >
                <SettingsList>
                    <div className="flex flex-col gap-3 px-4 py-3">
                        <Field htmlFor="whisperx-url" label={t('integ.transcription_server_url_base_url_of_your_whisperx', 'Server URL — base URL of your WhisperX HTTP API')}>
                            <input id="whisperx-url" type="url" value={whisperxUrl} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWhisperxUrl(e.target.value)} placeholder={hasWhisperxUrl ? '••••••••••••••••' : 'http://whisperx:9000'} className={FIELD_INPUT} />
                        </Field>
                        <Field htmlFor="whisperx-token" label={<>{t('integ.transcription_bearer_token', 'Bearer Token')} <em className="font-normal text-[var(--text-tertiary)]">{t('integ.transcription_optional_only_if_your_server_requires', '(optional — only if your server requires authentication)')}</em></>}>
                            <input id="whisperx-token" type="password" value={whisperxToken} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWhisperxToken(e.target.value)} placeholder={hasWhisperxToken ? '••••••••••••••••' : 'Leave empty if your server is internal-only'} autoComplete="new-password" className={FIELD_INPUT} />
                        </Field>
                        <div>
                            <SaveButton saving={savingWhisperx} disabled={!whisperxUrl.trim() && !whisperxToken.trim()} onClick={save}>
                                {t('integ.transcription_save_server_config', 'Save server config')}
                            </SaveButton>
                        </div>
                    </div>
                    <Capabilities title={t('integ.transcription_capabilities', 'Capabilities')}>
                        <li>{t('integ.transcription_speaker_diarization_2', '✅ Speaker diarization')}</li>
                        <li>{t('integ.transcription_fully_private_audio_stays_on_your', '✅ Fully private — audio stays on your server')}</li>
                        <li>{t('integ.transcription_gpu_accelerated_faster_than_real_time', '✅ GPU-accelerated (faster than real-time)')}</li>
                        <li>{t('integ.transcription_no_per_minute_cost', '✅ No per-minute cost')}</li>
                        <li>{t('integ.transcription_compatible_with', '✅ Compatible with')} <code>whisperx-server</code> {t('integ.transcription_and', 'and')} <code>faster-whisper-server</code></li>
                        <li>{t('integ.transcription_url_stored_encrypted_aes_256_gcm', '🔒 URL stored encrypted (AES-256-GCM)')}</li>
                    </Capabilities>
                </SettingsList>
            </SettingsGroup>
            <SettingsGroup title={t('integ.transcription_quick_setup_with_docker', 'Quick setup with Docker')}>
                <pre className="m-0 overflow-x-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 font-mono text-xs text-[var(--text-secondary)]">{`docker run -d \\
--name whisperx \\
--gpus all \\
-p 9000:9000 \\
fedirz/faster-whisper-server:latest-cuda

# Then set Server URL to: http://your-host:9000`}</pre>
                <p className="m-0 text-xs text-[var(--text-tertiary)]">
                    {t('integ.transcription_cpu_only_replace', 'CPU-only: replace')} <code>latest-cuda</code> {t('integ.transcription_with', 'with')} <code>latest-cpu</code>{t('integ.transcription_diarization_requires_a_hugging_face', '. Diarization requires a Hugging Face token — see the')}{' '}
                    <a href="https://github.com/fedirz/faster-whisper-server" target="_blank" rel="noopener noreferrer" className={HINT_LINK}>{t('integ.transcription_faster_whisper_server_docs', 'faster-whisper-server docs')}</a>.
                </p>
            </SettingsGroup>
        </>
    );
}
