// "Transcription" section of the IntegrationsAdminPanel (Meeting Transcription
// provider picker + per-provider configuration). Subtree moved verbatim from
// IntegrationsAdminPanel.jsx; all bindings are threaded in as props.
import { Cloud } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import AzureSpeechCard from './AzureSpeechCard';
import PyannoteCard from './PyannoteCard';
import ScalewayCard from './ScalewayCard';
import TranscriptionHowItWorks from './TranscriptionHowItWorks';
import TranscriptionProviderPicker from './TranscriptionProviderPicker';
import VoxtralCard from './VoxtralCard';
import WhisperxCard from './WhisperxCard';
import type { TranscriptionSectionProps } from './adminPanel.types';

export default function TranscriptionSection(props: TranscriptionSectionProps) {
    const { t } = useTranslation();
    return (
        <div className="p-6">
            <div className="max-w-4xl mx-auto space-y-6">

                {/* Header */}
                <div>
                    <h2 className="text-lg font-bold flex items-center gap-2 text-[var(--text-primary)]">
                        <Cloud className="w-5 h-5 [color:#0ea5e9]" />
                        {t('integ.transcription_meeting_transcription', 'Meeting Transcription')}
                    </h2>
                    <p className="text-sm mt-1 text-[var(--text-muted)]">
                        {t('integ.transcription_configure_which_ai_provider', 'Configure which AI provider transcribes your meeting recordings. All providers support')} <strong>{t('integ.transcription_speaker_diarization', 'speaker diarization')}</strong> {t('integ.transcription_who_said_what_and_automatic_speaker', '(who said what) and automatic speaker name identification. Switch providers at any time without losing settings.')}
                    </p>
                </div>

                {/* Active provider picker */}
                <TranscriptionProviderPicker {...props} />

                {/* ── Provider 1: Voxtral ─────────────────────────────────────────── */}
                <VoxtralCard {...props} />

                {/* ── Provider 2: Azure AI Speech ─────────────────────────────────── */}
                <AzureSpeechCard {...props} />

                {/* ── Provider 3: WhisperX self-hosted ────────────────────────────── */}
                <WhisperxCard {...props} />

                {/* ── Provider 4: Scaleway Whisper (hybrid) ────────────────────────── */}
                <ScalewayCard {...props} />

                {/* ── Provider 5: pyannoteAI (all-in-one diarization + transcription) ── */}
                <PyannoteCard {...props} />

                {/* How transcription works */}
                <TranscriptionHowItWorks />

            </div>
        </div>
    );
}
