/** React Query keys for meeting notes. The hooks own them; screens never spell one out. */

export const recordingKeys = {
    all: ['transcriptions'] as const,
    list: ['transcriptions', 'list'] as const,
    detail: (id: string) => ['transcriptions', 'detail', id] as const,
    tags: ['transcriptions', 'tags'] as const,
};
