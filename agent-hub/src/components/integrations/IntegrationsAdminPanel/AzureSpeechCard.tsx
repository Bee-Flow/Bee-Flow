import { Check, ExternalLink, Loader2 } from 'lucide-react';
import type React from 'react';
import { saveTranscriptionConfig } from '@/api/transcriptionConfigApi';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranscriptionSectionProps } from './adminPanel.types';

/** Provider 2: Azure AI Speech (region and key). */
export default function AzureSpeechCard({ transcriptionProvider, hasAzureSpeechKey, setHasAzureSpeechKey, azureSpeechKey, setAzureSpeechKey, azureSpeechRegion, setAzureSpeechRegion, savingAzureSpeech, setSavingAzureSpeech, setMessage }: Pick<TranscriptionSectionProps, 'transcriptionProvider' | 'hasAzureSpeechKey' | 'setHasAzureSpeechKey' | 'azureSpeechKey' | 'setAzureSpeechKey' | 'azureSpeechRegion' | 'setAzureSpeechRegion' | 'savingAzureSpeech' | 'setSavingAzureSpeech' | 'setMessage'>) {
    const { t } = useTranslation();
    return (
        <div className="rounded-2xl border overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
                <h3 className="font-semibold flex items-center gap-2 text-[var(--text-primary)]">
                    {t('integ.transcription_azure_ai_speech', '☁️ Azure AI Speech')}
                    <span className="text-xs px-2 py-0.5 rounded-full font-normal [background:#0078D418] [color:#0078D4]!">{t('integ.transcription_microsoft_cloud', 'Microsoft Cloud')}</span>
                    {transcriptionProvider === 'azure' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.transcription_active', 'Active')}</span>}
                    {hasAzureSpeechKey && <span className="text-xs px-2 py-0.5 rounded-full [background:var(--bg-primary)] [color:var(--text-muted)]! [border:1px_solid_var(--border-subtle)]">{t('integ.transcription_key_saved', 'Key saved 🔒')}</span>}
                </h3>
                <p className="text-xs mt-0.5 text-[var(--text-muted)]">{t('integ.transcription_azure_cognitive_services_speech_with', 'Azure Cognitive Services Speech with optional Whisper model. Enterprise SLAs, GDPR-compliant regions available.')}</p>
            </div>
            <div className="p-6 space-y-4">
                {/* Credentials */}
                <div>
                    <label className="text-sm font-medium block mb-2 text-[var(--text-primary)]">{t('integ.transcription_credentials', 'Credentials')}</label>
                    <div className="flex gap-2 mb-2">
                        <div className="flex-1">
                            <p className="text-xs mb-1 text-[var(--text-muted)]">{t('integ.transcription_region_e_g', 'Region (e.g.')} <code>westeurope</code>, <code>eastus</code>)</p>
                            <input
                                type="text"
                                value={azureSpeechRegion}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAzureSpeechRegion(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                                placeholder={t('integ.transcription_westeurope', 'westeurope')}
                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' } as React.CSSProperties}
                            />
                        </div>
                        <div className="flex-1">
                            {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                            <p className="text-xs mb-1 text-[var(--text-muted)]">{t('integ.transcription_api_key_key_1', 'API Key (Key 1)')}</p>
                            <input
                                type="password"
                                value={azureSpeechKey}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAzureSpeechKey(e.target.value)}
                                placeholder={hasAzureSpeechKey ? '••••••••••••••••' : 'Paste your subscription key'}
                                autoComplete="new-password"
                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' } as React.CSSProperties}
                            />
                        </div>
                    </div>
                    <button
                        onClick={async () => {
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
                        }}
                        disabled={savingAzureSpeech || (!azureSpeechRegion.trim() && !azureSpeechKey.trim())}
                        className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5 [background:var(--accent-primary)] [color:#fff]!"
                    >
                        {savingAzureSpeech ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        {t('integ.transcription_save_credentials', 'Save credentials')}
                    </button>
                </div>
                {/* Info */}
                <div className="rounded-xl p-4 space-y-1.5 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('integ.transcription_capabilities', 'Capabilities')}</p>
                    <ul className="text-xs space-y-1 text-[var(--text-muted)]">
                        <li>{t('integ.transcription_speaker_diarization_2', '✅ Speaker diarization')}</li>
                        <li>{t('integ.transcription_whisper_model_available', '✅ Whisper model available')}</li>
                        <li>{t('integ.transcription_gdpr_compliant_regions_e_g', '✅ GDPR-compliant regions (e.g.')} <code>westeurope</code>)</li>
                        <li>{t('integ.transcription_enterprise_sla', '✅ Enterprise SLA')}</li>
                        <li>{t('integ.transcription_key_encrypted_at_rest_aes_256_gcm', '🔒 Key encrypted at rest (AES-256-GCM) — never exposed in API responses')}</li>
                    </ul>
                </div>
                <div className="flex items-start gap-2 rounded-xl p-3 [background:var(--accent-primary)10] [border:1px_solid_var(--accent-primary)30]">
                    <ExternalLink className="w-4 h-4 mt-0.5 flex-shrink-0 text-[var(--accent-primary)]" />
                    <p className="text-xs text-[var(--text-muted)]">
                        {t('integ.transcription_create_a_resource_in_the', 'Create a resource in the')}{' '}
                        <a href="https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">{t('integ.transcription_azure_portal_ai_speech', 'Azure Portal → AI Speech')}</a>{t('integ.transcription_copy', '. Copy')} <strong>{t('integ.transcription_key_1', 'Key 1')}</strong> {t('integ.transcription_and_the', 'and the')} <strong>{t('integ.transcription_location_region', 'Location / Region')}</strong>.
                    </p>
                </div>
            </div>
        </div>
    );
}
