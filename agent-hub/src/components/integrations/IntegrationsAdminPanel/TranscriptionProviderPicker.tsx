import AppEmoji from '../../icons/AppEmoji';
import { saveTranscriptionConfig } from '../../../api/transcriptionConfigApi';
import { useTranslation } from '../../../hooks/useTranslation';
import type { TranscriptionSectionProps } from './adminPanel.types';

/** The "Active Provider" card grid: one card per engine, a click saves it as the active provider. */
export default function TranscriptionProviderPicker({ transcriptionProvider, setTranscriptionProvider, savingTranscriptionProvider, setSavingTranscriptionProvider, hasAzureSpeechKey, hasWhisperxUrl, hasScalewayKey, hasPyannoteKey, setMessage }: Pick<TranscriptionSectionProps, 'transcriptionProvider' | 'setTranscriptionProvider' | 'savingTranscriptionProvider' | 'setSavingTranscriptionProvider' | 'hasAzureSpeechKey' | 'hasWhisperxUrl' | 'hasScalewayKey' | 'hasPyannoteKey' | 'setMessage'>) {
    const { t } = useTranslation();
    return (
        <div className="rounded-2xl border overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
                <h3 className="font-semibold text-[var(--text-primary)]">{t('integ.transcription_active_provider', 'Active Provider')}</h3>
                <p className="text-xs mt-0.5 text-[var(--text-muted)]">{t('integ.transcription_choose_which_engine_will_be_used_when', 'Choose which engine will be used when you transcribe audio in Meeting Notes.')}</p>
            </div>
            <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-3">
                {[
                    {
                        id: 'voxtral',
                        name: 'Voxtral',
                        badge: 'Mistral Cloud',
                        emoji: '⚡',
                        catalogId: 'integration.fast',
                        badgeColor: '#f59e0b',
                        desc: 'Fast, high-quality cloud transcription with built-in diarization. Requires a Mistral API key.',
                        requires: 'Mistral API key (AI Config)',
                        ready: true, // always potentially ready via API key
                    },
                    {
                        id: 'azure',
                        name: 'Azure Speech',
                        badge: 'Microsoft Cloud',
                        emoji: '☁️',
                        catalogId: 'integration.cloud',
                        badgeColor: '#0078D4',
                        desc: 'Enterprise-grade Whisper model on Azure. Great for compliance-conscious organisations.',
                        requires: 'Azure Speech key + region',
                        ready: hasAzureSpeechKey,
                    },
                    {
                        id: 'whisper_azure',
                        name: 'Azure Whisper',
                        badge: 'Batch API',
                        emoji: '🎙️',
                        catalogId: 'integration.recording',
                        badgeColor: '#0078D4',
                        desc: 'Higher accuracy via Azure Batch Transcription (Whisper model). Async — large files, up to 35 speakers. Uses RustFS for temp audio storage.',
                        requires: 'Azure Speech key + RustFS',
                        ready: hasAzureSpeechKey,
                    },
                    {
                        id: 'whisperx',
                        name: 'WhisperX',
                        badge: 'Self-hosted',
                        emoji: '🏠',
                        catalogId: 'integration.local',
                        badgeColor: '#10B981',
                        desc: 'Fully private. Run Whisper on your own server — audio never leaves your infrastructure. For CPU-only voice capture (chat input, no GPU required), the in-process whisper.cpp path is used automatically.',
                        requires: 'Self-hosted server URL (optional — CPU whisper.cpp runs without it)',
                        ready: hasWhisperxUrl,
                    },
                    {
                        id: 'scaleway',
                        name: 'Scaleway (hybrid)',
                        badge: 'Cloud + local',
                        emoji: '🇪🇺',
                        catalogId: 'integration.fast',
                        badgeColor: '#7c3aed',
                        desc: 'Fast GDPR-EU cloud transcription (Whisper large-v3) with speaker labels from your local WhisperX diarizer. Audio is sent to your Scaleway EU project.',
                        requires: 'Scaleway API key' + (hasWhisperxUrl ? '' : ' + WhisperX URL (for speakers)'),
                        ready: hasScalewayKey,
                    },
                    {
                        id: 'pyannote',
                        name: 'pyannoteAI',
                        badge: 'Diarization + STT',
                        emoji: '🎯',
                        catalogId: 'integration.cloud',
                        badgeColor: '#6d28d9',
                        desc: 'Premium speaker diarization + speaker-attributed transcription (precision-3) in one call. Best-in-class multi-speaker separation. Audio is uploaded to pyannoteAI temporary storage (24h) — no self-hosted diarizer or RustFS/public URL needed.',
                        requires: 'pyannoteAI API key',
                        ready: hasPyannoteKey,
                    },
                ].map((p) => (
                    <button
                        key={p.id}
                        onClick={async () => {
                            if (transcriptionProvider === p.id) return;
                            setSavingTranscriptionProvider(true);
                            try {
                                const res = await saveTranscriptionConfig({ transcriptionProvider: p.id });
                                if (res.ok) {
                                    setTranscriptionProvider(p.id);
                                    setMessage({ type: 'success', text: `Active provider set to ${p.name}` });
                                }
                            } catch (e) {
                                setMessage({ type: 'error', text: 'Failed to save provider' });
                            }
                            setSavingTranscriptionProvider(false);
                            setTimeout(() => setMessage(null), 3000);
                        }}
                        disabled={savingTranscriptionProvider}
                        className="relative rounded-xl border-2 p-4 text-left transition-all cursor-pointer disabled:opacity-50"
                        style={{
                            background: transcriptionProvider === p.id ? 'color-mix(in srgb, var(--accent-primary) 8%, var(--bg-primary))' : 'var(--bg-primary)',
                            borderColor: transcriptionProvider === p.id ? 'var(--accent-primary)' : 'var(--border-default)',
                        }}
                    >
                        {transcriptionProvider === p.id && (
                            <span className="absolute top-3 right-3 w-2 h-2 rounded-full bg-green-400" />
                        )}
                        <div className="text-2xl mb-2"><AppEmoji id={p.catalogId} default={p.emoji} /></div>
                        <div className="font-semibold text-sm mb-1 text-[var(--text-primary)]">{p.name}</div>
                        <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ background: p.badgeColor + '18', color: p.badgeColor }}>
                            {p.badge}
                        </span>
                        <p className="text-xs mt-2 text-[var(--text-muted)]">{p.desc}</p>
                        <p className="text-xs mt-2 font-medium" style={{ color: p.ready ? '#10b981' : 'var(--text-muted)' }}>
                            {p.ready ? '✓ Configured' : `⚠ Needs: ${p.requires}`}
                        </p>
                    </button>
                ))}
            </div>
        </div>
    );
}
