import { ExternalLink } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranscriptionSectionProps } from './adminPanel.types';

/** Provider 1: Voxtral (Mistral cloud). Nothing to configure here; it reuses the Mistral API key. */
export default function VoxtralCard({ transcriptionProvider }: Pick<TranscriptionSectionProps, 'transcriptionProvider'>) {
    const { t } = useTranslation();
    return (
        <div className="rounded-2xl border overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="px-6 py-4 border-b flex items-center justify-between border-[var(--border-subtle)]">
                <div>
                    <h3 className="font-semibold flex items-center gap-2 text-[var(--text-primary)]">
                        {t('integ.transcription_voxtral', '⚡ Voxtral')} <span className="text-xs px-2 py-0.5 rounded-full font-normal [background:#f59e0b18] [color:#f59e0b]!">{t('integ.transcription_mistral_cloud', 'Mistral Cloud')}</span>
                        {transcriptionProvider === 'voxtral' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.transcription_active', 'Active')}</span>}
                    </h3>
                    <p className="text-xs mt-0.5 text-[var(--text-muted)]">{t('integ.transcription_uses_mistral_s', 'Uses Mistral\'s')} <code>voxtral-mini-latest</code> {t('integ.transcription_model_fast_and_accurate_with_speaker', 'model. Fast and accurate with speaker diarization.')}</p>
                </div>
            </div>
            <div className="p-6 space-y-3">
                <div className="rounded-xl p-4 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                    {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                    <p className="text-sm font-medium mb-1 text-[var(--text-primary)]">{t('integ.transcription_mistral_api_key', 'Mistral API Key')}</p>
                    <p className="text-xs text-[var(--text-muted)]">
                        {t('integ.transcription_voxtral_uses_your_existing_mistral_api', 'Voxtral uses your existing Mistral API key configured in')}{' '}
                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                        <strong>{t('integ.transcription_admin_ai_config_api_keys_mistral', 'Admin → AI Config → API Keys → Mistral')}</strong>{t('integ.transcription_no_additional_setup_needed_here', '. No additional setup needed here.')}
                    </p>
                </div>
                <div className="rounded-xl p-4 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                    <p className="text-sm font-medium mb-2 text-[var(--text-primary)]">{t('integ.transcription_capabilities', 'Capabilities')}</p>
                    <ul className="text-xs space-y-1 text-[var(--text-muted)]">
                        <li>{t('integ.transcription_speaker_diarization_who_said_what', '✅ Speaker diarization (who said what)')}</li>
                        <li>{t('integ.transcription_word_and_segment_timestamps', '✅ Word and segment timestamps')}</li>
                        <li>{t('integ.transcription_30_languages', '✅ 30+ languages')}</li>
                        <li>{t('integ.transcription_context_terms_to_boost_accuracy', '✅ Context terms to boost accuracy')}</li>
                        <li>{t('integ.transcription_audio_sent_to_mistral_cloud_servers', 'ℹ️ Audio sent to Mistral cloud servers')}</li>
                    </ul>
                </div>
                <a
                    href="https://console.mistral.ai"
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm underline text-[var(--accent-primary)]"
                >
                    <ExternalLink className="w-3.5 h-3.5" /> {t('integ.transcription_open_mistral_console', 'Open Mistral Console')}
                </a>
            </div>
        </div>
    );
}
