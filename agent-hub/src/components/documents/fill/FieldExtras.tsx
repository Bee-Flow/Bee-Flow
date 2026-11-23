/**
 * What a fill-in form shows under one field, next to the value itself:
 *
 *   - the final check's remark: a better wording to take over or leave, or a
 *     doubt about the value with the reason;
 *   - who filled the field in, or who was asked for it;
 *   - the notes people left each other at this field;
 *   - when filling in together: "Ask a colleague" and "Add a note".
 */
import { useEffect, useRef, useState } from 'react';
import { AtSign, StickyNote, TriangleAlert, WandSparkles, X } from 'lucide-react';

import type { FieldNote, FillFinding } from '@/api/templateFillTeamApi';
import useTranslation from '@/hooks/useTranslation';

const CHIP = 'rounded-md px-2 py-0.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] disabled:opacity-50';
const QUIET = `${CHIP} inline-flex items-center gap-1 text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]`;
const MAX_NOTE = 500;

export interface FieldExtrasProps {
    fieldKey: string;
    remark?: FillFinding;
    /** Who filled it in, or who was asked. */
    hint?: string;
    notes: FieldNote[];
    nameOf: (id: string) => string;
    meId: string | null;
    readOnly: boolean;
    /** Filling in together (a project): tagging a colleague and notes are offered. */
    together: boolean;
    /** The field has no value yet: only then is there something to ask a colleague for. */
    empty: boolean;
    onAccept: (key: string) => void;
    onDismiss: (key: string) => void;
    onAsk?: (key: string) => void;
    onAddNote?: (key: string, text: string) => Promise<void>;
    onRemoveNote?: (noteId: string) => Promise<void>;
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
            className={`flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs ${rewrite
                ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_8%,transparent)]'
                : 'border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]'}`}>
            <p className="m-0 flex items-start gap-1.5 font-medium text-[var(--text-primary)]">
                <Icon size={13} className={`mt-px shrink-0 ${rewrite ? 'text-[var(--accent-primary)]' : 'text-[var(--warning)]'}`} aria-hidden="true" />
                <span>
                    {rewrite ? t('chat_templates.remark_rewrite', 'Suggested wording') : t('chat_templates.remark_doubt', 'Is this right?')}
                    {remark.reason && <span className="font-normal text-[var(--text-secondary)]"> {remark.reason}</span>}
                </span>
            </p>
            {rewrite && <p className="m-0 whitespace-pre-line rounded bg-[var(--bg-primary)] px-2 py-1 text-[var(--text-primary)]">{remark.suggestion}</p>}
            {!readOnly && (
                <div className="flex flex-wrap gap-1.5">
                    {rewrite && (
                        <button type="button" onClick={onAccept} className={`${CHIP} bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)]`}>
                            {t('chat_templates.remark_use', 'Use this')}
                        </button>
                    )}
                    <button type="button" onClick={onDismiss} className={`${CHIP} border border-[var(--border-default)] text-[var(--text-primary)]`}>
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
    return (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="template-fill-notes">
            {notes.map((note) => (
                <li key={note.id} className="flex items-start gap-1.5 rounded-md bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--text-primary)]">
                    <StickyNote size={12} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1"><span className="font-medium">{nameOf(note.userId)}:</span> {note.text}</span>
                    {onRemove && note.userId === meId && (
                        <button type="button" onClick={() => { void onRemove(note.id); }} aria-label={t('chat_templates.note_remove', 'Remove this note')}
                            className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]">
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
                    className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]" />
                <button type="button" onClick={() => { void save(); }} disabled={busy || !text.trim()} className={`${CHIP} bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)]`}>
                    {t('chat_templates.note_save', 'Add')}
                </button>
                <button type="button" onClick={onClose} className={QUIET}>{t('doc_value_requests.cancel', 'Cancel')}</button>
            </div>
            {failed && <p role="alert" className="m-0 text-xs text-[var(--error)]">{t('chat_templates.note_failed', 'The note could not be saved. Try again.')}</p>}
        </div>
    );
}

export default function FieldExtras(p: FieldExtrasProps) {
    const { t } = useTranslation();
    const [noting, setNoting] = useState(false);
    const offerTeam = p.together && !p.readOnly;
    return (
        <>
            {p.remark && <Remark remark={p.remark} readOnly={p.readOnly} onAccept={() => p.onAccept(p.fieldKey)} onDismiss={() => p.onDismiss(p.fieldKey)} />}
            {p.hint && <p className="m-0 text-[11px] text-[var(--accent-primary)]" data-testid={`template-fill-note-${p.fieldKey}`}>{p.hint}</p>}
            <NoteList notes={p.notes} nameOf={p.nameOf} meId={p.meId} onRemove={p.readOnly ? undefined : p.onRemoveNote} />
            {offerTeam && noting && p.onAddNote && (
                <NoteComposer label={t('chat_templates.note_placeholder', 'A note for your colleagues about this field')}
                    onSave={(text) => p.onAddNote!(p.fieldKey, text)} onClose={() => setNoting(false)} />
            )}
            {offerTeam && !noting && (
                <div className="flex flex-wrap gap-1" data-testid={`template-fill-team-actions-${p.fieldKey}`}>
                    {p.onAsk && p.empty && (
                        <button type="button" onClick={() => p.onAsk!(p.fieldKey)} className={QUIET}>
                            <AtSign size={12} aria-hidden="true" />{t('chat_templates.field_ask', 'Ask a colleague')}
                        </button>
                    )}
                    {p.onAddNote && (
                        <button type="button" onClick={() => setNoting(true)} className={QUIET}>
                            <StickyNote size={12} aria-hidden="true" />{t('chat_templates.field_note', 'Add a note')}
                        </button>
                    )}
                </div>
            )}
        </>
    );
}
