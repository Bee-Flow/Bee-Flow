/** Shapes of the Upcoming panel (GET /api/transcriptions/{talk,gmeet,teams}-meetings). */
import type { LucideIcon } from 'lucide-react';
import type { TranslateFn } from '../../../hooks/useTranslation';
import type { TranscriptionsApiError } from '../lib/jsonOrThrow';
import type { UpcomingMeeting } from '../lib/upcomingMeta';

export type { TranscriptionsApiError };

export interface TalkMeeting extends UpcomingMeeting {
    talkToken: string;
    excluded: boolean;
    recordedNoteId?: string | null;
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
    recordingMode?: string;
    postSummaryBack?: boolean;
    meetings: TalkMeeting[];
}

export interface GmeetConnection {
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

export interface TeamsConnection {
    microsoftConnected?: boolean;
    teamsScopesGranted?: boolean;
    hasMeetingWriteScope?: boolean;
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
    error: TranscriptionsApiError | null;
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
    overridden: boolean;
    t: TranslateFn;
}

export interface UpcomingMeetingsProps {
    onOpenNote?: (id: string) => void;
    onRowsChange?: (count: number | null) => void;
}
