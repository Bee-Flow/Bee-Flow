/**
 * Filling in a document from a template together, in a project: the same form
 * as in the chat (TemplateFillForm), read again every few seconds so each
 * person sees what the others filled in, a line per field saying who filled it
 * in or was asked, and requests to colleagues for the fields only they know
 * (the colleague gets a bell notification; the request closes once the fields
 * have a value).
 */
import { useMemo, useState } from 'react';
import { BellRing, X } from 'lucide-react';

import { useFillDocumentQuery } from '@/api/queries/chatTemplateFill';
import { useProjectMembersQuery } from '@/api/queries/projects';
import { fillDocumentOf, templateFillApi, type FillDocument, type TemplateFillApi } from '@/api/templateFillApi';
import {
    askColleagues, closeValueRequest, isOpenRequest, teamStateOf, type TeamState, type ValueRequest,
} from '@/api/templateFillTeamApi';
import { apiJson } from '@/api/typedRequest';
import TemplateFillForm from '@/components/chat/MessageItem/TemplateFillForm';
import useTranslation from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import { useSessionUser } from '../documentQueries';
import { colleaguesOf, fieldNotes, nameFor, type Colleague } from './projectFillModel';

const POLL_MS = 8000;
const SMALL_BUTTON = 'rounded-md px-2 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] disabled:opacity-50';

/** The form's API, reading the team part of the document from the same answer (one read per tick). */
function useTeamApi(setTeam: (t: TeamState) => void): TemplateFillApi {
    return useMemo(() => ({
        ...templateFillApi,
        load: async (id: string): Promise<FillDocument> => {
            const body = await apiJson('GET /api/studio-documents/{id}', { params: { id } });
            setTeam(teamStateOf(body));
            return fillDocumentOf(body, id);
        },
    }), [setTeam]);
}

const isBlank = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
const BOX = 'flex items-center gap-1.5 text-xs text-[var(--text-primary)]';

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

function AskForm({ doc, colleagues, onAsked, onCancel }: {
    doc: FillDocument; colleagues: Colleague[]; onAsked: (requests: ValueRequest[]) => void; onCancel: () => void;
}) {
    const { t } = useTranslation();
    const [fields, setFields] = useState<string[]>(() => doc.fields.filter((f) => f.required && isBlank(doc.values[f.key])).map((f) => f.key));
    const [people, setPeople] = useState<string[]>([]);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const send = async () => {
        setBusy(true);
        setError(null);
        try {
            onAsked(await askColleagues(doc.id, fields, people, note));
        } catch (e) {
            setError(messageOf(e, t('doc_value_requests.ask_failed', 'The request could not be sent. Please try again.')));
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-2" data-testid="value-request-form">
            <CheckList legend={t('doc_value_requests.which_fields', 'Which fields?')} picked={fields} onToggle={(id) => setFields((l) => toggle(l, id))}
                items={doc.fields.map((f) => ({ id: f.key, label: f.label }))} />
            <CheckList legend={t('doc_value_requests.who', 'Ask whom?')} picked={people} onToggle={(id) => setPeople((l) => toggle(l, id))}
                items={colleagues.map((c) => ({ id: c.id, label: c.name }))}
                empty={t('doc_value_requests.no_colleagues', 'Nobody else may edit this project yet. Invite someone as an editor first.')} />
            <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--text-secondary)]">
                {t('doc_value_requests.note', 'Message (optional)')}
                <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
                    className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-1 text-sm font-normal text-[var(--text-primary)]" />
            </label>
            {error && <p role="alert" className="m-0 text-xs text-[var(--error)]">{error}</p>}
            <div className="flex gap-2">
                <button type="button" disabled={busy || fields.length === 0 || people.length === 0} onClick={() => { void send(); }}
                    className={`${SMALL_BUTTON} bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)]`} data-testid="value-request-send">
                    {t('doc_value_requests.send', 'Send request')}
                </button>
                <button type="button" onClick={onCancel} className={`${SMALL_BUTTON} text-[var(--text-secondary)]`}>{t('doc_value_requests.cancel', 'Cancel')}</button>
            </div>
        </div>
    );
}

function RequestRow({ r, meId, labelOf, nameOf, onClose }: {
    r: ValueRequest; meId: string | null; labelOf: (key: string) => string; nameOf: (id: string) => string; onClose: (r: ValueRequest) => void;
}) {
    const { t } = useTranslation();
    const mine = r.assigneeId === meId;
    const fields = r.fields.map(labelOf).join(', ');
    return (
        <li className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-xs ${mine ? 'bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)]' : 'bg-[var(--bg-tertiary)]'}`}>
            <BellRing size={13} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-[var(--text-primary)]">
                {mine
                    ? t('doc_value_requests.asked_you', '{person} asks you: {fields}', { person: nameOf(r.requestedBy), fields })
                    : t('doc_value_requests.waiting_for', 'Waiting for {person}: {fields}', { person: nameOf(r.assigneeId), fields })}
                {r.message && <span className="block text-[var(--text-secondary)]">“{r.message}”</span>}
            </span>
            {(r.requestedBy === meId || mine) && (
                <button type="button" onClick={() => onClose(r)} aria-label={t('doc_value_requests.close', 'Close this request')}
                    className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]">
                    <X size={13} aria-hidden="true" />
                </button>
            )}
        </li>
    );
}

export default function ProjectFillPanel({ documentId, projectId }: { documentId: string; projectId: string }) {
    const { t } = useTranslation();
    const [team, setTeam] = useState<TeamState>({ projectId, requests: [], filledBy: {} });
    const api = useTeamApi(setTeam);
    const query = useFillDocumentQuery(documentId, 0, api.load);
    const me = useSessionUser(true).data?.id || null;
    const members = useProjectMembersQuery(projectId).data;
    const [asking, setAsking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    if (query.isError) return <p className="m-0 text-xs text-[var(--text-secondary)]">{t('chat_templates.form_load_failed', 'The form could not be loaded.')}</p>;
    if (!query.data) return <p className="m-0 text-xs text-[var(--text-tertiary)]" aria-busy="true">{t('chat_templates.form_loading', 'Loading the form…')}</p>;
    const doc = query.data;
    const nameOf = (id: string) => nameFor(members, me, id, t);
    const labelOf = (key: string) => doc.fields.find((f) => f.key === key)?.label || key;
    const open = team.requests.filter(isOpenRequest).sort((a, b) => Number(b.assigneeId === me) - Number(a.assigneeId === me));
    const close = async (r: ValueRequest) => {
        try {
            const requests = await closeValueRequest(doc.id, r.id);
            setTeam((prev) => ({ ...prev, requests }));
        } catch (e) {
            setError(messageOf(e, t('doc_value_requests.close_failed', 'The request could not be closed.')));
        }
    };
    return (
        <TemplateFillForm doc={doc} api={api} live={{ pollMs: POLL_MS }} notes={fieldNotes(team.requests, team.filledBy, nameOf, t)}>
            {open.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="value-request-list">
                    {open.map((r) => <RequestRow key={r.id} r={r} meId={me} labelOf={labelOf} nameOf={nameOf} onClose={(x) => { void close(x); }} />)}
                </ul>
            )}
            {error && <p role="alert" className="m-0 text-xs text-[var(--error)]">{error}</p>}
            {doc.editable && (asking
                ? (
                    <AskForm doc={doc} colleagues={colleaguesOf(members, me)} onCancel={() => setAsking(false)}
                        onAsked={(requests) => { setTeam((prev) => ({ ...prev, requests })); setAsking(false); }} />
                ) : (
                    <button type="button" onClick={() => setAsking(true)} data-testid="value-request-open"
                        className={`${SMALL_BUTTON} self-start border border-[var(--border-default)] text-[var(--accent-primary)] hover:bg-[var(--item-hover-bg)]`}>
                        {t('doc_value_requests.ask', 'Ask a colleague for information')}
                    </button>
                ))}
        </TemplateFillForm>
    );
}
