/**
 * The knowledge base the Files dialog uploads into, and how many documents it
 * holds: one definition shared by the dialog and the "Upload files" pill.
 *
 * The pill used to count LINKED knowledge bases while the dialog lists the
 * documents of one of them, so an agent with one upload base holding two files
 * showed "1" on the pill and "Documents (2)" in the dialog (BFSF-392).
 */

interface AgentLike {
    config?: { wizard?: { primaryKbId?: string | null } | null } | null;
}

interface KbCounts {
    id?: string;
    documentCount?: number | null;
    documentCountAll?: number | null;
}

export interface ReportedDocCount {
    kbId: string;
    total: number;
}

const finiteOrUndefined = (n: unknown): number | undefined =>
    typeof n === 'number' && Number.isFinite(n) ? n : undefined;

/** The base the dialog uploads into: the one created with the agent, else the first linked one. */
export function uploadKbIdOf(
    agent: AgentLike | null | undefined,
    knowledgeBaseIds: readonly string[] | null | undefined,
): string | null {
    return agent?.config?.wizard?.primaryKbId || knowledgeBaseIds?.[0] || null;
}

/**
 * Documents in one base as the dialog counts them: every row, whatever its
 * processing status. `documentCount` on the list counts only the active rows,
 * so it is the fallback for a server that does not send `documentCountAll`.
 */
export function kbDocumentCount(kb: KbCounts | null | undefined): number | undefined {
    return finiteOrUndefined(kb?.documentCountAll ?? kb?.documentCount);
}

/**
 * The number on the "Upload files" pill, or undefined when there is no number
 * that can be trusted (the pill then shows none rather than a wrong one).
 *
 * A total the dialog reported for this base wins: it comes from the same read
 * that renders "Documents (N)". Otherwise the knowledge-base list is used, but
 * only once it was read and only when the base is in it: the list holds what
 * the picker may offer, and a linked base can be missing from it.
 */
export function uploadDocCountOf({
    uploadKbId,
    kbs,
    kbsReadable,
    reported,
}: {
    uploadKbId: string | null | undefined;
    kbs: readonly KbCounts[] | null | undefined;
    kbsReadable: boolean;
    reported?: ReportedDocCount | null;
}): number | undefined {
    if (!uploadKbId) return undefined;
    if (reported && reported.kbId === uploadKbId) {
        const total = finiteOrUndefined(reported.total);
        if (total !== undefined) return total;
    }
    if (!kbsReadable || !Array.isArray(kbs)) return undefined;
    return kbDocumentCount(kbs.find(kb => kb?.id === uploadKbId));
}
