/**
 * The part of a fill-in form that is about the other people of a project, as
 * one section above the fields: what colleagues were asked (and what they ask
 * of the reader), the notes on the document as a whole, and the two things to
 * do with colleagues: ask one for fields, leave a note for all. What belongs
 * to a single field (its note, "Ask a colleague" at it) is FieldExtras; both
 * use the actions of `useTeamActions`.
 */
import { useState } from 'react';
import { AtSign, StickyNote, Users } from 'lucide-react';

import type { FillDocument } from '@/api/templateFillApi';
import { fillTeamApi, isOpenRequest, type FillTeam, type FillTeamApi, type ValueRequest } from '@/api/templateFillTeamApi';
import useTranslation from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import { AskForm, RequestList } from './AskColleague';
import { NoteComposer, NoteList } from './FieldExtras';
import type { Colleague } from './projectFillModel';

const HEAD_BUTTON = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]';

/** Who the people of the project are, as this reader names them. */
export interface FillPeople {
    nameOf: (id: string) => string;
    /** Who can be asked: the project's owner and editors, without the reader. */
    colleagues: Colleague[];
}

/** `false`: not asking. `null`: asking, no field chosen yet. A key: asking about that field. */
type Asking = string | null | false;
/** `false`: no note is being written. '': one on the whole document. A key: one at that field. */
type Noting = string | false;

/** What the people of a project do on a form besides filling in: ask, close a request, note. */
export function useTeamActions(documentId: string, setTeam: (team: FillTeam) => void, api: FillTeamApi = fillTeamApi) {
    const { t } = useTranslation();
    const [asking, setAsking] = useState<Asking>(false);
    const [noting, setNoting] = useState<Noting>(false);
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
        asking, noting, error,
        // One thing at a time: asking closes a note that was being written, and the other way round.
        ask: (key: string | null) => { setNoting(false); setAsking(key); },
        stopAsking: () => setAsking(false),
        note: (key: string) => { setAsking(false); setNoting(key); },
        stopNoting: () => setNoting(false),
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

/** The two things to do with colleagues, at the right of the section's title. */
function HeadActions({ actions, compact }: { actions: TeamActions; compact: boolean }) {
    const { t } = useTranslation();
    const askLabel = t('doc_value_requests.ask', 'Ask a colleague');
    const noteLabel = t('chat_templates.note_document', 'Note for everyone');
    const wording = compact ? 'sr-only' : '';
    return (
        <>
            <button type="button" onClick={() => actions.ask(null)} data-testid="value-request-open" className={HEAD_BUTTON} title={compact ? askLabel : undefined}>
                <AtSign size={13} aria-hidden="true" /><span className={wording}>{askLabel}</span>
            </button>
            <button type="button" onClick={() => actions.note('')} data-testid="document-note-open" className={HEAD_BUTTON} title={compact ? noteLabel : undefined}>
                <StickyNote size={13} aria-hidden="true" /><span className={wording}>{noteLabel}</span>
            </button>
        </>
    );
}

interface TeamBlockProps {
    doc: FillDocument; values: Record<string, unknown>; team: FillTeam; meId: string | null; people: FillPeople;
    actions: TeamActions; readOnly: boolean;
    /** In a narrow column (the editor's side panel) the two actions are icons; their names are still read out. */
    compact?: boolean;
    /** Bring a field into view (a request that names it). */
    onShow: (key: string) => void;
}

/** What is open with colleagues, and what is being written to them; nothing at all while there is neither. */
function TeamBody({ doc, values, team, meId, people, actions, readOnly, onShow }: TeamBlockProps) {
    const { t } = useTranslation();
    const labelOf = (key: string) => doc.fields.find((f) => f.key === key)?.label || key;
    const documentNotes = team.notes.filter((n) => !n.key);
    const open = team.requests.filter(isOpenRequest);
    const asking = !readOnly && actions.asking !== false;
    const noting = !readOnly && actions.noting === '';
    if (open.length === 0 && documentNotes.length === 0 && !actions.error && !asking && !noting) return null;
    return (
        <div className="flex flex-col gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5">
            <RequestList requests={open} meId={meId} labelOf={labelOf} nameOf={people.nameOf}
                onClose={readOnly ? undefined : (r) => { void actions.closeRequest(r); }} onShow={onShow} />
            <NoteList notes={documentNotes} nameOf={people.nameOf} meId={meId} onRemove={readOnly ? undefined : actions.removeNote} />
            {actions.error && <p role="alert" className="m-0 text-xs text-[var(--error)]">{actions.error}</p>}
            {asking && (
                <AskForm key={actions.asking || 'all'} doc={doc} values={values} colleagues={people.colleagues}
                    preselect={actions.asking || null} onSend={actions.send} onCancel={actions.stopAsking} />
            )}
            {noting && (
                <NoteComposer label={t('chat_templates.note_document_placeholder', 'A note for your colleagues about this document')}
                    onSave={(text) => actions.addNote('', text)} onClose={actions.stopNoting} />
            )}
        </div>
    );
}

export default function TeamBlock(props: TeamBlockProps) {
    const { t } = useTranslation();
    return (
        <section aria-label={t('chat_templates.team_title', 'With your colleagues')} data-testid="template-fill-team"
            className="flex flex-col rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
                <h4 className="m-0 mr-auto flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)]">
                    <Users size={13} aria-hidden="true" />{t('chat_templates.team_title', 'With your colleagues')}
                </h4>
                {!props.readOnly && <HeadActions actions={props.actions} compact={props.compact === true} />}
            </div>
            <TeamBody {...props} />
        </section>
    );
}
