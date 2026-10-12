/**
 * One group's rows, from the wire rows its fetch returned. Pure: buildResults
 * (results.ts) runs these on every keystroke, from cache, while a request is
 * still in flight.
 */

import { timeAgo } from '@/core/i18n';

import { conversationSnippet, matches, snippetAround } from './format';
import type {
    AutomationSearchRow,
    ConversationSearchRow,
    CorpusDocument,
    KbSearchHitRow,
    KnowledgeBaseRow,
    NotebookSearchRow,
    SearchHit,
    TranscriptSearchRow,
} from './types';

export const PER_GROUP_LIMIT = 8;

export function chatHits(rows: ConversationSearchRow[], term: string): SearchHit[] {
    return rows.slice(0, 12).map<SearchHit>((row) => {
        const isDirect = row.kind !== 'agent';
        const snippet = conversationSnippet(row.messages_json, term);
        return {
            key: `chat:${row.kind ?? 'agent'}:${row.id}`,
            group: 'chats',
            title: row.title || 'Untitled chat',
            subtitle: snippet ?? (isDirect ? 'Matched in the title' : `${row.agent_name ?? 'Agent'} · matched in the title`),
            meta: timeAgo(row.updated_at),
            // Agent conversations have no screen on the phone yet; they open in
            // the agent's own chat on the web. Showing them anyway is the point
            // — "it exists, on your desktop" beats pretending it does not.
            href: isDirect ? `/chat/${row.id}` : null,
        };
    });
}

export function notebookHits(rows: NotebookSearchRow[], term: string): SearchHit[] {
    return rows.slice(0, PER_GROUP_LIMIT).map<SearchHit>((row) => ({
        key: `notebook:${row.id}`,
        group: 'notebooks',
        title: row.name || 'Untitled notebook',
        subtitle:
            (row.description && snippetAround(row.description, term)) ||
            (row.preview && snippetAround(row.preview, term)) ||
            `${row.sourceCount} source${row.sourceCount === 1 ? '' : 's'}`,
        meta: timeAgo(row.lastActivityAt ?? row.updatedAt),
        href: `/notebooks/${row.id}`,
    }));
}

/**
 * Passage matches, joined back onto the corpus by `document_id` — the only way
 * to recover the knowledge base a chunk came from, since the chunk projection
 * does not carry `knowledge_base_id` (see the SELECT in core/kb/localKBIngest.js).
 */
function passageHits(
    passages: KbSearchHitRow[],
    byId: Map<string, CorpusDocument>,
    term: string,
    seen: Set<string>,
): SearchHit[] {
    const out: SearchHit[] = [];
    for (const passage of passages) {
        const docId = passage.document_id ? String(passage.document_id).toLowerCase() : null;
        const owner = docId ? byId.get(docId) : undefined;
        // `||` for the id: the reader turns an absent one into ''.
        const key = `document:${docId ?? passage.chunk_id ?? (passage.id || out.length)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            key,
            group: 'documents',
            title: owner?.title || passage.title || passage.source_uri || 'Untitled document',
            subtitle: snippetAround(passage.content ?? '', term),
            meta: owner?.kbName,
            // Unjoinable passage: the chunk is real but we cannot say which
            // base holds it, so the row informs without offering a dead tap.
            href: owner ? `/knowledge/${owner.knowledge_base_id}` : null,
        });
    }
    return out;
}

/** Title and address matches, after the passages, up to twice a group's limit in all. */
function titleHits(documents: CorpusDocument[], q: string, seen: Set<string>, room: number): SearchHit[] {
    const out: SearchHit[] = [];
    for (const doc of documents) {
        if (out.length >= room) break;
        const key = `document:${String(doc.id).toLowerCase()}`;
        if (seen.has(key) || (!matches(doc.title, q) && !matches(doc.source_uri, q))) continue;
        seen.add(key);
        out.push({
            key,
            group: 'documents',
            title: doc.title || doc.source_uri || 'Untitled document',
            subtitle: `${doc.kbName} · ${doc.chunk_count} chunk${doc.chunk_count === 1 ? '' : 's'}`,
            meta: timeAgo(doc.created_at),
            href: `/knowledge/${doc.knowledge_base_id}`,
        });
    }
    return out;
}

/**
 * Documents, from two directions at once. A title match is what someone means
 * by "find my invoice PDF"; a passage match is what they mean by "find where I
 * wrote about the invoice". Both belong in the same group.
 */
export function documentHits(documents: CorpusDocument[], passages: KbSearchHitRow[], term: string): SearchHit[] {
    const byId = new Map(documents.map((doc) => [String(doc.id).toLowerCase(), doc]));
    const seen = new Set<string>();
    const fromPassages = passageHits(passages, byId, term, seen);
    const room = Math.max(0, PER_GROUP_LIMIT * 2 - fromPassages.length);
    return [...fromPassages, ...titleHits(documents, term.toLowerCase(), seen, room)];
}

export function knowledgeHits(rows: KnowledgeBaseRow[], q: string): SearchHit[] {
    return rows
        .filter((row) => matches(row.name, q) || matches(row.description, q))
        .slice(0, PER_GROUP_LIMIT)
        .map<SearchHit>((row) => ({
            key: `kb:${row.id}`,
            group: 'knowledge',
            title: row.name,
            subtitle: row.description ?? undefined,
            meta: row.document_count === undefined ? undefined : `${row.document_count} docs`,
            href: `/knowledge/${row.id}`,
        }));
}

export function automationHits(rows: AutomationSearchRow[], q: string): SearchHit[] {
    return rows
        .filter((row) => matches(row.title, q) || matches(row.description, q))
        .slice(0, PER_GROUP_LIMIT)
        .map<SearchHit>((row) => ({
            key: `automation:${row.id}`,
            group: 'automations',
            title: row.title || 'Untitled automation',
            subtitle: row.description ?? (row.isActive ? 'Active' : 'Paused'),
            meta: timeAgo(row.lastRunAt ?? row.updatedAt),
            href: `/automations/${row.id}`,
        }));
}

/**
 * Meeting notes match on the snippet the server ships FOR this purpose:
 * `transcriptSnippet` is the first 2000 characters of the raw text. Beyond
 * those the phone cannot see, which is exactly what the "searched on this
 * device" note on the group heading is warning about.
 */
export function transcriptHits(rows: TranscriptSearchRow[], term: string): SearchHit[] {
    const q = term.toLowerCase();
    return rows
        .filter(
            (row) =>
                matches(row.title, q) ||
                matches(row.fileName, q) ||
                matches(row.transcriptSnippet, q) ||
                matches(row.summarySnippet, q),
        )
        .slice(0, PER_GROUP_LIMIT)
        .map<SearchHit>((row) => {
            const body = matches(row.transcriptSnippet, q)
                ? row.transcriptSnippet
                : matches(row.summarySnippet, q)
                  ? row.summarySnippet
                  : null;
            return {
                key: `transcript:${row.id}`,
                group: 'transcripts',
                title: row.title || row.fileName || 'Untitled recording',
                subtitle: body ? snippetAround(body, term) : (row.summarySnippet ?? undefined),
                meta: timeAgo(row.createdAt ?? row.updatedAt),
                href: `/recordings/${row.id}`,
            };
        });
}
