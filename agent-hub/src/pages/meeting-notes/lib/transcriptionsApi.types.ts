/** Argument and option shapes of transcriptionsApi. */

export interface UploadAudioArgs {
    file: Blob;
    language: string;
    title: string;
    contextTerms?: string;
    attendees?: string;
    numSpeakers?: string;
    provider?: string;
    /** 'recording' | 'upload' */
    captureMode?: string;
    signal?: AbortSignal;
}

export interface UploadNextcloudArgs {
    path: string;
    language: string;
    title: string;
    contextTerms?: string;
    provider?: string;
}

export interface MeetingRecordOptions {
    seriesMasterId?: string;
    applyToSeries?: boolean;
}

export interface GoogleMeetImportInput {
    meetingCode?: string;
    applyToSeries?: boolean;
}

export interface ImportGoogleMeetArgs {
    eventId: string;
    meetingCode?: string;
    meetLink?: string;
    language: string;
    title?: string;
    contextTerms?: string;
}

export interface ImportTeamsArgs {
    eventId: string;
    language: string;
    contextTerms?: string;
}

export type RegenerateArg = string | null | { template?: string; templateId?: string; customPrompt?: string };

export interface TemplateInput {
    scope?: string;
    name: string;
    prompt: string;
    groupId?: string;
    isDefault?: boolean;
}

export interface SpeakerPatch {
    renames?: Record<string, string>;
    merges?: Array<{ from: string[]; into: string }>;
}
