import {
    Ban, MessageSquareReply, MoreHorizontal, Sparkles, TriangleAlert, User,
} from 'lucide-react';
import React, { useId, useRef, useState } from 'react';

import Button from '../../../../../../shared/Button';
import { buildRuns } from '../../../../../../chat/dlpReview/dlpFindingsState';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { selectionOffsetsIn } from '../../../../../../../utils/textSelection';
import { falseAlarmsLine } from '../ownDataCopy';
import type { Sentence, SentenceOrigin, Span } from '../ownDataModel';
import type { Mark, MarkKind, RunSpan } from '../testBench';
import {
    addGold, isMarked, markAllOccurrences, removeGold, sentenceVerdict, toRunSpans,
} from '../testBench';
import { Note } from '../ui';
import { inputClass } from './fieldStyles';

/**
 * One test sentence, with what should be hidden in it and, after a test,
 * what was found.
 *
 * Three ways to mark text, because one is not enough for everyone: select
 * it with the mouse, click an existing mark to change it, or (keyboard and
 * touch) type the exact text under "Mark what should be hidden…", which
 * marks every occurrence. Every choice lands in an inline bar under the
 * sentence rather than a floating popover, so it needs no positioning and
 * reads in order for a screen reader.
 */

type DisplayKind = MarkKind | 'gold';
type Pending = { kind: 'selection'; span: Span } | { kind: 'mark'; mark: RunSpan } | null;

const MARK_CLASS: Record<DisplayKind, string> = {
    gold: 'border-b-2 border-dashed border-[var(--text-tertiary)] bg-[var(--bg-tertiary)]',
    hit: 'bg-[color-mix(in_srgb,var(--success)_22%,transparent)] text-[var(--success-ink)]',
    missed: 'border-b-2 border-dashed border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--text-primary)]',
    false_alarm: 'line-through decoration-2 bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)]',
    found: 'bg-[color-mix(in_srgb,var(--info)_20%,transparent)] text-[var(--text-primary)]',
};

function markLabel(kind: DisplayKind, text: string, t: TranslateFn): string {
    switch (kind) {
    case 'gold': return t('shield_data.mark_gold', 'Should be hidden: {text}', { text });
    case 'hit': return t('shield_data.mark_hit', 'Found: {text}', { text });
    case 'missed': return t('shield_data.mark_missed', 'Missed: {text}', { text });
    case 'false_alarm': return t('shield_data.mark_false_alarm', 'False alarm: {text}', { text });
    default: return t('shield_data.mark_found', 'Would be hidden: {text}', { text });
    }
}

/** The sentence as runs of plain text and marks. Marks are buttons only when `onMark` is given. */
export function MarkedText({
    text, marks, onMark, onMouseUp, textRef, t,
}: {
    text: string;
    marks: (Mark | (Span & { kind: 'gold' }))[];
    onMark?: (mark: RunSpan) => void;
    onMouseUp?: () => void;
    textRef?: React.Ref<HTMLParagraphElement>;
    t: TranslateFn;
}) {
    const runs = buildRuns(text, toRunSpans(marks)) as ({ type: 'text'; value: string } | (RunSpan & { type: 'span'; value: string }))[];
    return (
        <p ref={textRef} onMouseUp={onMouseUp} className="m-0 text-sm leading-relaxed whitespace-pre-wrap break-words select-text text-[var(--text-primary)]">
            {runs.map((r, i) => {
                if (r.type === 'text') return <span key={`t${i}`}>{r.value}</span>;
                const interactive = !!onMark;
                return (
                    <mark
                        key={`m${r.offset}`}
                        role={interactive ? 'button' : undefined}
                        tabIndex={interactive ? 0 : undefined}
                        aria-label={markLabel(r.kind, r.value, t)}
                        onClick={interactive ? () => onMark(r) : undefined}
                        onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMark(r); } } : undefined}
                        className={`rounded px-0.5 ${interactive ? 'cursor-pointer' : ''} ${MARK_CLASS[r.kind]}`}
                    >
                        {r.value}
                    </mark>
                );
            })}
        </p>
    );
}

const ORIGIN: Record<SentenceOrigin, { Icon: typeof Sparkles; key: string; fallback: string }> = {
    assistant: { Icon: Sparkles, key: 'shield_data.origin_assistant', fallback: 'Written by the assistant' },
    nearmiss: { Icon: Ban, key: 'shield_data.origin_nearmiss', fallback: 'Should find nothing' },
    own: { Icon: User, key: 'shield_data.origin_own', fallback: 'Written by you' },
    feedback: { Icon: MessageSquareReply, key: 'shield_data.origin_feedback', fallback: 'Added from a try' },
};

function OriginIcon({ origin, t }: { origin: SentenceOrigin; t: TranslateFn }) {
    const o = ORIGIN[origin] || ORIGIN.own;
    const label = t(o.key, o.fallback);
    return (
        <span title={label} className="inline-flex shrink-0 mt-0.5 text-[var(--text-tertiary)]">
            <o.Icon className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="sr-only">{label}</span>
        </span>
    );
}

/** The matcher only ran partly, so a result may be incomplete. */
export function DegradedNote({ t }: { t: TranslateFn }) {
    return (
        <Note Icon={TriangleAlert} tone="warn" role="status">
            {t('shield_data.test_degraded', 'Part of the check could not run, so this result may be incomplete. Try again in a moment.')}
        </Note>
    );
}

/** Before anything is marked there is nothing to be right or wrong about; say so instead of "Correct". */
function UnmarkedChip({ t }: { t: TranslateFn }) {
    return (
        <span className="text-[10px] px-1.5 py-px rounded-full whitespace-nowrap border border-[var(--border-default)] text-[var(--text-tertiary)]">
            {t('shield_data.chip_unmarked', 'Not marked')}
        </span>
    );
}

export function VerdictChip({ marks, t }: { marks: Mark[]; t: TranslateFn }) {
    const { verdict, missed, falseAlarms } = sentenceVerdict(marks);
    const text = verdict === 'correct'
        ? t('shield_data.chip_correct', 'Correct')
        : [
            missed ? t('shield_data.chip_missed', 'Missed {n}', { n: missed }) : '',
            falseAlarms ? falseAlarmsLine(falseAlarms, t) : '',
        ].filter(Boolean).join(' · ');
    const tone = verdict === 'correct' ? 'text-[var(--success-ink)] border-[var(--success)]' : 'text-[var(--warning-ink)] border-[var(--warning)]';
    return <span className={`text-[10px] px-1.5 py-px rounded-full whitespace-nowrap border ${tone}`}>{text}</span>;
}

function ActionBar({
    pending, text, onApply, onClose, t,
}: { pending: NonNullable<Pending>; text: string; onApply: (choice: 'hide' | 'unhide' | 'none') => void; onClose: () => void; t: TranslateFn }) {
    const span = pending.kind === 'selection' ? pending.span : pending.mark;
    const quoted = text.slice(span.start, span.end);
    const kind = pending.kind === 'selection' ? 'selection' : pending.mark.kind;
    let buttons: { label: string; choice: 'hide' | 'unhide' | 'none' }[];
    if (kind === 'selection') buttons = [{ label: t('shield_data.act_should_hide', 'Should be hidden'), choice: 'hide' }];
    else if (kind === 'gold') buttons = [{ label: t('shield_data.act_not_this', 'Not this'), choice: 'unhide' }];
    else if (kind === 'missed') buttons = [{ label: t('shield_data.act_not_hidden', 'It should not be hidden'), choice: 'unhide' }];
    else {
        buttons = [
            { label: t('shield_data.act_right', 'Right, hide this'), choice: kind === 'hit' ? 'none' : 'hide' },
            // On an unmarked sentence "wrong" is a decision too: it becomes
            // "nothing should be hidden here" (gold []), so the find now
            // counts as a false alarm.
            { label: t('shield_data.act_wrong', 'Wrong, leave this'), choice: kind === 'false_alarm' ? 'none' : 'unhide' },
        ];
    }
    return (
        <div role="group" aria-label={t('shield_data.act_group', 'About “{text}”', { text: quoted })} className="flex items-center gap-2 flex-wrap mt-2">
            <span className="text-[11px] text-[var(--text-secondary)]">“{quoted}”</span>
            {buttons.map(b => <Button key={b.label} size="sm" variant="secondary" onClick={() => onApply(b.choice)}>{b.label}</Button>)}
            <Button size="sm" variant="ghost" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
        </div>
    );
}

function TypeToMark({ sentence, onDone, onClose, t }: { sentence: Sentence; onDone: (s: Sentence) => void; onClose: () => void; t: TranslateFn }) {
    const [value, setValue] = useState('');
    const [error, setError] = useState<string | null>(null);
    const id = useId();
    const submit = () => {
        const res = markAllOccurrences(sentence, value);
        if (res.count === 0) { setError(t('shield_data.type_not_found', 'That text is not in this sentence. Type it exactly as it appears.')); return; }
        if (res.capped) { setError(t('shield_data.gold_capped', 'A sentence can have at most 5 marks.')); return; }
        onDone(res.sentence);
    };
    return (
        <div className="mt-2 flex flex-col gap-1.5 max-w-md">
            <label htmlFor={id} className="text-[11px] font-semibold text-[var(--text-primary)]">{t('shield_data.type_label', 'Type the exact text that should be hidden')}</label>
            <span className="flex gap-2">
                <input
                    id={id}
                    type="text"
                    value={value}
                    onChange={e => { setValue(e.target.value); setError(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                    className={`${inputClass} text-xs py-1.5`}
                />
                <Button size="sm" onClick={submit} disabled={!value.trim()}>{t('shield_data.type_mark', 'Mark it')}</Button>
                <Button size="sm" variant="ghost" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
            </span>
            {error && <p role="alert" className="m-0 text-[11px] text-[var(--error-ink)]">{error}</p>}
        </div>
    );
}

function applyChoice(sentence: Sentence, pending: NonNullable<Pending>, choice: 'hide' | 'unhide' | 'none'): { sentence: Sentence; capped: boolean } {
    const span = pending.kind === 'selection' ? pending.span : { start: pending.mark.start, end: pending.mark.end };
    if (choice === 'hide') return addGold(sentence, span);
    if (choice === 'unhide') return { sentence: removeGold(sentence, span), capped: false };
    return { sentence, capped: false };
}

function RowMenu({
    open, onToggle, onType, onNothing, onRemove, t,
}: { open: boolean; onToggle: () => void; onType: () => void; onNothing: (() => void) | null; onRemove: () => void; t: TranslateFn }) {
    return (
        <span className="ml-auto flex items-center gap-1 shrink-0 flex-wrap justify-end">
            {open && (
                <>
                    <Button size="sm" variant="ghost" onClick={onType}>{t('shield_data.menu_mark', 'Mark what should be hidden…')}</Button>
                    {onNothing && <Button size="sm" variant="ghost" onClick={onNothing}>{t('shield_data.menu_nothing', 'Nothing should be hidden here')}</Button>}
                    <Button size="sm" variant="ghost" onClick={onRemove}>{t('shield_data.menu_remove', 'Remove this sentence')}</Button>
                </>
            )}
            <button
                type="button"
                aria-expanded={open}
                aria-label={t('shield_data.menu_label', 'More for this sentence')}
                onClick={onToggle}
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]"
            >
                <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
            </button>
        </span>
    );
}

export function TestSentence({
    sentence, marks, onChange, onRemove, t,
}: { sentence: Sentence; marks: Mark[] | null; onChange: (s: Sentence) => void; onRemove: () => void; t: TranslateFn }) {
    const [pending, setPending] = useState<Pending>(null);
    const [menu, setMenu] = useState(false);
    const [typing, setTyping] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const textRef = useRef<HTMLParagraphElement>(null);
    const shown = marks ?? (sentence.gold || []).map(g => ({ ...g, kind: 'gold' as const }));
    const alreadyNothing = isMarked(sentence) && (sentence.gold || []).length === 0;

    const onMouseUp = () => {
        const span = selectionOffsetsIn(textRef.current);
        if (span) { setPending({ kind: 'selection', span }); setError(null); }
    };
    const apply = (choice: 'hide' | 'unhide' | 'none') => {
        if (!pending) return;
        const res = applyChoice(sentence, pending, choice);
        if (res.capped) { setError(t('shield_data.gold_capped', 'A sentence can have at most 5 marks.')); return; }
        if (res.sentence !== sentence) onChange(res.sentence);
        setPending(null);
        window.getSelection()?.removeAllRanges();
    };

    return (
        <li className="px-3 py-2.5 border-t border-[var(--border-subtle)] first:border-t-0">
            <div className="flex items-start gap-2">
                <OriginIcon origin={sentence.origin} t={t} />
                <div className="min-w-0 flex-1">
                    <MarkedText text={sentence.text} marks={shown} onMark={m => setPending({ kind: 'mark', mark: m })} onMouseUp={onMouseUp} textRef={textRef} t={t} />
                </div>
                {isMarked(sentence) ? marks && <VerdictChip marks={marks} t={t} /> : <UnmarkedChip t={t} />}
                <RowMenu
                    open={menu}
                    onToggle={() => setMenu(v => !v)}
                    onType={() => { setTyping(true); setMenu(false); }}
                    onNothing={alreadyNothing ? null : () => { onChange({ ...sentence, gold: [] }); setMenu(false); }}
                    onRemove={onRemove}
                    t={t}
                />
            </div>
            {pending && <ActionBar pending={pending} text={sentence.text} onApply={apply} onClose={() => setPending(null)} t={t} />}
            {error && <p role="alert" className="m-0 mt-1 text-[11px] text-[var(--error-ink)]">{error}</p>}
            {typing && <TypeToMark sentence={sentence} onDone={s => { onChange(s); setTyping(false); }} onClose={() => setTyping(false)} t={t} />}
        </li>
    );
}

export default TestSentence;
