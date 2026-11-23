/**
 * The part of a fill-in form that is about the other people of a project:
 * what colleagues were asked (and what they ask of the reader), tagging a
 * colleague for fields, and the notes on the document as a whole. The notes
 * and the "Ask a colleague" at a single field are FieldExtras; both use the
 * actions of `useTeamActions`.
 */
import { useState } from 'react';
import { AtSign, StickyNote } from 'lucide-react';

import type { FillDocument } from '@/api/templateFillApi';
import { fillTeamApi, isOpenRequest, type FillTeam, type FillTeamApi, type ValueRequest } from '@/api/templateFillTeamApi';
import useTranslation from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import { AskForm, RequestList } from './AskColleague';
import { NoteComposer, NoteList } from './FieldExtras';
import type { Colleague } from './projectFillModel';

const SMALL_BUTTON = 'inline-flex items-center gap-1 rounded-md border border-[var(--border-default)] px-2 py-1 text-xs font-medium text-[var(--accent-primary)] hover:bg-[var(--item-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]';

/** Who the people of the project are, as this reader names them. */
export interface FillPeople {
    nameOf: (id: string) => string;
    /** Who can be asked: the project's owner and editors, without the reader. */
    colleagues: Colleague[];
}

/** `false`: not asking. `null`: asking, no field chosen yet. A key: asking about that field. */
type Asking = string | null | false;

/** What the people of a project do on a form besides filling in: ask, close a request, note. */
export function useTeamActions(documentId: string, setTeam: (team: FillTeam) => void, api: FillTeamApi = fillTeamApi) {
    const { t } = useTranslation();
    const [asking, setAsking] = useState<Asking>(false);
    const [error, setError] = useState<string | null>(null);
    const closeRequest = async (r: ValueRequest) => {
        setError(null);
        try {
            setTeam(await api.closeRequest(documentId, r.id));
        } catch (e) {
            setError(messageOf(e, t('doc_value_requests.close_failed', 'The request could not be closed.')));
        }
    };
    return {
        asking, error,
        ask: (key: string | null) => setAsking(key),
        stopAsking: () => setAsking(false),
        /** Send the request; the form that asked closes once it is sent, and says so itself when it is not. */
        send: async (fields: string[], people: string[], message: string) => { setTeam(await api.ask(documentId, fields, people, message)); setAsking(false); },
        closeRequest,
        // A note that fails to save says so where it was typed (NoteComposer); one that fails to go is said here.
        addNote: async (key: string, text: string) => { setTeam(await api.addNote(documentId, key, text)); },
        removeNote: async (noteId: string) => {
            setError(null);
            try {
                setTeam(await api.removeNote(documentId, noteId));
            } catch (e) {
                setError(messageOf(e, t('chat_templates.note_remove_failed', 'The note could not be removed.')));
            }
        },
    };
}

export type TeamActions = ReturnType<typeof useTeamActions>;

export default function TeamBlock({ doc, values, team, meId, people, actions, readOnly, onShow }: {
    doc: FillDocument; values: Record<string, unknown>; team: FillTeam; meId: string | null; people: FillPeople;
    actions: TeamActions; readOnly: boolean;
    /** Bring a field into view (a request that names it). */
    onShow: (key: string) => void;
}) {
    const { t } = useTranslation();
    const [noting, setNoting] = useState(false);
    const labelOf = (key: string) => doc.fields.find((f) => f.key === key)?.label || key;
    const documentNotes = team.notes.filter((n) => !n.key);
    return (
        <div className="flex flex-col gap-2" data-testid="template-fill-team">
            <RequestList requests={team.requests.filter(isOpenRequest)} meId={meId} labelOf={labelOf} nameOf={people.nameOf}
                onClose={readOnly ? undefined : (r) => { void actions.closeRequest(r); }} onShow={onShow} />
            <NoteList notes={documentNotes} nameOf={people.nameOf} meId={meId} onRemove={readOnly ? undefined : actions.removeNote} />
            {actions.error && <p role="alert" className="m-0 text-xs text-[var(--error)]">{actions.error}</p>}
            {!readOnly && actions.asking !== false && (
                <AskForm key={actions.asking ?? 'all'} doc={doc} values={values} colleagues={people.colleagues} preselect={actions.asking}
                    onSend={actions.send} onCancel={actions.stopAsking} />
            )}
            {!readOnly && noting && (
                <NoteComposer label={t('chat_templates.note_document_placeholder', 'A note for your colleagues about this document')}
                    onSave={(text) => actions.addNote('', text)} onClose={() => setNoting(false)} />
            )}
            {!readOnly && actions.asking === false && !noting && (
                <div className="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => actions.ask(null)} data-testid="value-request-open" className={SMALL_BUTTON}>
                        <AtSign size={12} aria-hidden="true" />{t('doc_value_requests.ask', 'Ask a colleague for information')}
                    </button>
                    <button type="button" onClick={() => setNoting(true)} data-testid="document-note-open" className={SMALL_BUTTON}>
                        <StickyNote size={12} aria-hidden="true" />{t('chat_templates.note_document', 'Add a note for everyone')}
                    </button>
                </div>
            )}
        </div>
    );
}
