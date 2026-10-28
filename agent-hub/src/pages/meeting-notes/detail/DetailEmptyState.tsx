import React from 'react';
import { Mic, Upload, FileAudio, Video, Users } from 'lucide-react';
import { useTeamsNotesUserSettings } from '@/api/queries/teamsMeetingNotes';
import { kindColorVar, kindTint } from '@/components/shared/kindColors';
import useTranslation from '@/hooks/useTranslation';
import type { LucideIcon } from 'lucide-react';
import type { CaptureMode } from '../capture/CaptureContext';
import { useCapture } from '../capture/CaptureContext';
import useGoogleMeetConnected from '../hooks/useGoogleMeetConnected';

export default function DetailEmptyState() {
    const { t } = useTranslation();
    const { openCapture } = useCapture();
    // Same conditions as the tiles in the capture modal.
    const { connected: gmeetConnected, needsReconsent: gmeetNeedsReconsent } = useGoogleMeetConnected(true);
    const teamsSettings = useTeamsNotesUserSettings(true);
    const actions: [LucideIcon, string, CaptureMode][] = [
        [Mic, t('meetings.record', 'Record'), 'record'],
        [Upload, t('meetings.upload', 'Upload'), 'upload'],
    ];
    if (teamsSettings.data?.connection?.microsoftConnected === true) {
        actions.push([Users, t('meetings.capture_tile_teams_title', 'Microsoft Teams'), 'teams']);
    }
    if (gmeetConnected || gmeetNeedsReconsent) {
        actions.push([Video, t('meetings.capture_tile_gmeet_title', 'Google Meet'), 'gmeet']);
    }
    return (
        <div className="h-full flex flex-col items-center justify-center px-6 py-12 text-center">
            <div className="w-16 h-16 rounded-2xl grid place-items-center mb-5" style={{ background: kindTint('meeting', 16), color: kindColorVar('meeting') }} aria-hidden="true">
                <FileAudio className="w-8 h-8" />
            </div>
            <div className="text-lg font-semibold mb-1 text-[var(--text-primary)]">
                {t('meetings.select_title', 'Select a meeting')}
            </div>
            <div className="text-sm max-w-md mb-6 text-[var(--text-tertiary)]">
                {t('meetings.select_desc', 'Pick a meeting from the library to see its summary, action items and full transcript — or start a new one below.')}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
                {actions.map(([Icon, label, mode]) => (
                    <button
                        key={mode}
                        type="button"
                        onClick={() => openCapture(mode)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium border transition-colors hover:bg-[var(--bg-tertiary)] [background:var(--bg-card)]! [border-color:var(--border-default)] [color:var(--text-primary)]!"
                    >
                        <Icon className="w-4 h-4" style={{ color: kindColorVar('meeting') }} aria-hidden="true" />
                        {label}
                    </button>
                ))}
            </div>
        </div>
    );
}
