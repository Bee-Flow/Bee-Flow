/**
 * What a fill-in form shows at one field besides the value itself.
 *
 * Next to the label, when people fill in together (`FieldActions`): two small
 * buttons, "Ask a colleague" and "Add a note".
 *
 * Under the input (`FieldBelow`):
 *   - the final check's remark: a better wording to take over or leave, or a
 *     doubt about the value with the reason;
 *   - who filled the field in, or who was asked for it;
 *   - the notes people left each other at this field, and the line to write
 *     a new one.
 */
import { useEffect, useRef, useState } from 'react';
import { AtSign, Hourglass, StickyNote, TriangleAlert, UserRoundCheck, WandSparkles, X } from 'lucide-react';

import type { FieldNote, FillFinding } from '@/api/templateFillTeamApi';
import useTranslation from '@/hooks/useTranslation';
import type { FieldHint } from './projectFillModel';

const CHIP = 'rounded-md px-2.5 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] disabled:opacity-50';
const ICON_BUTTON = 'inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]';
const MAX_NOTE = 500;

/** The two things colleagues do at a field, as small buttons next to its label. */
export function FieldActions({ fieldKey, canAsk, onAsk, onNote }: {
    fieldKey: string;
    /** The field has no value yet: only then is there something to ask a colleague for. */
    canAsk: boolean;
    onAsk?: (key: string) => void; onNote?: (key: string) => void;
}) {
    const { t } = useTranslation();
    const ask = t('chat_templates.field_ask', 'Ask a colleague');
    const note = t('chat_templates.field_note', 'Add a note');
    return (
        <span className="ml-auto flex shrink-0 items-center gap-0.5" data-testid={`template-fill-team-actions-${fieldKey}`}>
            {onAsk && canAsk && (
                <button type="button" onClick={() => onAsk(fieldKey)} aria-label={ask} title={ask} className={ICON_BUTTON}>
                    <AtSign size={13} aria-hidden="true" />
                </button>
            )}
            {onNote && (
                <button type="button" onClick={() => onNote(fieldKey)} aria-label={note} title={note} className={ICON_BUTTON}>
                    <StickyNote size={13} aria-hidden="true" />
                </button>
            )}
        </span>
    );
}

/** The final check's remark at a field. */
function Remark({ remark, readOnly, onAccept, onDismiss }: {
    remark: FillFinding; readOnly: boolean; onAccept: () => void; onDismiss: () => void;
}) {
    const { t } = useTranslation();
    const rewrite = remark.kind === 'rewrite' && remark.suggestion !== undefined;
    const Icon = rewrite ? WandSparkles : TriangleAlert;
    return (
        <div data-testid={`template-fill-remark-${remark.key}`} data-kind={remark.kind}
            className={`flex flex-col gap-1.5 rounded-md border-l-[3px] px-3 py-2 text-xs ${rewrite
                ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_7%,transparent)]'
                : 'border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]'}`}>
            <p className="m-0 flex items-start gap-1.5 text-[var(--text-primary)]">
                <Icon size={13} className={`mt-px shrink-0 ${rewrite ? 'text-[var(--accent-primary)]' : 'text-[var(--warning)]'}`} aria-hidden="true" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="font-semibold">{rewrite ? t('chat_templates.remark_rewrite', 'Suggested wording') : t('chat_templates.remark_doubt', 'Is this right?')}</span>
                    {remark.reason && <span className="text-[var(--text-secondary)]"> {remark.reason}</span>}
                </span>
            </p>
            {rewrite && (
                <p className="m-0 min-w-0 whitespace-pre-line rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[13px] text-[var(--text-primary)] [overflow-wrap:anywhere]">{remark.suggestion}</p>
            )}
            {!readOnly && (
                <div className="flex flex-wrap gap-1.5">
                    {rewrite && (
                        <button type="button" onClick={onAccept} className={`${CHIP} bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)]`}>
                            {t('chat_templates.remark_use', 'Use this')}
                        </button>
                    )}
                    <button type="button" onClick={onDismiss} className={`${CHIP} border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]`}>
                        {rewrite ? t('chat_templates.remark_keep', 'Keep mine') : t('chat_templates.remark_right', 'It is right')}
                    </button>
                </div>
            )}
        </div>
    );
}

/** The notes at a field (or on the document), each removable by its writer. */
export function NoteList({ notes, nameOf, meId, onRemove }: {
    notes: FieldNote[]; nameOf: (id: string) => string; meId: string | null; onRemove?: (noteId: string) => Promise<void>;
}) {
    const { t } = useTranslation();
    if (notes.length === 0) return null;
    const remove = t('chat_templates.note_remove', 'Remove this note');
    return (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="template-fill-notes">
            {notes.map((note) => (
                <li key={note.id} className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
                    <StickyNote size={12} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><span className="font-medium text-[var(--text-primary)]">{nameOf(note.userId)}:</span> {note.text}</span>
                    {onRemove && note.userId === meId && (
                        <button type="button" onClick={() => { void onRemove(note.id); }} aria-label={remove} title={remove}
                            className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                            <X size={12} aria-hidden="true" />
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}

/** A one-line editor for a new note; closes itself once the note is saved. */
export function NoteComposer({ label, onSave, onClose }: { label: string; onSave: (text: string) => Promise<void>; onClose: () => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    // Opened by the person's own click on "Add a note": the cursor goes where they type.
    useEffect(() => { input.current?.focus(); }, []);
    const save = async () => {
        if (!text.trim()) return;
        setBusy(true);
        setFailed(false);
        try {
            await onSave(text.trim());
            onClose();
        } catch {
            setFailed(true);
            setBusy(false);
        }
    };
    return (
        <div className="flex flex-col gap-1" data-testid="template-fill-note-composer">
            <div className="flex items-center gap-1.5">
                <input ref={input} type="text" value={text} maxLength={MAX_NOTE} aria-label={label} placeholder={label} disabled={busy}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } if (e.key === 'Escape') onClose(); }}
                    className="min-w-0 flex-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]" />
                <button type="button" onClick={() => { void save(); }} disabled={busy || !text.trim()} className={`${CHIP} bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)]`}>
                    {t('chat_templates.note_save', 'Add')}
                </button>
                <button type="button" onClick={onClose} className={`${CHIP} text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]`}>{t('doc_value_requests.cancel', 'Cancel')}</button>
            </div>
            {failed && <p role="alert" className="m-0 text-xs text-[var(--error)]">{t('chat_templates.note_failed', 'The note could not be saved. Try again.')}</p>}
        </div>
    );
}

export interface FieldBelowProps {
    fieldKey: string;
    remark?: FillFinding;
    /** Who filled it in, or who was asked. */
    hint?: FieldHint;
    notes: FieldNote[];
    nameOf: (id: string) => string;
    meId: string | null;
    readOnly: boolean;
    /** A note is being written at this field. */
    noting: boolean;
    onAccept: (key: string) => void;
    onDismiss: (key: string) => void;
    onAddNote?: (key: string, text: string) => Promise<void>;
    onStopNoting?: () => void;
    onRemoveNote?: (noteId: string) => Promise<void>;
}

export function FieldBelow(p: FieldBelowProps) {
    const { t } = useTranslation();
    const HintIcon = p.hint?.asked ? Hourglass : UserRoundCheck;
    const { onAddNote, onStopNoting } = p;
    return (
        <>
            {p.remark && <Remark remark={p.remark} readOnly={p.readOnly} onAccept={() => p.onAccept(p.fieldKey)} onDismiss={() => p.onDismiss(p.fieldKey)} />}
            {p.hint && (
                <p data-testid={`template-fill-note-${p.fieldKey}`}
                    className={`m-0 flex items-center gap-1 text-[11px] ${p.hint.asked ? 'font-medium text-[var(--warning)]' : 'text-[var(--text-tertiary)]'}`}>
                    <HintIcon size={11} aria-hidden="true" /><span>{p.hint.text}</span>
                </p>
            )}
            <NoteList notes={p.notes} nameOf={p.nameOf} meId={p.meId} onRemove={p.readOnly ? undefined : p.onRemoveNote} />
            {p.noting && !p.readOnly && onAddNote && onStopNoting && (
                <NoteComposer label={t('chat_templates.note_placeholder', 'A note for your colleagues about this field')}
                    onSave={(text) => onAddNote(p.fieldKey, text)} onClose={onStopNoting} />
            )}
        </>
    );
}
