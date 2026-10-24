import { Loader2, MessageCircleQuestion, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { knowledgeApi } from './knowledgeApi';
import useTranslation from '../../../../hooks/useTranslation';
import type { TranslateParams } from '../../../../hooks/useTranslation';
import CitationChips from '../../../../pages/documents/notebook/CitationChips';
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
interface PassageSource {
    title: string;
    kind: string;
    documentId: string;
    chunkId: number;
    page: number;
    section: string;
    content: string;
    score: number;
    index: number;
    sourceName?: string;
    linked?: { kind: string; column?: string; table: string; title?: string; count?: number; shown?: number; }[] | null;
}

interface TestQuestionCardProps {
    kbId?: string | null;
    disabled?: boolean;
}

export default function TestQuestionCard({ kbId = null, disabled = false }: TestQuestionCardProps) {
    const { t } = useTranslation();
    const [question, setQuestion] = useState('');
    const [answer, setAnswer] = useState('');
    const [sources, setSources] = useState<PassageSource[] | null>(null);   // null = never asked
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [openPassages, setOpenPassages] = useState(false);
    const [openCitation, setOpenCitation] = useState<PassageSource | null>(null);
    const abortRef = useRef<AbortController>(null);

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
                onEvent: (name: string, raw: unknown) => {
                    const payload = raw as { sources?: PassageSource[]; text?: string; error?: string } | null;
                    if (name === 'kb_sources') setSources(payload?.sources || []);
                    else if (name === 'text' && payload?.text) setAnswer(prev => prev + payload.text);
                    else if (name === 'error') setError(payload?.error || t('knowledge.ask.err', 'Something went wrong while answering.'));
                },
            });
        } catch (e) {
            if ((e as Error)?.name !== 'AbortError') {
                setError((e as Error)?.message || t('knowledge.ask.err', 'Something went wrong while answering.'));
            }
        } finally {
            if (abortRef.current === controller) setBusy(false);
        }
    }, [question, kbId, t]);

    const ready = !!kbId && !disabled;
    const askedAndEmpty = sources !== null && sources.length === 0;

    return (
        <div
            className="flex flex-col gap-2 px-3.5 py-3 text-[12px] [border-radius:12px] [background:var(--bg-card)] [border:1px_solid_var(--border-default)] [box-shadow:var(--shadow-sm)]"
            data-testid="kb-test-question"
        >
            <div className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
                <MessageCircleQuestion className="w-3.5 h-3.5 [color:var(--type-ai)]" aria-hidden="true" />
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
                    className="flex-1 min-w-0 px-2.5 py-2 rounded-lg text-xs border disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 [background:var(--bg-card)] [border-color:var(--border-default)] [color:var(--text-primary)]! [outline-color:var(--accent-primary)]!"
                />
                <button
                    type="submit"
                    disabled={!ready || busy || !question.trim()}
                    data-testid="kb-ask-submit"
                    className="px-2.5 rounded-lg text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [background:var(--accent-primary)] [color:var(--accent-primary-fg)]! [outline-color:var(--accent-primary)]!"
                >
                    {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                    {t('knowledge.ask.submit', 'Ask')}
                </button>
            </form>

            {error && (
                <p role="alert" className="[color:var(--error)] [font-size:11px]">{error}</p>
            )}

            {/* The citations, the moment they land — before the answer. */}
            {sources !== null && sources.length > 0 && (
                <CitationChips sources={sources} t={t} onCitationClick={setOpenCitation} />
            )}

            {/* Nothing found is an answer, drawn as one. */}
            {askedAndEmpty && !busy && !error && (
                <p data-testid="kb-ask-empty" className="[color:var(--text-secondary)] [font-size:11px]">
                    {t('knowledge.ask.nothing_found', 'Nothing in this knowledge base matched that question. That is a result: the sources here do not cover it yet.')}
                </p>
            )}

            {answer && (
                <div
                    data-testid="kb-ask-answer"
                    aria-live="polite"
                    className="whitespace-pre-wrap [color:var(--text-primary)] [font-size:12px] [line-height:1.5]"
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
                    <summary className="cursor-pointer [color:var(--text-tertiary)] [font-size:11px]">
                        {t('knowledge.ask.passages', 'Passages found ({n})', { n: sources.length })}
                    </summary>
                    <ul className="flex flex-col gap-2 mt-2">
                        {sources.map((s, i) => (
                            <PassageRow key={s.chunkId ?? i} source={s} best={sources[0]?.score || 0} t={t} />
                        ))}
                    </ul>
                </details>
            )}

            <p className="[color:var(--text-tertiary)] [font-size:11px]">
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
interface PassageRowProps {
    source: PassageSource;
    best: string | number | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

function PassageRow({ source, best, t }: PassageRowProps) {
    const page = Number.isInteger(source.page) && source.page > 0 ? source.page : null;
    const linked = linkedSummary(source.linked);
    return (
        <li className="flex flex-col gap-1" data-testid="kb-ask-passage">
            <div className="flex items-baseline gap-1.5 min-w-0">
                <span className="truncate font-medium [color:var(--text-primary)] [font-size:11px]">
                    {source.title}
                </span>
                {page && (
                    <span className="[color:var(--text-tertiary)] [font-size:10px]">
                        {t('notebooks.page_short', 'p. {n}', { n: page })}
                    </span>
                )}
                {source.sourceName && (
                    <span className="truncate [color:var(--text-tertiary)] [font-size:10px]">· {source.sourceName}</span>
                )}
            </div>
            <RelevanceBar score={source.score} best={best} />
            <p className="line-clamp-2 [color:var(--text-secondary)] [font-size:10px]">
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
function linkedSummary(linked: { kind: string; column?: string; table: string; title?: string; count?: number; shown?: number }[] | null | undefined) {
    if (!Array.isArray(linked) || linked.length === 0) return null;
    const items = linked.map((l) => {
        if (l?.kind === 'row') return `${l.column ? `${l.column} → ` : ''}${l.title || l.table || ''}`.trim();
        if (l?.kind === 'rows') return `${l.table || ''} (${Number(l.count) || 0})`.trim();
        return null;
    }).filter(Boolean);
    return items.length ? items.join(' · ') : null;
}

/** The clicked passage, in full. Inline rather than a modal: it is small. */
interface CitationPanelProps {
    source: PassageSource;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    onClose: () => void;
}

function CitationPanel({ source, t, onClose }: CitationPanelProps) {
    const page = Number.isInteger(source.page) && source.page > 0 ? source.page : null;
    return (
        <div
            data-testid="kb-ask-citation"
            className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]"
        >
            <div className="flex items-start gap-2">
                <span className="font-medium min-w-0 truncate [color:var(--text-primary)] [font-size:11px]">
                    {source.title}{page ? ` · ${t('notebooks.page_short', 'p. {n}', { n: page })}` : ''}
                </span>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('knowledge.ask.close_passage', 'Close passage')}
                    className="ml-auto shrink-0 rounded focus-visible:outline focus-visible:outline-2 [color:var(--text-tertiary)] [outline-color:var(--accent-primary)]!"
                >
                    <X className="w-3 h-3" aria-hidden="true" />
                </button>
            </div>
            {source.section && (
                <span className="[color:var(--text-tertiary)] [font-size:10px]">{source.section}</span>
            )}
            <p className="whitespace-pre-wrap [color:var(--text-secondary)] [font-size:11px] max-h-[240px] [overflow-y:auto]">
                {source.content || t('knowledge.ask.no_passage', 'This passage is no longer available.')}
            </p>
        </div>
    );
}
