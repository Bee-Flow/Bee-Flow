import React from 'react';
import { Mic, Upload, FileAudio } from 'lucide-react';
import { kindColorVar, kindTint } from '../../../components/shared/kindColors';
import useTranslation from '../../../hooks/useTranslation';
import { useCapture } from '../capture/CaptureContext';

export default function DetailEmptyState() {
    const { t } = useTranslation();
    const { openCapture } = useCapture();
    const actions = [
        [Mic, t('meetings.record', 'Record'), 'record'],
        [Upload, t('meetings.upload', 'Upload'), 'upload'],
    ];
    return (
        <div className="h-full flex flex-col items-center justify-center px-6 py-12 text-center">
            <div className="w-16 h-16 rounded-2xl grid place-items-center mb-5" style={{ background: kindTint('meeting', 16), color: kindColorVar('meeting') }} aria-hidden="true">
                <FileAudio className="w-8 h-8" />
            </div>
            <div className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                {t('meetings.select_title', 'Select a meeting')}
            </div>
            <div className="text-sm max-w-md mb-6" style={{ color: 'var(--text-tertiary)' }}>
                {t('meetings.select_desc', 'Pick a meeting from the library to see its summary, action items and full transcript — or start a new one below.')}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
                {actions.map(([Icon, label, mode]) => (
                    <button
                        key={mode}
                        type="button"
                        onClick={() => openCapture(mode)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium border transition-colors hover:bg-[var(--bg-tertiary)]"
                        style={{
                            background: 'var(--bg-card)',
                            borderColor: 'var(--border-default)',
                            color: 'var(--text-primary)',
                        }}
                    >
                        <Icon className="w-4 h-4" style={{ color: kindColorVar('meeting') }} aria-hidden="true" />
                        {label}
                    </button>
                ))}
            </div>
        </div>
    );
}
