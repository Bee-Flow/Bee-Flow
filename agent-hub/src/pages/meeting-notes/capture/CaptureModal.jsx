import React from 'react';
import { Mic, Upload, MessageSquare, Video, Users, ArrowLeft, X } from 'lucide-react';
import Modal from '../../../components/shared/Modal';
import IconButton from '../../../components/shared/IconButton';
import useConfirm from '../../../components/shared/useConfirm';
import useTranslation from '../../../hooks/useTranslation';
import CaptureTile from './CaptureTile';
import RecordPanel from './RecordPanel';
import UploadPanel from './UploadPanel';
import TalkImportPanel from './TalkImportPanel';
import GoogleMeetImportPanel from './GoogleMeetImportPanel';
import TeamsImportPanel from './TeamsImportPanel';
import { useCapture } from './CaptureContext';
import { useRecorder } from '../hooks/RecorderContext';
import useMediaQuery from '../hooks/useMediaQuery';
import useNextcloudConnected from '../hooks/useNextcloudConnected';
import useGoogleMeetConnected from '../hooks/useGoogleMeetConnected';
import { useTeamsNotesUserSettings } from '../../../api/queries/teamsMeetingNotes';

const PANELS = {
    record: RecordPanel,
    upload: UploadPanel,
    talk: TalkImportPanel,
    gmeet: GoogleMeetImportPanel,
    teams: TeamsImportPanel,
};

/**
 * The panel headings and the source-picker tiles, translated at render (a
 * module-level table would freeze one language into the bundle).
 *
 * Tile accents are TOKENS, never a brand hex: the same two the source chips
 * use (lib/sourceMeta.js — Talk blue is `--type-ai`, Meet green is
 * `--success`), plus the meeting kind's own colour for "record" so the tile
 * matches the rail row it produces.
 */
function captureText(t) {
    return {
        record: { title: t('meetings.capture_record_title', 'Record audio'), description: t('meetings.capture_record_desc', 'Capture from your microphone.') },
        upload: { title: t('meetings.capture_upload_title', 'Upload a recording'), description: t('meetings.capture_upload_desc', 'Drop a file from your computer.') },
        talk: { title: t('meetings.capture_talk_title', 'Import from Nextcloud Talk'), description: t('meetings.capture_talk_desc', 'Transcribe a Talk call recording.') },
        gmeet: { title: t('meetings.capture_gmeet_title', 'Import from Google Meet'), description: t('meetings.capture_gmeet_desc', 'Import a recorded Meet call.') },
        teams: { title: t('meetings.capture_teams_title', 'Import from Microsoft Teams'), description: t('meetings.capture_teams_desc', 'Import a Teams meeting you organised.') },
    };
}

function sourceTiles(t) {
    return [
        { key: 'record', icon: Mic, title: t('meetings.capture_record_title', 'Record audio'), description: t('meetings.capture_tile_record_desc', 'Capture live from your microphone.'), accent: 'var(--kind-meet)' },
        { key: 'upload', icon: Upload, title: t('meetings.capture_tile_upload_title', 'Upload a file'), description: t('meetings.capture_tile_upload_desc', 'Drop a .mp3, .wav, .m4a or .mp4.'), accent: 'var(--accent-primary)' },
        { key: 'talk', icon: MessageSquare, title: t('meetings.capture_tile_talk_title', 'Nextcloud Talk'), description: t('meetings.capture_talk_desc', 'Transcribe a Talk call recording.'), accent: 'var(--type-ai)', requiresNextcloud: true },
        { key: 'gmeet', icon: Video, title: t('meetings.capture_tile_gmeet_title', 'Google Meet'), description: t('meetings.capture_gmeet_desc', 'Import a recorded Meet call.'), accent: 'var(--success)', requiresGoogleMeet: true },
        { key: 'teams', icon: Users, title: t('meetings.capture_tile_teams_title', 'Microsoft Teams'), description: t('meetings.capture_teams_desc', 'Import a Teams meeting you organised.'), accent: 'var(--accent-secondary)', requiresTeams: true },
    ];
}

export default function CaptureModal() {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const { open, mode, setMode, closeCapture } = useCapture();
    const isMobile = useMediaQuery('(max-width: 767px)');
    const { recorder } = useRecorder();
    // Only offer the Nextcloud Talk source when the user actually has Nextcloud
    // connected. Probed lazily once the modal opens.
    const { connected: nextcloudConnected } = useNextcloudConnected(open);
    // Same lazy probe for Google Meet. The tile also shows for connections
    // missing the Meet scopes — the panel then renders the re-consent CTA.
    const { connected: gmeetConnected, needsReconsent: gmeetNeedsReconsent } = useGoogleMeetConnected(open);
    const gmeetAvailable = gmeetConnected || gmeetNeedsReconsent;
    // Teams: offered once Microsoft 365 is connected; a grant without the
    // Teams permissions gets the reconnect prompt inside the panel.
    const teamsSettings = useTeamsNotesUserSettings(open);
    const teamsAvailable = teamsSettings.data?.connection?.microsoftConnected === true;

    const recording = recorder.state === 'recording' || recorder.state === 'paused';
    const close = async () => {
        // Don't tear down the modal mid-recording without warning. The product's
        // own dialog, not window.confirm: a browser box titled "localhost says"
        // reads as something happening TO the app, and cannot say "keep
        // recording" on its confirm button.
        if (recording) {
            const ok = await confirm({
                title: t('meetings.capture_close_title', 'Close while recording?'),
                description: t('meetings.capture_close_desc', 'The recording keeps running in the background — you can come back to it from the recording bar.'),
                confirmLabel: t('meetings.capture_close_confirm', 'Keep recording'),
                cancelLabel: t('common.cancel', 'Cancel'),
            });
            if (!ok) return;
        }
        closeCapture();
    };

    const onComplete = () => closeCapture();
    // 'talk'/'gmeet'/'teams' are only reachable when the matching integration is
    // connected (the tile is hidden otherwise) — guard the panel too so a
    // stale mode can't render it.
    const ModePanel = mode
        && (mode !== 'talk' || nextcloudConnected)
        && (mode !== 'gmeet' || gmeetAvailable)
        && (mode !== 'teams' || teamsAvailable)
        && PANELS[mode];

    const modeText = captureText(t);
    const tiles = sourceTiles(t).filter((tile) => (!tile.requiresNextcloud || nextcloudConnected)
        && (!tile.requiresGoogleMeet || gmeetAvailable)
        && (!tile.requiresTeams || teamsAvailable));
    const tileGridClass = tiles.length >= 3
        ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'
        : 'grid grid-cols-1 sm:grid-cols-2 gap-3';

    const body = (
        <div className="flex flex-col gap-5">
            {!mode && (
                <div className={tileGridClass}>
                    {tiles.map((tile) => (
                        <CaptureTile key={tile.key} icon={tile.icon} title={tile.title} description={tile.description} onClick={() => setMode(tile.key)} accent={tile.accent} />
                    ))}
                </div>
            )}
            {mode && ModePanel && (
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2">
                        <IconButton ariaLabel={t('common.back', 'Back')} onClick={() => setMode(null)} size="md">
                            <ArrowLeft />
                        </IconButton>
                        <div>
                            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{modeText[mode]?.title}</div>
                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{modeText[mode]?.description}</div>
                        </div>
                    </div>
                    <ModePanel onComplete={onComplete} />
                </div>
            )}
        </div>
    );

    // Mobile: bottom sheet
    if (isMobile) {
        if (!open) return null;
        return (
            <>
                <Modal open onClose={close} variant="bare" placement="bottom" size="auto" label={t('meetings.capture_title', 'New transcription')}>
                    <div
                        className="w-full rounded-t-2xl shadow-2xl border-t flex flex-col max-h-[92vh]"
                        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                    >
                        <div className="flex items-center justify-between px-4 pt-3 pb-2">
                            <div className="w-10 h-1 rounded-full mx-auto" style={{ background: 'var(--border-default)' }} />
                            <button type="button" onClick={close} aria-label={t('common.close', 'Close')} className="absolute right-3 top-3 p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="px-4 pb-5 pt-2 overflow-y-auto">{body}</div>
                    </div>
                </Modal>
                {confirmDialog}
            </>
        );
    }

    return (
        <>
            <Modal
                open={open}
                onClose={close}
                title={t('meetings.capture_title', 'New transcription')}
                description={t('meetings.capture_desc', 'Record or upload audio to a meeting.')}
                size="lg"
            >
                {body}
            </Modal>
            {confirmDialog}
        </>
    );
}
