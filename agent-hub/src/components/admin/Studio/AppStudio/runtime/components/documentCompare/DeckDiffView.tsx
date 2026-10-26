// Two presentations compared slide by slide: a strip of the slides (added,
// removed, changed or the same), and for the chosen slide both rendered side
// by side (each deck in its own sandboxed frame, scrolled to that slide) with
// the slide's text diff underneath. A change of look (another template, other
// colours) is listed above, because it changes every slide at once.

import { useEffect, useMemo, useState } from 'react';
import type { DeckCompare, DiffLine, SlidePair } from '../../../../../../../api/queries/studioAppDocuments';
import useTranslation from '../../../../../../../hooks/useTranslation';
import { DiffWords, DELETE_BLOCK_CLASS, INSERT_BLOCK_CLASS, MODIFY_BLOCK_CLASS } from '../../../../../../versions/DiffBlockView';
import type { CompareMode } from './CompareToolbar';
import DocumentFrame from './DocumentFrame';
import { lookLabel, lookValue, type TFn } from './summary';
import { nextIndex, type RegisterStep } from './useStepper';

const BADGE: Record<SlidePair['op'], string> = {
    equal: 'text-[var(--text-muted)]',
    changed: 'bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-[var(--text-primary)]',
    added: 'bg-[color-mix(in_srgb,var(--success)_18%,transparent)] text-[var(--success-ink)]',
    removed: 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)]',
};

function opLabel(t: TFn, op: SlidePair['op']): string {
    if (op === 'changed') return t('studio_app_documents.op_changed', 'Changed');
    if (op === 'added') return t('studio_app_documents.op_added', 'Added');
    if (op === 'removed') return t('studio_app_documents.op_removed', 'Removed');
    return t('studio_app_documents.op_same', 'Same');
}

/** The slide number a person reads: the right deck's, else the left's (the cover is 0). */
function slideNumber(p: SlidePair): number {
    return (p.right ?? p.left)?.index ?? 0;
}

function slideTitle(t: TFn, p: SlidePair): string {
    const head = p.right ?? p.left;
    if (!head) return '';
    if (head.index === 0) return head.title || t('studio_app_documents.cover', 'Cover');
    return head.title || t('studio_app_documents.untitled_slide', 'Slide {n}', { n: head.index });
}

function Line({ line, show }: { line: DiffLine; show: 'both' | 'before' | 'after' }) {
    const text = (v?: string) => <span className="whitespace-pre-wrap">{v}</span>;
    if (line.op === 'equal') return <p className="m-0 px-2 py-0.5">{text(show === 'before' ? line.before : line.after)}</p>;
    if (line.op === 'insert') return show === 'before' ? null : <ins className={`block px-2 py-0.5 no-underline ${INSERT_BLOCK_CLASS}`} data-line="insert">{text(line.after)}</ins>;
    if (line.op === 'delete') return show === 'after' ? null : <del className={`block px-2 py-0.5 ${DELETE_BLOCK_CLASS}`} data-line="delete">{text(line.before)}</del>;
    return <p className={`m-0 px-2 py-0.5 ${MODIFY_BLOCK_CLASS}`} data-line="modify"><DiffWords words={line.words || []} show={show} /></p>;
}

function SlideText({ pair, mode }: { pair: SlidePair; mode: CompareMode }) {
    const { t } = useTranslation();
    if (!pair.lines.length) return <p className="m-0 p-3 text-xs text-[var(--text-muted)]">{t('studio_app_documents.slide_no_text', 'This slide has no text.')}</p>;
    return (
        <div className="p-3 text-[13px] leading-relaxed text-[var(--text-primary)]" data-slide-text="true">
            {pair.layoutChanged ? <p className="m-0 mb-1 text-xs text-[var(--text-secondary)]">{t('studio_app_documents.layout_changed', 'The slide layout changed.')}</p> : null}
            {mode === 'side' ? (
                <div className="grid grid-cols-2 gap-3">
                    <div>{pair.lines.map((l, i) => <Line key={i} line={l} show="before" />)}</div>
                    <div>{pair.lines.map((l, i) => <Line key={i} line={l} show="after" />)}</div>
                </div>
            ) : pair.lines.map((l, i) => <Line key={i} line={l} show="both" />)}
        </div>
    );
}

function LookChanges({ result }: { result: DeckCompare }) {
    const { t } = useTranslation();
    if (!result.look.length) return null;
    return (
        <div className="shrink-0 border-b border-[var(--border-default)] px-3 py-2 text-xs text-[var(--text-secondary)]" data-look-changes={result.look.length}>
            <span className="font-medium text-[var(--text-primary)]">{t('studio_app_documents.look_title', 'Look')}: </span>
            {result.look.map((c, i) => (
                <span key={c.key}>{i ? ' · ' : ''}{lookLabel(t, c.key)} <del className="text-[var(--error-ink)]">{lookValue(t, c, 'before')}</del> → <ins className="no-underline text-[var(--success-ink)]">{lookValue(t, c, 'after')}</ins></span>
            ))}
        </div>
    );
}

function SlidePane({ html, label, index, missing }: { html: string | null | undefined; label: string; index: number | null; missing: string }) {
    return (
        <div className="relative min-h-0 min-w-0 flex-1 bg-[var(--bg-tertiary)]">
            <span className="pointer-events-none absolute left-2 top-1.5 z-10 max-w-[60%] truncate rounded bg-[var(--bg-primary)]/90 px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] shadow-sm">{label}</span>
            {index === null || !html
                ? <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[var(--text-muted)]">{index === null ? missing : ''}</div>
                : <DocumentFrame html={html} title={label} slide={index} />}
        </div>
    );
}

export default function DeckDiffView({ result, leftHtml, rightHtml, mode, onlyChanges, leftLabel, rightLabel, registerStep }: {
    result: DeckCompare; leftHtml?: string | null; rightHtml?: string | null; mode: CompareMode; onlyChanges: boolean;
    leftLabel: string; rightLabel: string; registerStep: RegisterStep;
}) {
    const { t } = useTranslation();
    const firstChange = Math.max(0, result.slides.findIndex((s) => s.op !== 'equal'));
    // A new compare remounts this view (its parent keys it), so the first change is the start.
    const [selected, setSelected] = useState(firstChange);
    const changed = useMemo(() => result.slides.map((s, i) => (s.op !== 'equal' ? i : -1)).filter((i) => i >= 0), [result]);
    useEffect(() => {
        registerStep((dir) => {
            const at = changed.indexOf(selected);
            const i = nextIndex(changed.length, at, dir);
            if (i >= 0) setSelected(changed[i]);
        });
        return () => registerStep(null);
    }, [changed, selected, registerStep]);
    const visible = result.slides.map((s, i) => ({ s, i })).filter(({ s, i }) => !onlyChanges || s.op !== 'equal' || i === selected);
    const pair = result.slides[Math.min(selected, result.slides.length - 1)];
    if (!pair) return null;
    const missing = (side: string) => t('studio_app_documents.slide_missing', 'Not in {side}', { side });
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <LookChanges result={result} />
            <div className="flex min-h-0 flex-1">
                <nav className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--border-default)] p-1.5" aria-label={t('studio_app_documents.slides', 'Slides')}>
                    {visible.length ? visible.map(({ s, i }) => (
                        <button key={i} type="button" onClick={() => setSelected(i)} aria-current={i === selected ? 'true' : undefined} data-slide-op={s.op}
                            className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs ${i === selected ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}>
                            <span className="w-5 shrink-0 text-right tabular-nums text-[11px] text-[var(--text-muted)]">{slideNumber(s)}</span>
                            <span className="min-w-0 flex-1 truncate">{slideTitle(t, s)}</span>
                            <span className={`shrink-0 rounded px-1 text-[10.5px] ${BADGE[s.op]}`}>{opLabel(t, s.op)}</span>
                        </button>
                    )) : <p className="m-0 p-2 text-xs text-[var(--text-muted)]">{t('studio_app_documents.slides_same', 'Every slide is the same.')}</p>}
                </nav>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
                    {mode === 'side' ? (
                        <div className="flex h-64 shrink-0 gap-px border-b border-[var(--border-default)] bg-[var(--border-default)]">
                            <SlidePane html={leftHtml} label={leftLabel} index={pair.left ? pair.left.index : null} missing={missing(leftLabel)} />
                            <SlidePane html={rightHtml} label={rightLabel} index={pair.right ? pair.right.index : null} missing={missing(rightLabel)} />
                        </div>
                    ) : null}
                    <SlideText pair={pair} mode={mode} />
                </div>
            </div>
        </div>
    );
}
