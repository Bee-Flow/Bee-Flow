/** React Query keys for the meeting sources. The hooks own them. */

export const sourceKeys = {
    all: ['meeting-sources'] as const,
    talkMeetings: ['meeting-sources', 'talk-meetings'] as const,
    meetMeetings: ['meeting-sources', 'gmeet-meetings'] as const,
    talkRecordings: ['meeting-sources', 'talk-recordings'] as const,
    nextcloudFiles: (folder: string) => ['meeting-sources', 'nextcloud-files', folder] as const,
    meetRecordings: ['meeting-sources', 'gmeet-recordings'] as const,
    meetImports: ['meeting-sources', 'gmeet-imports'] as const,
    /** One followed Meet import; `attempt` gives a re-import of the same job its own entry. */
    meetImportJob: (jobId: string, attempt: number) => ['meeting-sources', 'gmeet-import-job', jobId, attempt] as const,
};

/** Mutation keys, so a screen mounted again still sees an import that is running. */
export const importMutationKeys = {
    nextcloud: ['meeting-sources', 'import', 'nextcloud'] as const,
};
