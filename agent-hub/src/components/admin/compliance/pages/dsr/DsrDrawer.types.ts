import type { TranslateParams } from '../../../../../hooks/useTranslation';
import type { DsrRow } from './dsr.types';
import type { VerifyIdentityBody } from './DsrIdentity';
import type { OrgUser } from './dsrTimeline';
import type { SideDrawerMode } from '../../../../shared/SideDrawer';

export type Translate = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;

/** A request id as the register hands it over. */
export type RequestId = DsrRow['id'];

/** The body of fulfil / reject: the status it ends in and the summary mailed to the data subject. */
export interface FulfilBody {
    status: string;
    result_summary?: string;
    notify_subject: boolean;
}

/** One source of what Bee Flow holds about the data subject (GET /requests/:id/discovery). */
export interface DiscoverySource {
    kind?: unknown;
    id?: unknown;
    count?: unknown;
    items?: Array<{ title?: string; name?: string; retention_note?: string } | null>;
}

/** The discovery body, in either of the two spellings readDiscovery reads. */
export interface DiscoveryBody {
    sources?: Array<DiscoverySource | null>;
    memories?: unknown;
    memory_count?: unknown;
    rows?: unknown;
    row_count?: unknown;
    datatable_rows?: unknown;
    tables?: Array<string | { name?: string } | null>;
    form_answers?: unknown;
    form_answer_count?: unknown;
    kb_documents?: unknown;
    documents?: unknown;
    kb_document_count?: unknown;
    retention_notes?: Array<string | { text?: string; note?: string } | null>;
    retention_note?: unknown;
    retained_rows?: unknown;
}

export type DiscoveryKey = 'team_chat' | 'projects' | 'memories' | 'rows' | 'form_answers' | 'kb_documents';

/** The facts the artboard shows; a count the server did not state is null. */
export interface DiscoveryFacts {
    memories: number | null;
    rows: number | null;
    tables: string[];
    form_answers: number | null;
    kb_documents: number | null;
    team_chat: number | null;
    projects: number | null;
    retention_notes: string[];
    retained_rows?: number | null;
}

export interface DrawerBodyProps {
    request: DsrRow;
    busy: boolean;
    exportUrl: string | null;
    onFulfil?: (value: FulfilBody) => unknown;
    onReject?: (value: FulfilBody) => unknown;
    onExtend?: (reason: string) => unknown;
    onStart?: () => unknown;
    onVerifyIdentity?: (body: VerifyIdentityBody) => unknown;
    loadTimeline?: (id: RequestId) => Promise<unknown>;
    loadDiscovery?: (id: RequestId) => Promise<DiscoveryBody | null>;
    orgUsers: readonly OrgUser[] | null;
    testId: string;
}

export interface DrawerHeaderProps {
    request: DsrRow;
    t: Translate;
}

export interface DsrDrawerProps {
    request?: DsrRow | null;
    open?: boolean;
    onClose: () => void;
    mode?: SideDrawerMode;
    width?: number;
    busy?: boolean;
    exportUrl?: string | null;
    onFulfil?: (body: FulfilBody) => unknown;
    onReject?: (body: FulfilBody) => unknown;
    onExtend?: (reason: string) => unknown;
    onStart?: () => unknown;
    onVerifyIdentity?: (body: VerifyIdentityBody) => unknown;
    loadTimeline?: (id: RequestId) => Promise<unknown>;
    loadDiscovery?: (id: RequestId) => Promise<DiscoveryBody | null>;
    orgUsers?: readonly OrgUser[] | null;
    testId?: string;
}
