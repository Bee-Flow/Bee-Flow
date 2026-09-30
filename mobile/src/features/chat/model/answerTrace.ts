/**
 * The words of "How I got this answer": the tally on its line (the web's
 * HowIGotThisAnswer.jsx stats bar), the steps with their durations, and the
 * sources grouped by document (the web's KbSourcesPanel.jsx).
 *
 * The tally and the sources count DOCUMENTS, not passages, through the same
 * grouping as the chip row (citationGroups.ts): "10 sources" used to sit above
 * a handful of notes (BFSF-352).
 */

import type { TranslateFn } from '@/core/i18n';

import { documentCountOf, groupByDocument } from './citationGroups';
import type { CitationChip } from './citationLabel';
import { phaseText } from './phaseLabels';
import { tierLabel, type TierMap } from './tiers';
import { formatDurationMs, visibleTools } from './toolDisplay';
import type { ChatMessage, KbSource, PhaseTrailEntry } from './types';

const TOKEN_NOUNS: Readonly<Record<string, { i18nKey: string; en: string }>> = {
    restore: { i18nKey: 'mobile.chat.tok_noun_restored', en: 'restored' },
    protected: { i18nKey: 'mobile.chat.tok_noun_protected', en: 'protected' },
    redacted: { i18nKey: 'mobile.chat.tok_noun_redacted', en: 'redacted' },
};

function toolsPill(message: ChatMessage, t: TranslateFn): string | null {
    const tools = visibleTools(message.tools);
    if (tools.length === 0) return null;
    const ms = tools.reduce((sum, tool) => sum + (tool.endTime && tool.startTime ? tool.endTime - tool.startTime : 0), 0);
    const count =
        tools.length === 1 ? t('chat.msg.n_tools', '1 tool') : t('chat.msg.n_tools_plural', '{count} tools', { count: tools.length });
    return ms > 0 ? `${count}${t('chat.msg.tools_seconds', ' · {seconds}s', { seconds: (ms / 1000).toFixed(1) })}` : count;
}

/** "1 document", "3 documents". */
function documentsPhrase(count: number, t: TranslateFn): string {
    return count === 1 ? t('chat.msg.kb_doc_count', '1 document', { count }) : t('chat.msg.kb_doc_count_plural', '{count} documents', { count });
}

function tierPill(message: ChatMessage, tiers: TierMap | undefined, t: TranslateFn): string | null {
    if (message.autoSelectedTier) {
        return t('chat.msg.auto_picked', 'Auto → {tier}', { tier: tierLabel(message.autoSelectedTier, tiers?.[message.autoSelectedTier]) });
    }
    return message.modelTier ? tierLabel(message.modelTier, tiers?.[message.modelTier]) : null;
}

/** The pills on the line, in the web's order: tools, documents, tier, what the shield replaced. */
export function traceSummary(
    message: ChatMessage,
    { showSources, tiers, t }: { showSources: boolean; tiers?: TierMap; t: TranslateFn },
): string[] {
    const documents = showSources ? documentCountOf(message.sources ?? []) : 0;
    const replaced = message.tokenisation?.count ?? 0;
    const noun = TOKEN_NOUNS[message.tokenisation?.action ?? ''] ?? (TOKEN_NOUNS.redacted as { i18nKey: string; en: string });
    return [
        toolsPill(message, t),
        documents > 0 ? documentsPhrase(documents, t) : null,
        tierPill(message, tiers, t),
        replaced > 0 ? `🔒 ${replaced} ${t(noun.i18nKey, noun.en)}` : null,
    ].filter((pill): pill is string => Boolean(pill));
}

/** The sources' heading: "10 sources from 3 documents", a source being one passage. */
export function sourcesHeading(sources: readonly KbSource[], t: TranslateFn): string {
    const count = sources.length;
    const docs = documentsPhrase(documentCountOf(sources), t);
    return count === 1
        ? t('chat.msg.kb_chunks_from_docs', '1 source from {docs}', { count, docs })
        : t('chat.msg.kb_chunks_from_docs_plural', '{count} sources from {docs}', { count, docs });
}

/** One document in the sources, and the passages of it the answer cited. */
export interface TraceDocument {
    key: string;
    /**
     * What the document is named by: its first passage, as on the web, with
     * `passageCount` when it stands for several (so chipLabel leaves out the
     * page of one passage) and "Unknown Source" for a missing title.
     */
    head: CitationChip;
    /** Every passage, in retrieval order. */
    passages: KbSource[];
}

/** The sources grouped by document, in the order each document first appears. */
export function traceDocuments(sources: readonly KbSource[], t: TranslateFn): TraceDocument[] {
    return groupByDocument(sources).map(({ key, passages }) => {
        const first = passages[0] as KbSource;
        const title = first.title || t('chat.msg.kb_unknown_source', 'Unknown Source');
        const head: CitationChip = passages.length > 1 ? { ...first, title, passageCount: passages.length } : { ...first, title };
        return { key, head, passages };
    });
}

/** Where one passage of a document sits: its heading, or "Chunk 2" without one, and its page. */
export function passagePlace(source: KbSource, index: number, t: TranslateFn): string {
    const section = source.section?.trim() || t('chat.msg.kb_chunk_n', 'Chunk {n}', { n: index + 1 });
    const page = typeof source.page === 'number' && Number.isInteger(source.page) && source.page > 0 ? source.page : null;
    return page ? `${section} · ${t('chat.msg.kb_page', 'p. {page}', { page })}` : section;
}

export interface TraceStep {
    key: string;
    label: string;
    duration: string | null;
}

/** The server's steps, in order, each with how long it took when that was measured. */
export function traceSteps(trail: readonly PhaseTrailEntry[] | undefined, t: TranslateFn): TraceStep[] {
    return (trail ?? []).map((entry, index) => ({
        key: `${entry.stage}-${index}`,
        label: phaseText(entry.stage, entry.detail, t),
        duration: formatDurationMs(entry.durationMs),
    }));
}
