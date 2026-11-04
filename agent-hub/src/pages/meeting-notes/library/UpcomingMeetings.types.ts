/** Shapes of the Upcoming panel (GET /api/transcriptions/{talk,gmeet,teams}-meetings). */
import type { LucideIcon } from 'lucide-react';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { TranscriptionsApiError } from '@/api/jsonOrThrow';
import type { UpcomingMeeting } from '../lib/upcomingMeta';

;

export interface TalkMeeting extends UpcomingMeeting {
    talkToken: string;
    excluded: boolean;
    recordedNoteId?: string | null;
    /** The occurrence of a recurring series (talkCalendar); null for a single event. */
    recurrenceId?: string | null;
}

export interface GmeetMeeting extends UpcomingMeeting {
    eventId: string;
    excluded: boolean;
    recordingControlledByHost?: boolean;
}

export interface TeamsMeeting extends UpcomingMeeting {
    eventId: string;
    excluded: boolean;
}

export interface TalkData {
    recordingEnabled?: boolean;
    autoRecord?: boolean;
    recordingMode?: string;
    postSummaryBack?: boolean;
    meetings: TalkMeeting[];
}

interface GmeetConnection {
    googleConnected?: boolean;
    meetScopesGranted?: boolean;
    hasSettingsScope?: boolean;
}

export interface GmeetData {
    connection?: GmeetConnection | null;
    autoImport?: boolean;
    autoRecordConfig?: boolean;
    meetings: GmeetMeeting[];
}

interface TeamsConnection {
    microsoftConnected?: boolean;
    teamsScopesGranted?: boolean;
    hasMeetingWriteScope?: boolean;
    /** The grant expired or was revoked: the list is empty until a reconnect. */
    needsReauth?: boolean;
}

export interface TeamsData {
    connection?: TeamsConnection | null;
    autoImport?: boolean;
    autoRecordConfig?: boolean;
    meetings: TeamsMeeting[];
}

/** One source's load state. */
export interface SourceState<D> {
    loading: boolean;
    error: unknown;
    data: D | null;
}

/** A row of the merged list; `provider` tells which meeting shape `m` has. */
export type UpcomingRow =
    | { provider: 'talk'; key: string; start: string | null | undefined; m: TalkMeeting; status: string | undefined }
    | { provider: 'gmeet'; key: string; start: string | null | undefined; m: GmeetMeeting; status: string }
    | { provider: 'teams'; key: string; start: string | null | undefined; m: TeamsMeeting; status: string };

export interface ToggleProps {
    on: boolean;
    onClick: () => void;
    disabled?: boolean;
    label: string;
    title?: string;
}

export interface StatusChipProps {
    status: string | undefined;
    onOpenNote: () => void;
    t: TranslateFn;
}

export interface ProviderChipProps {
    provider: string;
    icon?: LucideIcon;
}

export interface DateBlockProps {
    start: string | null | undefined;
    t: TranslateFn;
}

export interface UpcomingMeetingRowProps {
    provider: string;
    icon: LucideIcon;
    meeting: UpcomingMeeting;
    status: string | undefined;
    noteId: string | null | undefined;
    onOpenNote?: (id: string) => void;
    record: boolean;
    toggleDisabled: boolean;
    onToggle: () => void;
    error?: string;
    /** What the toggle did to the provider's own auto-recording (autoRecordingHint), when a person must know it. */
    notice?: string;
    overridden: boolean;
    t: TranslateFn;
}

export interface UpcomingMeetingsProps {
    onOpenNote?: (id: string) => void;
    onRowsChange?: (count: number | null) => void;
    /**
     * Whether this account has Nextcloud connected at all (useMeetingSources().talk).
     * `false` hides the "Talk recording backend isn't configured" banner;
     * undefined (not known yet / not passed) keeps it.
     */
    talkConnected?: boolean;
}
