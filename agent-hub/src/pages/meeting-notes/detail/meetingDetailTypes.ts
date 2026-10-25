import type { DestinationRecord } from '../lib/actionDestinations';
import type { PlayerSegment } from './player/player.types';

/** A speaker of a note: the id, how long they spoke, and whatever else the server stores. */
interface MeetingSpeaker {
    id: string;
    speakingSeconds?: number;
    speakingTime?: string;
    [key: string]: unknown;
}

/** A chapter of a note as the server stores it. */
export interface MeetingChapter {
    title?: string;
    start?: string;
    summary?: string;
}

/** One item of a meeting's action list (core/meetingNotes/actionItems.js). */
export interface MeetingActionItem {
    /** Absent until the server has minted it, for an item added on the client. */
    id?: string;
    text?: string;
    assignee?: string;
    timestamp?: string;
    done?: boolean;
    orphaned?: boolean;
    due?: string;
    destination?: DestinationRecord | null;
    [key: string]: unknown;
}

/** The meeting note as the detail view holds it (GET /api/transcriptions/:id). */
export interface MeetingNote {
    id: string;
    title?: string;
    status?: string;
    failureReason?: string;
    summary?: string;
    transcript?: string;
    tags?: string[];
    actionItems?: MeetingActionItem[];
    decisions?: MeetingActionItem[];
    questions?: MeetingActionItem[];
    chapters?: MeetingChapter[];
    segments?: PlayerSegment[];
    speakers?: MeetingSpeaker[];
    durationSeconds?: number;
    isOwner?: boolean;
    isPublished?: boolean;
    sharedGroups?: string[];
    meetMeetingCode?: string;
    talkRoomToken?: string;
    perPersonInsights?: boolean;
    summaryTemplateId?: string | null;
    summaryTemplateVersion?: number | null;
    audio?: { available?: boolean; recoverable?: boolean; localOnly?: boolean; storageConfigured?: boolean; [key: string]: unknown } | null;
    [key: string]: unknown;
}

export type SetMeeting = (updater: MeetingNote | ((prev: MeetingNote) => MeetingNote)) => void;

/** Fields the detail reports back to the library row after a change. */
export type MeetingRowPatch = Record<string, unknown>;

/** An error from transcriptionsApi: the message plus the server's code/status. */
export interface ApiError {
    message: string;
    code?: string | null;
    status?: number;
}

/** The prior note of the same Meet/Talk room (GET /api/transcriptions/:id/series-previous). */
export interface SeriesPrevious {
    id: string;
    title: string;
    createdAt: string | null;
    summary: string;
    openActionItems: MeetingActionItem[];
}
