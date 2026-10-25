/** The Insights model (lib/insightsMetrics.js buildInsightsModel) as the tabs read it. */

/** Jump the player to a moment, in seconds. */
export type SeekFn = (seconds: number) => void;

export interface Monologue {
    start: number;
    end: number;
    seconds: number;
    flagged: boolean;
}

export interface TalkSpeaker {
    speakerId: string;
    speakingSeconds: number;
    share: number;
    turnCount: number;
    summary?: string;
    longestMonologue: Monologue | null;
}

export interface TalkStats {
    speakers: TalkSpeaker[];
    totalSpeakingSeconds: number;
    silenceSeconds: number;
    topShare: number;
    balance: number;
}

export interface Interactivity {
    score: number;
    switches: number;
    switchesPerMinute: number;
    windows: Array<{ start: number; switches: number }>;
}

export interface AirtimeWindow {
    start: number;
    end: number;
    speechSeconds: number;
    shares: Array<{ speakerId: string; seconds: number; share: number }>;
}

export interface DeadAirGap {
    start: number;
    end: number;
    seconds: number;
    kind: 'lead_in' | 'gap' | 'lead_out';
}

interface FlowStats {
    windowSeconds: number;
    monologue: { seconds: number; totalSeconds: number; ratio: number; count: number } | null;
    deadAir: DeadAirGap[];
    readonly airtime: AirtimeWindow[] | null;
    readonly handoffs: Array<{ from: string; to: string; count: number }> | null;
}

interface ChapterBlock {
    title: string;
    seconds: number;
    endSeconds: number;
    fraction: number;
    widthFraction: number;
    summary: string | null;
}

/** A chapter; the speaker fields are stripped when the org disables per-person stats. */
type TopicBlock = ChapterBlock & (
    | { topSpeakerId: string | null; topSpeakerShare: number; openedBy: string | null }
    | { topSpeakerId?: undefined; topSpeakerShare?: undefined; openedBy?: undefined }
);

interface TopicsStats {
    blocks: TopicBlock[];
    top: Array<{ title: string; seconds: number; share: number }>;
    tags: Array<{ tag: string; count: number; firstSeconds: number | null }>;
}

interface FollowUpStats {
    total: number;
    open: number;
    done: number;
    unassigned: number;
    withDue: number;
    overdue: number;
    decisions: number;
    decisionsPerHour: number;
    openQuestions: Array<{ id: string; text: string; seconds: number | null }>;
    byAssignee: Array<{ assignee: string; total: number; open: number; overdue: number }> | null;
}

export interface PersonStat extends TalkSpeaker {
    words: number;
    wpm: number | null;
    questionCount: number;
    avgTurnSeconds: number;
    listeningSeconds: number;
}

export interface Highlight {
    id: string;
    label: string;
    value: number;
    kind: string;
    detail?: string;
    seconds?: number;
}

export interface InsightsModel {
    duration: number;
    talk: TalkStats;
    interactivity: Interactivity | null;
    perPersonEnabled: boolean;
    flow: FlowStats;
    topics: TopicsStats;
    followUp: FollowUpStats;
    actionsPerTopic: Array<{ title: string; seconds: number; count: number }>;
    people: { rows: PersonStat[]; silentAttendees: string[] } | null;
    overview: Highlight[];
}
