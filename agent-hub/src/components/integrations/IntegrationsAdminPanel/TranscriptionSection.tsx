// "Transcription" section of the IntegrationsAdminPanel: the engines that can
// transcribe meeting recordings as a list on the left (a dot when it is set up,
// "Active" on the one in use) and the selected engine on the right, with the
// button that makes it the active one and its own configuration.
import { useState, type ReactNode } from 'react';
import AppEmoji from '../../icons/AppEmoji';
import { saveTranscriptionConfig } from '@/api/transcriptionConfigApi';
import { useTranslation } from '@/hooks/useTranslation';
import { CHIP, CHIP_SUCCESS, CHIP_WARNING, PRIMARY_BTN } from '@/components/mcpLibrary/ui';
import { DetailLayout, DetailListGroup, DetailListNav, DetailListRow } from '@/components/shared/DetailList';
import SectionHeader from '@/components/shared/SectionHeader';
import AzureSpeechCard from './AzureSpeechCard';
import PyannoteCard from './PyannoteCard';
import ScalewayCard from './ScalewayCard';
import TranscriptionHowItWorks from './TranscriptionHowItWorks';
import VoxtralCard from './VoxtralCard';
import WhisperxCard from './WhisperxCard';
import type { TranscriptionSectionProps } from './adminPanel.types';
import { transcriptionEngines, type TranscriptionEngine } from './transcriptionEngines';

/** The configuration of one engine; Azure Whisper uses the Azure Speech credentials. */
function EngineConfig({ id, props }: { id: string; props: TranscriptionSectionProps }) {
    switch (id) {
        case 'voxtral': return <VoxtralCard />;
        case 'azure':
        case 'whisper_azure': return <AzureSpeechCard {...props} />;
        case 'whisperx': return <WhisperxCard {...props} />;
        case 'scaleway': return <ScalewayCard {...props} />;
        case 'pyannote': return <PyannoteCard {...props} />;
        default: return null;
    }
}

interface EngineDetailProps {
    engine: TranscriptionEngine;
    active: boolean;
    saving: boolean;
    onActivate: () => void;
    children: ReactNode;
}

function EngineDetail({ engine, active, saving, onActivate, children }: EngineDetailProps) {
    const { t } = useTranslation();
    return (
        <section aria-label={engine.name} className="flex flex-col gap-6">
            <header className="flex flex-wrap items-start gap-3">
                <div aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-xl">
                    <AppEmoji id={engine.catalogId} default={engine.emoji} />
                </div>
                <div className="min-w-[12rem] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="m-0 text-base font-semibold text-[var(--text-primary)]">{engine.name}</h3>
                        <span className={CHIP}>{engine.badge}</span>
                        {active && <span className={CHIP_SUCCESS}>{t('integ.transcription_active', 'Active')}</span>}
                    </div>
                    <p className="m-0 mt-1 text-xs text-[var(--text-secondary)]">{engine.desc}</p>
                    <p className="m-0 mt-2">
                        <span className={engine.ready ? CHIP_SUCCESS : CHIP_WARNING}>
                            {engine.ready ? '✓ Configured' : `⚠ Needs: ${engine.requires}`}
                        </span>
                    </p>
                </div>
                {!active && (
                    <button type="button" onClick={onActivate} disabled={saving} className={PRIMARY_BTN}>
                        {t('integ.transcription_use_engine', 'Use this provider')}
                    </button>
                )}
            </header>
            {children}
        </section>
    );
}

export default function TranscriptionSection(props: TranscriptionSectionProps) {
    const { t } = useTranslation();
    const { transcriptionProvider, setTranscriptionProvider, savingTranscriptionProvider, setSavingTranscriptionProvider, setMessage } = props;
    const engines = transcriptionEngines(props);
    const [selectedId, setSelectedId] = useState(transcriptionProvider);
    const selected = engines.find(e => e.id === selectedId) ?? engines[0];

    const activate = async (engine: TranscriptionEngine) => {
        if (transcriptionProvider === engine.id) return;
        setSavingTranscriptionProvider(true);
        try {
            const res = await saveTranscriptionConfig({ transcriptionProvider: engine.id });
            if (res.ok) {
                setTranscriptionProvider(engine.id);
                setMessage({ type: 'success', text: `Active provider set to ${engine.name}` });
            }
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to save provider' });
        }
        setSavingTranscriptionProvider(false);
        setTimeout(() => setMessage(null), 3000);
    };

    const list = (
        <DetailListNav label={t('integ.transcription_engines_nav', 'Transcription providers')}>
            <DetailListGroup title={t('integ.transcription_active_provider', 'Active Provider')}>
                {engines.map(e => (
                    <DetailListRow
                        key={e.id}
                        icon={<AppEmoji id={e.catalogId} default={e.emoji} />}
                        name={e.name}
                        live={e.ready}
                        meta={e.id === transcriptionProvider ? t('integ.transcription_active', 'Active') : undefined}
                        active={e.id === selected.id}
                        onClick={() => setSelectedId(e.id)}
                    />
                ))}
            </DetailListGroup>
        </DetailListNav>
    );

    return (
        <div className="flex max-w-5xl flex-col gap-6">
            <SectionHeader
                title={t('integ.transcription_meeting_transcription', 'Meeting Transcription')}
                description={<>
                    {t('integ.transcription_configure_which_ai_provider', 'Configure which AI provider transcribes your meeting recordings. All providers support')} <strong>{t('integ.transcription_speaker_diarization', 'speaker diarization')}</strong> {t('integ.transcription_who_said_what_and_automatic_speaker', '(who said what) and automatic speaker name identification. Switch providers at any time without losing settings.')}
                </>}
            />
            <DetailLayout list={list}>
                <EngineDetail
                    engine={selected}
                    active={selected.id === transcriptionProvider}
                    saving={savingTranscriptionProvider}
                    onActivate={() => { void activate(selected); }}
                >
                    <EngineConfig id={selected.id} props={props} />
                </EngineDetail>
            </DetailLayout>
            <TranscriptionHowItWorks />
        </div>
    );
}
