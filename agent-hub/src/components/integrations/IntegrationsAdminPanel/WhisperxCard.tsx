import { Check, Loader2 } from 'lucide-react';
import type React from 'react';
import { saveTranscriptionConfig } from '../../../api/transcriptionConfigApi';
import { useTranslation } from '../../../hooks/useTranslation';
import type { TranscriptionSectionProps } from './adminPanel.types';

/** Provider 3: WhisperX, self-hosted (server URL and optional bearer token). */
export default function WhisperxCard({ transcriptionProvider, whisperxUrl, setWhisperxUrl, whisperxToken, setWhisperxToken, hasWhisperxUrl, setHasWhisperxUrl, hasWhisperxToken, setHasWhisperxToken, savingWhisperx, setSavingWhisperx, setMessage }: Pick<TranscriptionSectionProps, 'transcriptionProvider' | 'whisperxUrl' | 'setWhisperxUrl' | 'whisperxToken' | 'setWhisperxToken' | 'hasWhisperxUrl' | 'setHasWhisperxUrl' | 'hasWhisperxToken' | 'setHasWhisperxToken' | 'savingWhisperx' | 'setSavingWhisperx' | 'setMessage'>) {
    const { t } = useTranslation();
    return (
        <div className="rounded-2xl border overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
                <h3 className="font-semibold flex items-center gap-2 text-[var(--text-primary)]">
                    {t('integ.transcription_whisperx', '🏠 WhisperX')}
                    <span className="text-xs px-2 py-0.5 rounded-full font-normal [background:#0ea5e918] [color:#0ea5e9]!">{t('integ.transcription_self_hosted', 'Self-hosted')}</span>
                    {transcriptionProvider === 'whisperx' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.transcription_active', 'Active')}</span>}
                    {hasWhisperxUrl && <span className="text-xs px-2 py-0.5 rounded-full [background:var(--bg-primary)] [color:var(--text-muted)]! [border:1px_solid_var(--border-subtle)]">{t('integ.transcription_url_saved', 'URL saved 🔒')}</span>}
                </h3>
                <p className="text-xs mt-0.5 text-[var(--text-muted)]">{t('integ.transcription_point_beeflow_at_your_own_whisperx_or', 'Point BeeFlow at your own WhisperX or Faster-Whisper server. Audio never leaves your network.')}</p>
            </div>
            <div className="p-6 space-y-4">
                {/* Server URL */}
                <div>
                    <label className="text-sm font-medium block mb-2 text-[var(--text-primary)]">{t('integ.transcription_server_configuration', 'Server Configuration')}</label>
                    <div className="space-y-2">
                        <div>
                            <p className="text-xs mb-1 text-[var(--text-muted)]">{t('integ.transcription_server_url_base_url_of_your_whisperx', 'Server URL — base URL of your WhisperX HTTP API')}</p>
                            <input
                                type="url"
                                value={whisperxUrl}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWhisperxUrl(e.target.value)}
                                placeholder={hasWhisperxUrl ? '••••••••••••••••' : 'http://whisperx:9000'}
                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' } as React.CSSProperties}
                            />
                        </div>
                        <div>
                            <p className="text-xs mb-1 text-[var(--text-muted)]">{t('integ.transcription_bearer_token', 'Bearer Token')} <em>{t('integ.transcription_optional_only_if_your_server_requires', '(optional — only if your server requires authentication)')}</em></p>
                            <input
                                type="password"
                                value={whisperxToken}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWhisperxToken(e.target.value)}
                                placeholder={hasWhisperxToken ? '••••••••••••••••' : 'Leave empty if your server is internal-only'}
                                autoComplete="new-password"
                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' } as React.CSSProperties}
                            />
                        </div>
                    </div>
                    <button
                        onClick={async () => {
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
                        }}
                        disabled={savingWhisperx || (!whisperxUrl.trim() && !whisperxToken.trim())}
                        className="mt-3 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5 [background:var(--accent-primary)] [color:#fff]!"
                    >
                        {savingWhisperx ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        {t('integ.transcription_save_server_config', 'Save server config')}
                    </button>
                </div>
                {/* Capabilities */}
                <div className="rounded-xl p-4 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                    <p className="text-sm font-medium mb-2 text-[var(--text-primary)]">{t('integ.transcription_capabilities', 'Capabilities')}</p>
                    <ul className="text-xs space-y-1 text-[var(--text-muted)]">
                        <li>{t('integ.transcription_speaker_diarization_2', '✅ Speaker diarization')}</li>
                        <li>{t('integ.transcription_fully_private_audio_stays_on_your', '✅ Fully private — audio stays on your server')}</li>
                        <li>{t('integ.transcription_gpu_accelerated_faster_than_real_time', '✅ GPU-accelerated (faster than real-time)')}</li>
                        <li>{t('integ.transcription_no_per_minute_cost', '✅ No per-minute cost')}</li>
                        <li>{t('integ.transcription_compatible_with', '✅ Compatible with')} <code>whisperx-server</code> {t('integ.transcription_and', 'and')} <code>faster-whisper-server</code></li>
                        <li>{t('integ.transcription_url_stored_encrypted_aes_256_gcm', '🔒 URL stored encrypted (AES-256-GCM)')}</li>
                    </ul>
                </div>
                {/* Setup guide */}
                <div className="rounded-xl p-4 space-y-3 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('integ.transcription_quick_setup_with_docker', 'Quick setup with Docker')}</p>
                    <pre className="text-xs rounded-lg p-3 overflow-x-auto [background:var(--bg-secondary)] [color:var(--text-secondary)]! [font-family:monospace]">{`docker run -d \\
--name whisperx \\
--gpus all \\
-p 9000:9000 \\
fedirz/faster-whisper-server:latest-cuda

# Then set Server URL to: http://your-host:9000`}</pre>
                    <p className="text-xs text-[var(--text-muted)]">
                        {t('integ.transcription_cpu_only_replace', 'CPU-only: replace')} <code>latest-cuda</code> {t('integ.transcription_with', 'with')} <code>latest-cpu</code>{t('integ.transcription_diarization_requires_a_hugging_face', '. Diarization requires a Hugging Face token — see the')}{' '}
                        <a href="https://github.com/fedirz/faster-whisper-server" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">{t('integ.transcription_faster_whisper_server_docs', 'faster-whisper-server docs')}</a>.
                    </p>
                </div>
            </div>
        </div>
    );
}
