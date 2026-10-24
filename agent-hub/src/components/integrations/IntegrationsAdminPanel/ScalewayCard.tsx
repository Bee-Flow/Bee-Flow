import { Check, Loader2 } from 'lucide-react';
import type React from 'react';
import { saveTranscriptionConfig } from '../../../api/transcriptionConfigApi';
import { useTranslation } from '../../../hooks/useTranslation';
import type { TranscriptionSectionProps } from './adminPanel.types';

/** Provider 4: Scaleway Whisper (hybrid: cloud speech-to-text, speakers from the local WhisperX). */
export default function ScalewayCard({ transcriptionProvider, scalewayApiKey, setScalewayApiKey, hasScalewayKey, setHasScalewayKey, savingScaleway, setSavingScaleway, hasWhisperxUrl, setMessage }: Pick<TranscriptionSectionProps, 'transcriptionProvider' | 'scalewayApiKey' | 'setScalewayApiKey' | 'hasScalewayKey' | 'setHasScalewayKey' | 'savingScaleway' | 'setSavingScaleway' | 'hasWhisperxUrl' | 'setMessage'>) {
    const { t } = useTranslation();
    return (
        <div className="rounded-2xl border overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
                <h3 className="font-semibold flex items-center gap-2 text-[var(--text-primary)]">
                    {t('integ.transcription_scaleway_whisper', '🇪🇺 Scaleway Whisper')}
                    <span className="text-xs px-2 py-0.5 rounded-full font-normal [background:#7c3aed18] [color:#7c3aed]!">{t('integ.transcription_hybrid_eu', 'Hybrid · EU')}</span>
                    {transcriptionProvider === 'scaleway' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.transcription_active', 'Active')}</span>}
                    {hasScalewayKey && <span className="text-xs px-2 py-0.5 rounded-full [background:var(--bg-primary)] [color:var(--text-muted)]! [border:1px_solid_var(--border-subtle)]">{t('integ.transcription_key_saved', 'Key saved 🔒')}</span>}
                </h3>
                <p className="text-xs mt-0.5 text-[var(--text-muted)]">{t('integ.transcription_fast_gdpr_eu_cloud_transcription', 'Fast GDPR-EU cloud transcription (Whisper large-v3) with speaker labels from your local WhisperX diarizer.')}</p>
            </div>
            <div className="p-6 space-y-4">
                <div>
                    {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                    <label className="text-sm font-medium block mb-2 text-[var(--text-primary)]">{t('integ.transcription_scaleway_api_key', 'Scaleway API Key')}</label>
                    {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a translated field label or i18n key, not a credential */}
                    <p className="text-xs mb-1 text-[var(--text-muted)]">{t('integ.transcription_secret_key_from_the_scaleway_console', 'Secret key from the Scaleway console → Generative APIs → Generate API key')}</p>
                    <input
                        type="password"
                        value={scalewayApiKey}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setScalewayApiKey(e.target.value)}
                        placeholder={hasScalewayKey ? '••••••••••••••••' : 'Paste your Scaleway secret key'}
                        autoComplete="new-password"
                        className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' } as React.CSSProperties}
                    />
                    <button
                        onClick={async () => {
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
                        }}
                        disabled={savingScaleway || !scalewayApiKey.trim()}
                        className="mt-3 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5 [background:var(--accent-primary)] [color:#fff]!"
                    >
                        {savingScaleway ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                        {t('integ.transcription_save_api_key', 'Save API key')}
                    </button>
                </div>
                {/* Capabilities */}
                <div className="rounded-xl p-4 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                    <p className="text-sm font-medium mb-2 text-[var(--text-primary)]">{t('integ.transcription_capabilities', 'Capabilities')}</p>
                    <ul className="text-xs space-y-1 text-[var(--text-muted)]">
                        <li>{t('integ.transcription_fast_cloud_transcription_gpu_whisper', '✅ Fast cloud transcription — GPU Whisper large-v3, far quicker than local CPU')}</li>
                        <li>{t('integ.transcription_speaker_diarization_2', '✅ Speaker diarization')} <em>{t('integ.transcription_via_your_local_whisperx_diarizer', 'via your local WhisperX diarizer')}</em> {t('integ.transcription_needs_the_whisperx_url_above_set', '(needs the WhisperX URL above set)')}</li>
                        <li>{t('integ.transcription_runs_in_an_eu_region_gdpr_your_own', '✅ Runs in an EU region (GDPR) — your own Scaleway project')}</li>
                        <li>{t('integ.transcription_audio_is_sent_to_your_scaleway_eu', '⚠️ Audio is sent to your Scaleway EU project for transcription — not zero-egress like pure WhisperX')}</li>
                        <li>{t('integ.transcription_key_stored_encrypted_aes_256_gcm', '🔒 Key stored encrypted (AES-256-GCM)')}</li>
                    </ul>
                </div>
                {!hasWhisperxUrl && (
                    <div className="rounded-xl p-4 text-xs [background:var(--bg-primary)] [border:1px_solid_#f59e0b44] [color:var(--text-muted)]!">
                        {t('integ.transcription_no_whisperx_url_configured_scaleway', '⚠️ No WhisperX URL configured. Scaleway will transcribe but every segment will be one speaker until you set the WhisperX/diarizer URL above.')}
                    </div>
                )}
            </div>
        </div>
    );
}
