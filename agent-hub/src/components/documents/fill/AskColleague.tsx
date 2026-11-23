/**
 * Tagging colleagues in a project for the fields only they know, and the
 * requests that are still open (server/core/documents/fillTogether.mts). The
 * person asked gets a bell notification that opens the document; the request
 * closes by itself once its fields have a value.
 */
import { useState } from 'react';
import { BellRing, Hourglass, X } from 'lucide-react';

import type { FillDocument } from '@/api/templateFillApi';
import type { ValueRequest } from '@/api/templateFillTeamApi';
import useTranslation from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import { FILL_SMALL } from './fillStyles';
import type { Colleague } from './projectFillModel';

const BOX = 'flex items-center gap-1.5 text-xs text-[var(--text-primary)]';
const MAX_MESSAGE = 500;

const isBlank = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

function CheckList({ legend, items, picked, onToggle, empty }: {
    legend: string; items: Array<{ id: string; label: string }>; picked: string[]; onToggle: (id: string) => void; empty?: string;
}) {
    return (
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1 text-xs font-semibold text-[var(--text-secondary)]">{legend}</legend>
            {items.length === 0 && empty
                ? <p className="m-0 text-xs text-[var(--text-tertiary)]">{empty}</p>
                : (
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {items.map((i) => (
                            <label key={i.id} className={BOX}><input type="checkbox" checked={picked.includes(i.id)} onChange={() => onToggle(i.id)} />{i.label}</label>
                        ))}
                    </div>
                )}
        </fieldset>
    );
}

/** Which fields, whom, and what they should know. `preselect` is the field the person clicked "Ask a colleague" at. */
export function AskForm({ doc, values, colleagues, preselect, onSend, onCancel }: {
    doc: FillDocument; values: Record<string, unknown>; colleagues: Colleague[]; preselect?: string | null;
    onSend: (fields: string[], people: string[], message: string) => Promise<void>; onCancel: () => void;
}) {
    const { t } = useTranslation();
    const [fields, setFields] = useState<string[]>(() => (preselect
        ? [preselect]
        : doc.fields.filter((f) => f.required && isBlank(values[f.key])).map((f) => f.key)));
    const [people, setPeople] = useState<string[]>(() => (colleagues.length === 1 ? [colleagues[0].id] : []));
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const send = async () => {
        setBusy(true);
        setError(null);
        try {
            await onSend(fields, people, note);
        } catch (e) {
            setError(messageOf(e, t('doc_value_requests.ask_failed', 'The request could not be sent. Please try again.')));
            setBusy(false);
        }
    };
    return (
        <div className="flex flex-col gap-2.5 rounded-md bg-[var(--bg-secondary)] p-3" data-testid="value-request-form">
            <CheckList legend={t('doc_value_requests.who', 'Ask whom?')} picked={people} onToggle={(id) => setPeople((l) => toggle(l, id))}
                items={colleagues.map((c) => ({ id: c.id, label: c.name }))}
                empty={t('doc_value_requests.no_colleagues', 'Nobody else may edit this project yet. Invite someone as an editor first.')} />
            <CheckList legend={t('doc_value_requests.which_fields', 'Which fields?')} picked={fields} onToggle={(id) => setFields((l) => toggle(l, id))}
                items={doc.fields.map((f) => ({ id: f.key, label: f.label }))} />
            <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--text-secondary)]">
                {t('doc_value_requests.note', 'What should they know? (optional)')}
                <textarea rows={2} maxLength={MAX_MESSAGE} value={note} onChange={(e) => setNote(e.target.value)}
                    className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-1 text-sm font-normal text-[var(--text-primary)]" />
            </label>
            <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
                {t('doc_value_requests.ask_explained', 'They get a notification that opens this document, and the fields are marked as asked of them until they have a value.')}
            </p>
            {error && <p role="alert" className="m-0 text-xs text-[var(--error)]">{error}</p>}
            <div className="flex gap-2">
                <button type="button" disabled={busy || fields.length === 0 || people.length === 0} onClick={() => { void send(); }}
                    className={`${FILL_SMALL} bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)]`} data-testid="value-request-send">
                    {t('doc_value_requests.send', 'Send request')}
                </button>
                <button type="button" onClick={onCancel} className={`${FILL_SMALL} text-[var(--text-secondary)]`}>{t('doc_value_requests.cancel', 'Cancel')}</button>
            </div>
        </div>
    );
}

function RequestRow({ r, meId, labelOf, nameOf, onClose, onShow }: {
    r: ValueRequest; meId: string | null; labelOf: (key: string) => string; nameOf: (id: string) => string;
    onClose?: (r: ValueRequest) => void; onShow: (key: string) => void;
}) {
    const { t } = useTranslation();
    const mine = r.assigneeId === meId;
    const fields = r.fields.map(labelOf).join(', ');
    const Icon = mine ? BellRing : Hourglass;
    const closeLabel = t('doc_value_requests.close', 'Close this request');
    return (
        <li className="flex flex-wrap items-start gap-x-2 gap-y-1 text-xs" data-mine={mine || undefined}>
            <Icon size={13} className={`mt-0.5 shrink-0 ${mine ? 'text-[var(--warning)]' : 'text-[var(--text-tertiary)]'}`} aria-hidden="true" />
            <span className={`min-w-[8rem] flex-1 ${mine ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                {mine
                    ? t('doc_value_requests.asked_you', '{person} asks you: {fields}', { person: nameOf(r.requestedBy), fields })
                    : t('doc_value_requests.waiting_for', 'Waiting for {person}: {fields}', { person: nameOf(r.assigneeId), fields })}
                {r.message && <span className="block font-normal text-[var(--text-secondary)]">“{r.message}”</span>}
            </span>
            {mine && r.fields[0] && (
                <button type="button" onClick={() => onShow(r.fields[0])}
                    className={`${FILL_SMALL} shrink-0 border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]`}>
                    {t('doc_value_requests.show', 'Go to field')}
                </button>
            )}
            {onClose && (r.requestedBy === meId || mine) && (
                <button type="button" onClick={() => onClose(r)} aria-label={closeLabel} title={closeLabel}
                    className="shrink-0 rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                    <X size={13} aria-hidden="true" />
                </button>
            )}
        </li>
    );
}

/** The open requests, the reader's own first. */
export function RequestList({ requests, meId, labelOf, nameOf, onClose, onShow }: {
    requests: ValueRequest[]; meId: string | null; labelOf: (key: string) => string; nameOf: (id: string) => string;
    onClose?: (r: ValueRequest) => void; onShow: (key: string) => void;
}) {
    if (requests.length === 0) return null;
    const sorted = [...requests].sort((a, b) => Number(b.assigneeId === meId) - Number(a.assigneeId === meId));
    return (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="value-request-list">
            {sorted.map((r) => <RequestRow key={r.id} r={r} meId={meId} labelOf={labelOf} nameOf={nameOf} onClose={onClose} onShow={onShow} />)}
        </ul>
    );
}
