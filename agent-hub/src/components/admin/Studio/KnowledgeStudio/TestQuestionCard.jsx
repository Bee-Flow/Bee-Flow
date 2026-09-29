import { Loader2, MessageCircleQuestion, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { knowledgeApi } from './knowledgeApi';
import useTranslation from '../../../../hooks/useTranslation';
import CitationChips from '../../../../pages/notebooks/CitationChips';
import RelevanceBar from '../../../shared/RelevanceBar';

/**
 * "Testvraag" — ask this knowledge base something and see WHICH source
 * answered (Knowledge artboard 1a, right column).
 *
 * ── WHAT IT IS FOR, AND WHY THE SOURCES COME FIRST ──────────────────
 * The question a person is really asking is not "what is the answer" — they
 * usually know it. It is "did it find the right passage?", asked before an
 * agent starts answering customers out of this base. So the citations render
 * the moment they arrive, BEFORE the answer streams in: an answer that shows
 * up first invites reading it and believing it, which is the one thing this
 * screen exists to stop.
 *
 * ── NOTHING FOUND IS A RESULT ───────────────────────────────────────
 * "The sources do not cover this" is a successful test, not an error, and it
 * is drawn as an answer rather than as a failure. Somebody tuning their
 * sources needs to tell "the retrieval is broken" from "this base genuinely
 * has nothing about that", and an error banner conflates them.
 *
 * ── A SCORE IS RELATIVE, AND NEVER A PERCENTAGE ─────────────────────
 * The retriever's score is meaningful only against the other passages in the
 * same answer. Rendering "68%" invites a person to read it as confidence and
 * to set a threshold on it. The passages list draws a bar relative to the best
 * hit in that answer and prints no number at all.
 */
export default function TestQuestionCard({ kbId = null, disabled = false }) {
    const { t } = useTranslation();
    const [question, setQuestion] = useState('');
    const [answer, setAnswer] = useState('');
    const [sources, setSources] = useState(null);   // null = never asked
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [openPassages, setOpenPassages] = useState(false);
    const [openCitation, setOpenCitation] = useState(null);
    const abortRef = useRef(null);

    // A question asked while the previous answer is still arriving replaces
    // it, rather than interleaving two answers in one box.
    useEffect(() => () => abortRef.current?.abort(), []);

    const ask = useCallback(async () => {
        const q = question.trim();
        if (!q || !kbId) return;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        setBusy(true);
        setError(null);
        setAnswer('');
        setSources(null);
        setOpenCitation(null);
        try {
            await knowledgeApi.ask(kbId, q, {
                signal: controller.signal,
                onEvent: (name, payload) => {
                    if (name === 'kb_sources') setSources(payload?.sources || []);
                    else if (name === 'text' && payload?.text) setAnswer(prev => prev + payload.text);
                    else if (name === 'error') setError(payload?.error || t('knowledge.ask.err', 'Something went wrong while answering.'));
                },
            });
        } catch (e) {
            if (e?.name !== 'AbortError') {
                setError(e?.message || t('knowledge.ask.err', 'Something went wrong while answering.'));
            }
        } finally {
            if (abortRef.current === controller) setBusy(false);
        }
    }, [question, kbId, t]);

    const ready = !!kbId && !disabled;
    const askedAndEmpty = sources !== null && sources.length === 0;

    return (
        <div
            className="flex flex-col gap-2 px-3.5 py-3 text-[12px]"
            style={{ borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' }}
            data-testid="kb-test-question"
        >
            <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--text-primary)' }}>
                <MessageCircleQuestion className="w-3.5 h-3.5" style={{ color: 'var(--type-ai)' }} aria-hidden="true" />
                {t('knowledge.ask.title', 'Test question')}
            </div>

            <form
                onSubmit={(e) => { e.preventDefault(); ask(); }}
                className="flex gap-1.5"
            >
                <input
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    disabled={!ready || busy}
                    data-testid="kb-ask-input"
                    placeholder={t('knowledge.ask.placeholder', 'e.g. How long is a quote valid?')}
                    aria-label={t('knowledge.ask.label', 'Ask this knowledge base a question')}
                    className="flex-1 min-w-0 px-2.5 py-2 rounded-lg text-xs border disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}
                />
                <button
                    type="submit"
                    disabled={!ready || busy || !question.trim()}
                    data-testid="kb-ask-submit"
                    className="px-2.5 rounded-lg text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)', outlineColor: 'var(--accent-primary)' }}
                >
                    {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                    {t('knowledge.ask.submit', 'Ask')}
                </button>
            </form>

            {error && (
                <p role="alert" style={{ color: 'var(--error)', fontSize: 11 }}>{error}</p>
            )}

            {/* The citations, the moment they land — before the answer. */}
            {sources !== null && sources.length > 0 && (
                <CitationChips sources={sources} t={t} onCitationClick={setOpenCitation} />
            )}

            {/* Nothing found is an answer, drawn as one. */}
            {askedAndEmpty && !busy && !error && (
                <p data-testid="kb-ask-empty" style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                    {t('knowledge.ask.nothing_found', 'Nothing in this knowledge base matched that question. That is a result: the sources here do not cover it yet.')}
                </p>
            )}

            {answer && (
                <div
                    data-testid="kb-ask-answer"
                    aria-live="polite"
                    className="whitespace-pre-wrap"
                    style={{ color: 'var(--text-primary)', fontSize: 12, lineHeight: 1.5 }}
                >
                    {answer}
                </div>
            )}

            {/* The honest second layer: what was actually retrieved, and how
                the passages ranked against EACH OTHER. Collapsed, because it
                is for the moment the answer looks wrong. */}
            {sources !== null && sources.length > 0 && (
                <details
                    open={openPassages}
                    onToggle={(e) => setOpenPassages(e.currentTarget.open)}
                    data-testid="kb-ask-passages"
                >
                    <summary className="cursor-pointer" style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                        {t('knowledge.ask.passages', 'Passages found ({n})', { n: sources.length })}
                    </summary>
                    <ul className="flex flex-col gap-2 mt-2">
                        {sources.map((s, i) => (
                            <PassageRow key={s.chunkId ?? i} source={s} best={sources[0]?.score || 0} t={t} />
                        ))}
                    </ul>
                </details>
            )}

            <p style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                {t('knowledge.ask.hint', 'This is how you check the right source is found, before an agent uses it.')}
            </p>

            {openCitation && (
                <CitationPanel source={openCitation} t={t} onClose={() => setOpenCitation(null)} />
            )}
        </div>
    );
}

/**
 * One retrieved passage: where it came from, how it ranked against the OTHERS
 * in this answer, and its opening line.
 *
 * The bar is relative to the best hit in the same answer and carries no
 * number. A retriever's score has no absolute meaning — printing "68%" invites
 * reading it as confidence, and then setting a threshold on it.
 */
function PassageRow({ source, best, t }) {
    const page = Number.isInteger(source.page) && source.page > 0 ? source.page : null;
    const linked = linkedSummary(source.linked);
    return (
        <li className="flex flex-col gap-1" data-testid="kb-ask-passage">
            <div className="flex items-baseline gap-1.5 min-w-0">
                <span className="truncate font-medium" style={{ color: 'var(--text-primary)', fontSize: 11 }}>
                    {source.title}
                </span>
                {page && (
                    <span style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>
                        {t('notebooks.page_short', 'p. {n}', { n: page })}
                    </span>
                )}
                {source.sourceName && (
                    <span className="truncate" style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>· {source.sourceName}</span>
                )}
            </div>
            <RelevanceBar score={source.score} best={best} />
            <p className="line-clamp-2" style={{ color: 'var(--text-secondary)', fontSize: 10 }}>
                {(source.content || '').replace(/^#{1,6}\s+/gm, '').trim().slice(0, 180)}
            </p>
            {linked && (
                <p className="truncate text-[10px] text-[var(--text-tertiary)]" data-testid="kb-ask-linked">
                    {t('knowledge.ask.linked', 'Linked rows: {items}', { items: linked })}
                </p>
            )}
        </li>
    );
}

/**
 * What a table-row passage pulled in along its relations, as one short line:
 * "supplier → Van Dijk · Orders (312)". A row the passage points at is named
 * by its column; rows pointing at the passage are counted by their table.
 */
function linkedSummary(linked) {
    if (!Array.isArray(linked) || linked.length === 0) return null;
    const items = linked.map((l) => {
        if (l?.kind === 'row') return `${l.column ? `${l.column} → ` : ''}${l.title || l.table || ''}`.trim();
        if (l?.kind === 'rows') return `${l.table || ''} (${Number(l.count) || 0})`.trim();
        return null;
    }).filter(Boolean);
    return items.length ? items.join(' · ') : null;
}

/** The clicked passage, in full. Inline rather than a modal: it is small. */
function CitationPanel({ source, t, onClose }) {
    const page = Number.isInteger(source.page) && source.page > 0 ? source.page : null;
    return (
        <div
            data-testid="kb-ask-citation"
            className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
        >
            <div className="flex items-start gap-2">
                <span className="font-medium min-w-0 truncate" style={{ color: 'var(--text-primary)', fontSize: 11 }}>
                    {source.title}{page ? ` · ${t('notebooks.page_short', 'p. {n}', { n: page })}` : ''}
                </span>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('knowledge.ask.close_passage', 'Close passage')}
                    className="ml-auto shrink-0 rounded focus-visible:outline focus-visible:outline-2"
                    style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}
                >
                    <X className="w-3 h-3" aria-hidden="true" />
                </button>
            </div>
            {source.section && (
                <span style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>{source.section}</span>
            )}
            <p className="whitespace-pre-wrap" style={{ color: 'var(--text-secondary)', fontSize: 11, maxHeight: 240, overflowY: 'auto' }}>
                {source.content || t('knowledge.ask.no_passage', 'This passage is no longer available.')}
            </p>
        </div>
    );
}
