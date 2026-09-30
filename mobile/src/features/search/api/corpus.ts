/**
 * Global search, the CORPUS-FILTERED half: knowledge bases, routines and
 * meeting notes have NO query parameter on their list routes. Refetching all
 * three per keystroke would be three requests for a filter the phone can do in
 * a millisecond, so the lists are pulled once with a long staleTime and matched
 * locally (model/results.ts). The cost is honest and stated on screen: these
 * groups only match what the list projection carries.
 *
 * The lists are the owning features' own reads (knowledge, automations,
 * recording), so one reader describes each route:
 *
 *     routes/knowledgeBases/*             → /api/kb
 *     routes/automation/crud.js           → /api/automation
 *     routes/transcriptions/notes.js      → /api/transcriptions
 *
 * Every leg is independently fallible. A knowledge base that 403s on this plan,
 * or an automations router gated off behind a licence, must not empty a result
 * list that also found four chats — so the fan-out is Promise.allSettled and
 * each group carries its own error.
 */

import { listAutomations } from '@/features/automations';
import { listKbDocuments, listKnowledgeBases } from '@/features/knowledge';
import { listTranscriptions } from '@/features/recording';

import type {
    AutomationSearchRow,
    CorpusDocument,
    GroupErrors,
    KnowledgeBaseRow,
    SearchCorpus,
    TranscriptSearchRow,
} from '../model/types';

/** How many bases the document fan-out is allowed to touch. */
const MAX_DOCUMENT_BASES = 8;

/**
 * The documents of the first few bases.
 *
 * `documents` rows are always read through a base and there is no cross-base
 * endpoint, so this is a fan-out — bounded, and tolerant of one base failing:
 * a user who can LIST a base but not READ it must not lose the whole group.
 * Only when EVERY base refused is it reported as the group's error.
 */
async function fetchDocuments(
    bases: KnowledgeBaseRow[],
    signal?: AbortSignal,
): Promise<{ documents: CorpusDocument[]; error?: unknown }> {
    const chosen = bases.slice(0, MAX_DOCUMENT_BASES);
    const pages = await Promise.allSettled(
        chosen.map(async (kb) => {
            const page = await listKbDocuments(kb.id, { limit: 100 }, signal);
            return page.documents.map<CorpusDocument>((doc) => ({ ...doc, kbName: kb.name }));
        }),
    );
    const documents: CorpusDocument[] = [];
    const failures: unknown[] = [];
    for (const page of pages) {
        if (page.status === 'fulfilled') documents.push(...page.value);
        else failures.push(page.reason);
    }
    const allFailed = failures.length > 0 && failures.length === chosen.length;
    return allFailed ? { documents, error: failures[0] } : { documents };
}

/** Fetch everything that cannot be searched server-side. */
export async function fetchSearchCorpus(signal?: AbortSignal): Promise<SearchCorpus> {
    const errors: GroupErrors = {};

    const [basesResult, automationsResult, transcriptsResult] = await Promise.allSettled([
        listKnowledgeBases(signal),
        // Without `kind: 'block'` rows: those are reusable Steps, not routines.
        listAutomations(signal),
        listTranscriptions(signal, 100),
    ]);

    let knowledgeBases: KnowledgeBaseRow[] = [];
    if (basesResult.status === 'fulfilled') {
        knowledgeBases = basesResult.value;
    } else {
        // One failure, two groups: documents are read THROUGH the bases, so a
        // failed base list takes the documents with it.
        errors.knowledge = basesResult.reason;
        errors.documents = basesResult.reason;
    }

    let automations: AutomationSearchRow[] = [];
    if (automationsResult.status === 'fulfilled') {
        automations = automationsResult.value;
    } else {
        errors.automations = automationsResult.reason;
    }

    let transcripts: TranscriptSearchRow[] = [];
    if (transcriptsResult.status === 'fulfilled') transcripts = transcriptsResult.value;
    else errors.transcripts = transcriptsResult.reason;

    let documents: CorpusDocument[] = [];
    if (knowledgeBases.length > 0) {
        const fanOut = await fetchDocuments(knowledgeBases, signal);
        documents = fanOut.documents;
        if ('error' in fanOut) errors.documents = fanOut.error;
    }

    return { knowledgeBases, documents, automations, transcripts, errors };
}
