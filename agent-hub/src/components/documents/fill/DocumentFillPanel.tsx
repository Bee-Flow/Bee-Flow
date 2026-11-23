/**
 * A document made from a template as its fill-in form, wherever it is shown:
 * under a chat answer, in a project's team chat, in the document editor. One
 * component, so the three behave the same.
 *
 * What the form offers follows from the DOCUMENT, not from the place: a
 * person's own document can be saved in a project (and a folder of it); a
 * document that is a project's is filled in together, so it is read again
 * every few seconds, says who filled in or was asked for each field, and lets
 * its people tag a colleague and leave notes. A document filed into a project
 * from the form turns into the second kind on the spot.
 */
import { useMemo } from 'react';

import { useFillDocumentQuery, useFillReaderId } from '@/api/queries/chatTemplateFill';
import { useProjectMembersQuery } from '@/api/queries/projects';
import { templateFillApi, type FillDocument, type TemplateFillApi } from '@/api/templateFillApi';
import TemplateFillForm, { type FillPlace } from '@/components/chat/MessageItem/TemplateFillForm';
import type { LiveOptions } from '@/components/chat/MessageItem/useTemplateFillForm';
import useTranslation from '@/hooks/useTranslation';
import { colleaguesOf, nameFor } from './projectFillModel';
import type { FillPeople } from './TeamBlock';

/** How often a project's form reads what the others filled in. */
const FILL_POLL_MS = 8000;

/** The people of the project the document is in, as this reader names them; none for a person's own document. */
function useFillPeople(projectId: string | null, meId: string | null): FillPeople | undefined {
    const { t } = useTranslation();
    const members = useProjectMembersQuery(projectId).data;
    return useMemo(() => (projectId
        ? { nameOf: (id: string) => nameFor(members, meId, id, t), colleagues: colleaguesOf(members, meId) }
        : undefined), [projectId, members, meId, t]);
}

interface PanelProps {
    documentId: string;
    /** Who is reading; left out, the signed-in person is asked for once a project's form needs it. */
    meId?: string | null;
    /** Counts the reads the host wants: a new tool result in a live turn reads the document again. */
    revision?: number;
    place?: FillPlace;
    api?: TemplateFillApi;
    /** Every answer of the server about this document: the editor keeps its own copy in step with it. */
    onSynced?: LiveOptions['onSynced'];
}

/**
 * The form of a document that was read. Apart from the read above, so the
 * project's people are only asked for where a document was read at all (a
 * headless mount without a query client stays at "Loading the form…").
 */
function LoadedForm({ doc, meId, place, api, onSynced, onFiled }: Required<Pick<PanelProps, 'place' | 'api'>> & Pick<PanelProps, 'meId' | 'onSynced'> & {
    doc: FillDocument; onFiled: () => void;
}) {
    const projectId = doc.projectId ?? null;
    const reader = useFillReaderId(meId === undefined && !!projectId);
    const me = meId === undefined ? reader.data ?? null : meId;
    const people = useFillPeople(projectId, me);
    return (
        <TemplateFillForm doc={doc} api={api} meId={me} people={people} place={place} onFiled={onFiled}
            live={{ pollMs: projectId ? FILL_POLL_MS : undefined, onSynced }} />
    );
}

export default function DocumentFillPanel({ documentId, meId, revision = 0, place = 'chat', api = templateFillApi, onSynced }: PanelProps) {
    const { t } = useTranslation();
    const query = useFillDocumentQuery(documentId, revision, api.load);
    if (query.isError && !query.data) {
        return <p className="m-0 text-xs text-[var(--text-secondary)]">{t('chat_templates.form_load_failed', 'The form could not be loaded.')}</p>;
    }
    if (!query.data) {
        return <p className="m-0 text-xs text-[var(--text-tertiary)]" aria-busy="true">{t('chat_templates.form_loading', 'Loading the form…')}</p>;
    }
    // Filed into a project from here: read again, and it is the project's form from now on.
    const onFiled = () => { void query.refetch(); };
    return <LoadedForm doc={query.data} meId={meId} place={place} api={api} onSynced={onSynced} onFiled={onFiled} />;
}
