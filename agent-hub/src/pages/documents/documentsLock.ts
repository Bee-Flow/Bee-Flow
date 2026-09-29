import { useEntitlements } from '../../components/licensing/EntitlementsContext';

/**
 * Studio Documents is the Enterprise capability `studio_documents` (the
 * enterprise split, 2026-10). What it locks is MAKING and CHANGING documents;
 * the server keeps reading, the preview, the PDF and .pptx downloads, the
 * history and archiving open without it (routes/studioDocuments.js), so a
 * document somebody already made keeps working. These helpers let the pages
 * say so, in the same en/nl pair the rest of the Documents pages use
 * (./useDocumentText).
 */

export const STUDIO_DOCUMENTS = 'studio_documents';

type DocumentText = (en: string, nl?: string) => string;

type EntitlementsView = {
    lockReason?: (id: string) => string | null;
    loading?: boolean;
    error?: unknown;
};

/**
 * Why making documents is locked ('not_granted' = ask an admin, anything else
 * = a higher plan), or null when it is not. Only a real answer locks: while
 * the entitlements load or after their fetch failed the page stays as it was,
 * and the server has the last word.
 */
export function useDocumentsLock(): string | null {
    const { lockReason, loading, error } = useEntitlements() as unknown as EntitlementsView;
    if (loading || error || typeof lockReason !== 'function') return null;
    return lockReason(STUDIO_DOCUMENTS) || null;
}

/** The sentence for a lock reason: what is locked, and what still works. */
export function documentsLockText(reason: string | null | undefined, d: DocumentText): string {
    if (reason === 'not_granted') {
        return d('Making and changing documents is not switched on for your organisation, so ask an admin. You can still open, download and archive your documents.',
            'Documenten maken en wijzigen staat niet aan voor je organisatie, vraag het een beheerder. Je kunt je documenten nog steeds openen, downloaden en archiveren.');
    }
    return d('Making and changing documents is available on a higher plan. You can still open, download and archive your documents.',
        'Documenten maken en wijzigen kan met een hoger abonnement. Je kunt je documenten nog steeds openen, downloaden en archiveren.');
}

/**
 * A readable sentence for the server's licence refusal of a document request
 * (documentsApi carries `status`, `code` and `feature` on the error), or null
 * for any other failure.
 */
export function documentsRefusalText(err: unknown, d: DocumentText): string | null {
    const e = (err || {}) as { status?: unknown; code?: unknown; feature?: unknown };
    if (e.status !== 403 || e.feature !== STUDIO_DOCUMENTS) return null;
    if (e.code === 'feature_disabled') return documentsLockText('not_granted', d);
    if (e.code === 'feature_locked') return documentsLockText('ceiling', d);
    return null;
}
