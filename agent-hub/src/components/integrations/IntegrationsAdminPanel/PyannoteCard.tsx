import { Check, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type React from 'react';
import { saveTranscriptionConfig } from '@/api/transcriptionConfigApi';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranscriptionSectionProps } from './adminPanel.types';

/** Provider 5: pyannoteAI (key, speech-to-text model, voiceprint speaker identification). */
export default function PyannoteCard({ transcriptionProvider, pyannoteApiKey, setPyannoteApiKey, hasPyannoteKey, setHasPyannoteKey, savingPyannote, setSavingPyannote, pyannoteTranscriptionModel, saveTranscriptionModel, savingPyannoteModel, voiceprintMatchingEnabled, saveVoiceprintSettings, savingVoiceprint, pyannoteIdentifyThreshold, setMessage }: Pick<TranscriptionSectionProps, 'transcriptionProvider' | 'pyannoteApiKey' | 'setPyannoteApiKey' | 'hasPyannoteKey' | 'setHasPyannoteKey' | 'savingPyannote' | 'setSavingPyannote' | 'pyannoteTranscriptionModel' | 'saveTranscriptionModel' | 'savingPyannoteModel' | 'voiceprintMatchingEnabled' | 'saveVoiceprintSettings' | 'savingVoiceprint' | 'pyannoteIdentifyThreshold' | 'setMessage'>) {
    const { t } = useTranslation();
    // The input is a string while typing; the saved threshold stays a number.
    const [thresholdDraft, setThresholdDraft] = useState(String(pyannoteIdentifyThreshold));
    useEffect(() => { setThresholdDraft(String(pyannoteIdentifyThreshold)); }, [pyannoteIdentifyThreshold]);
    const commitThreshold = () => {
        const parsed = Number(thresholdDraft);
        // An empty or non-numeric field is not a threshold: restore the saved one.
        if (thresholdDraft.trim() === '' || !Number.isFinite(parsed)) {
            setThresholdDraft(String(pyannoteIdentifyThreshold));
            return;
        }
        const clamped = Math.min(100, Math.max(0, parsed));
        setThresholdDraft(String(clamped));
        if (clamped !== pyannoteIdentifyThreshold) saveVoiceprintSettings({ pyannoteIdentifyThreshold: clamped });
    };
    return (
        <div className="rounded-2xl border overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
                <h3 className="font-semibold flex items-center gap-2 text-[var(--text-primary)]">
                    {t('integ.transcription_pyannoteai', '🎯 pyannoteAI')}
                    <span className="text-xs px-2 py-0.5 rounded-full font-normal [background:#6d28d918] [color:#6d28d9]!">{t('integ.transcription_diarization_stt', 'Diarization + STT')}</span>
                    {transcriptionProvider === 'pyannote' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.transcription_active', 'Active')}</span>}
                    {hasPyannoteKey && <span className="text-xs px-2 py-0.5 rounded-full [background:var(--bg-primary)] [color:var(--text-muted)]! [border:1px_solid_var(--border-subtle)]">{t('integ.transcription_key_saved', 'Key saved 🔒')}</span>}
                </h3>
                <p className="text-xs mt-0.5 text-[var(--text-muted)]">{t('integ.transcription_best_in_class_speaker_diarization_with', 'Best-in-class speaker diarization with speaker-attributed transcription, in a single call.')}</p>
            </div>
            <div className="p-6 space-y-4">
                <div>
                    {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                    <label className="text-sm font-medium block mb-2 text-[var(--text-primary)]">{t('integ.transcription_pyannoteai_api_key', 'pyannoteAI API Key')}</label>
                    <p className="text-xs mb-1 text-[var(--text-muted)]">{t('integ.transcription_create_a_key_at_dashboard_pyannote_ai', 'Create a key at dashboard.pyannote.ai → API keys')}</p>
                    <input
                        type="password"
                        value={pyannoteApiKey}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPyannoteApiKey(e.target.value)}
                        placeholder={hasPyannoteKey ? '••••••••••••••••' : 'Paste your pyannoteAI API key'}
                        autoComplete="new-password"
                        className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' } as React.CSSProperties}
                    />
                    <button
                        onClick={async () => {
                            if (!pyannoteApiKey.trim()) return;
                            setSavingPyannote(true);
                            try {
                                const res = await saveTranscriptionConfig({ pyannoteApiKey: pyannoteApiKey.trim() });
                                if (res.ok) {
                                    setHasPyannoteKey(true);
                                    setPyannoteApiKey('');
                                    setMessage({ type: 'success', text: 'pyannoteAI API key saved securely' });
                                } else {
                                    const err = await res.json().catch(() => ({}));
                                    setMessage({ type: 'error', text: err.error || 'Failed to save pyannoteAI key' });
                                }
                            } catch (e) {
                                setMessage({ type: 'error', text: 'Failed to save pyannoteAI key' });
                            }
                            setSavingPyannote(false);
                            setTimeout(() => setMessage(null), 3000);
                        }}
                        disabled={savingPyannote || !pyannoteApiKey.trim()}
                        className="mt-3 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5 [background:var(--accent-primary)] [color:#fff]!"
                    >
                        {savingPyannote ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                        {t('integ.transcription_save_api_key', 'Save API key')}
                    </button>
                </div>
                {/* Speech model */}
                <div className="rounded-xl p-4 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                    <p className="text-sm font-medium mb-1 text-[var(--text-primary)]">{t('integ.transcription_speech_to_text_model', 'Speech-to-text model')}</p>
                    <p className="text-xs mb-3 text-[var(--text-muted)]">
                        {t('integ.transcription_speaker_separation_always_uses', 'Speaker separation always uses')} <strong>{t('integ.transcription_precision_3', 'precision-3')}</strong>{t('integ.transcription_pyannoteai_s_most_accurate_model_for', ', pyannoteAI’s most accurate model. For the words themselves, neither available model wins everywhere:')}
                        <strong> {t('integ.transcription_parakeet_v3', 'Parakeet v3')}</strong> {t('integ.transcription_is_the_more_accurate_of_the_two_6_34', 'is the more accurate of the two (6.34% vs 7.83% average word error rate on English) and covers 25 European languages including Dutch;')}
                        <strong> {t('integ.transcription_whisper_large_v3_turbo', 'Whisper large-v3-turbo')}</strong> {t('integ.transcription_is_a_little_weaker_but_covers_99_so_it', 'is a little weaker but covers 99, so it is the only option for Japanese, Chinese, Korean, Arabic and Turkish. Automatic picks the best one per meeting language.')}
                    </p>
                    <select
                        value={pyannoteTranscriptionModel}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => saveTranscriptionModel(e.target.value)}
                        disabled={savingPyannoteModel}
                        className="w-full px-3 py-2 rounded-lg text-sm border outline-none [background:var(--bg-secondary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                    >
                        <option value="">{t('integ.transcription_automatic_best_model_per_meeting', 'Automatic — best model per meeting language (recommended)')}</option>
                        <option value="parakeet-tdt-0.6b-v3">{t('integ.transcription_always_parakeet_v3_most_accurate', 'Always Parakeet v3 — most accurate, European languages only')}</option>
                        <option value="faster-whisper-large-v3-turbo">{t('integ.transcription_always_whisper_large_v3_turbo_widest', 'Always Whisper large-v3-turbo — widest language coverage')}</option>
                    </select>
                </div>
                {/* Voiceprint speaker identification */}
                <div className="rounded-xl p-4 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium mb-1 text-[var(--text-primary)]">{t('integ.transcription_recognise_speakers_by_voice', 'Recognise speakers by voice')}</p>
                            <p className="text-xs text-[var(--text-muted)]">
                                {t('integ.transcription_colleagues_record_a_personal_voice', 'Colleagues record a personal voice profile in Settings → Preferences (only they can record their own), after which their real name is put on their turns automatically. pyannoteAI cannot transcribe and identify in one job, so a')} <strong>{t('integ.transcription_second_job_per_meeting', 'second job per meeting')}</strong> {t('integ.transcription_is_submitted_but_only_when_someone_in', 'is submitted — but only when someone in that organisation actually has a voice profile. Turn this off to stop identification everywhere without anyone deleting theirs.')}
                            </p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={voiceprintMatchingEnabled}
                            onClick={() => saveVoiceprintSettings({ voiceprintMatchingEnabled: !voiceprintMatchingEnabled })}
                            disabled={savingVoiceprint}
                            className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-1 ${voiceprintMatchingEnabled ? '[background:var(--accent-primary)]' : '[background:var(--border-default)]'} ${savingVoiceprint ? '[opacity:0.6]' : '[opacity:1]'}`}
                        >
                            <div className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
                                style={{ transform: voiceprintMatchingEnabled ? 'translateX(20px)' : 'translateX(0)' }} />
                        </button>
                    </div>
                    {voiceprintMatchingEnabled && (
                        <div className="mt-3 pt-3 flex items-center gap-3 [border-top:1px_solid_var(--border-subtle)]">
                            <label className="text-xs flex-1 text-[var(--text-muted)]">
                                {t('integ.transcription_match_confidence_threshold_how_sure', 'Match confidence threshold — how sure pyannoteAI must be before a voice counts as a match. Higher means fewer names, but never the wrong one. Default 50.')}
                            </label>
                            <input
                                type="number" min={0} max={100}
                                value={thresholdDraft}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setThresholdDraft(e.target.value)}
                                onBlur={commitThreshold}
                                disabled={savingVoiceprint}
                                className="w-20 px-3 py-1.5 rounded-lg border outline-none text-sm [background:var(--bg-secondary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                            />
                        </div>
                    )}
                </div>
                {/* Capabilities */}
                <div className="rounded-xl p-4 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                    <p className="text-sm font-medium mb-2 text-[var(--text-primary)]">{t('integ.transcription_capabilities', 'Capabilities')}</p>
                    <ul className="text-xs space-y-1 text-[var(--text-muted)]">
                        <li>{t('integ.transcription_premium_speaker_diarization_precision', '✅ Premium speaker diarization (precision-3) — strong multi-speaker separation')}</li>
                        <li>{t('integ.transcription_speaker_attributed_transcription_in', '✅ Speaker-attributed transcription in the same call — no separate diarizer')}</li>
                        <li>{t('integ.transcription_per_meeting_speaker_count_honoured_set', '✅ Per-meeting speaker count honoured (set “Number of speakers” at upload)')}</li>
                        <li>{t('integ.transcription_optional_per_person_voiceprints_real', '✅ Optional per-person voiceprints — real names without an attendee list')}</li>
                        <li>{t('integ.transcription_audio_uploaded_to_pyannoteai_temporary', '✅ Audio uploaded to pyannoteAI temporary storage (24h) — no RustFS/public URL needed')}</li>
                        <li>{t('integ.transcription_key_voice_profiles_stored_encrypted', '🔒 Key + voice profiles stored encrypted (AES-256-GCM)')}</li>
                    </ul>
                </div>
            </div>
        </div>
    );
}
