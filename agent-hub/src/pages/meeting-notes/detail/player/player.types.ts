/** Shapes the layered player components share (see lib/playerData and lib/timelineMarkers). */

/** One transcript segment as the player reads it. */
export interface PlayerSegment {
    speaker?: string;
    speakerId?: string;
    start: number;
    end: number;
    text?: string;
}

/** A normalised chapter block (lib/playerData normalizeChapters). */
export interface PlayerChapter {
    title: string;
    seconds: number;
    endSeconds: number;
    fraction: number;
    widthFraction: number;
    summary: string | null;
}

/** A clickable pin on the marker rail (lib/timelineMarkers). */
export interface TimelineMarker {
    id: string;
    seconds: number;
    fraction: number;
    label: string;
    assignee: string;
    done: boolean;
    count: number;
    completable?: boolean;
}

/** One coloured block of a speaker row. */
export interface SpeakerBlock {
    start: number;
    end: number;
    fraction: number;
    widthFraction: number;
}

/** One ranked speaker's timeline row. */
export interface SpeakerTimelineRow {
    speakerId: string;
    rank: number;
    speakingSeconds: number;
    blocks: SpeakerBlock[];
}

/** The aggregate row of the speakers past the visible rows. */
export interface OthersRow {
    count: number;
    speakerIds: string[];
    blocks: SpeakerBlock[];
}

/** Seek the audio; `play` also starts playback. */
export type SeekToFn = (seconds: number, opts?: { play?: boolean }) => void;
