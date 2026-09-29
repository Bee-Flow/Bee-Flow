import { groupByDocument } from './citationGroups';
import { whenLabel } from '../../../pages/notebooks/citationText';
import RelevanceBar from '../../shared/RelevanceBar';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';
import useTranslation from '../../../hooks/useTranslation';

/**
 * KB Sources — grouped per document, inside "How I got this answer".
 * Lifted verbatim out of MessageItem/index.jsx; the caller still owns the
 * `msg.kbSources?.length > 0` gate.
 *
 * The relevance used to render as `Math.round(score * 100) + '%'`. With no
 * reranker configured that score is an RRF fusion score — about 0.016 for a
 * good hit — so the best passage in a document showed "2%", and the bar, which
 * coloured on absolute thresholds, was grey for everything. See RelevanceBar.
 *
 * Grouped by document the same way as the chip row and the count pill
 * (citationGroups.ts), not by title alone: two meetings that share a title are
 * two documents, and their date is shown so they can be told apart (BFSF-352).
 */
const KbSourcesPanel = ({ msg, t: tProp }) => {
    const { t: tHook } = useTranslation();
    const t = tProp || tHook;
    const unknownTitle = t('chat.msg.kb_unknown_source', 'Unknown Source');
    const groups = groupByDocument(msg.kbSources);
    const docCount = groups.length;
    const chunkCount = msg.kbSources.length;
    return (
        <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider mb-2 px-1" style={{ color: 'var(--text-tertiary)' }}>
                {nOf(t, 'chat.msg.kb_chunks_from_docs', chunkCount,
                    '1 source from {docs}', '{count} sources from {docs}',
                    { docs: nOf(t, 'chat.msg.kb_doc_count', docCount, '1 document', '{count} documents') })}
            </div>
            <div className="space-y-1.5">
                {groups.map(({ key, passages: chunks }) => {
                    const docTitle = chunks[0]?.title || unknownTitle;
                    const when = whenLabel(chunks[0]);
                    return (
                        <details key={key} className="group/doc rounded-lg border transition-colors" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}>
                            <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-xs" style={{ color: 'var(--text-primary)' }}>
                                <span className="font-medium truncate max-w-[250px]">{docTitle}</span>
                                {when && (
                                    <span className="text-[10px] flex-shrink-0 text-[var(--text-tertiary)]" data-testid="kb-doc-when">{when}</span>
                                )}
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                                    📦 {nOf(t, 'chat.msg.kb_chunks', chunks.length, 'KB · 1 chunk', 'KB · {count} chunks')}
                                </span>
                                <svg className="w-3 h-3 transition-transform group-open/doc:rotate-90 ml-auto opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                            </summary>
                            <div className="px-2 pb-2 space-y-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                                {chunks.map((source, ci) => {
                                    const sectionLabel = source.section
                                        || t('chat.msg.kb_chunk_n', 'Chunk {n}', { n: ci + 1 });
                                    const page = Number.isInteger(source.page) && source.page > 0 ? source.page : null;
                                    const best = chunks[0]?.score || 0;
                                    return (
                                        <details key={ci} className="group/src rounded-lg border transition-colors mt-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}>
                                            <summary className="flex items-start gap-2 px-3 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-xs" style={{ color: 'var(--text-primary)' }}>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="font-medium text-[11px]">{sectionLabel}</span>
                                                        {page && (
                                                            <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{t('chat.msg.kb_page', 'p. {page}', { page })}</span>
                                                        )}
                                                    </div>
                                                    <RelevanceBar score={source.score} best={best} className="mt-1" />
                                                </div>
                                                <svg className="w-3 h-3 transition-transform group-open/src:rotate-90 opacity-40 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                            </summary>
                                            <div className="px-3 pb-3 pt-2 text-xs leading-relaxed whitespace-pre-wrap max-h-[300px] overflow-y-auto custom-scrollbar" style={{ color: 'var(--text-secondary)', borderTop: '1px solid var(--border-subtle)' }}>
                                                {source.content}
                                            </div>
                                        </details>
                                    );
                                })}
                            </div>
                        </details>
                    );
                })}
            </div>
        </div>
    );
};

export default KbSourcesPanel;
