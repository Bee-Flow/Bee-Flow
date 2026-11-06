/**
 * The knowledge-base query log as the Compliance Center reads it
 * (server/routes/compliance/kbQueryLog.js).
 *
 * The overview and the entries carry metadata only. The parsers below pick
 * the fields the pages may show, one by one, so a text field that slipped
 * into an answer is dropped here and can never reach a component.
 */

export const KQL_CHANNELS = [
    'agent_chat', 'agent_chat_sync', 'direct_chat', 'template_chat', 'notebook', 'webpage',
    'project_assistant', 'automation_ai_step', 'studio_kb_query', 'studio_ai_generate',
    'studio_ai_extract', 'studio_ai_chat', 'support', 'skill', 'kb_test', 'api_search',
] as const;
export const KQL_OUTCOMES = ['answered', 'no_results', 'error'] as const;
export const KQL_STATUSES = ['to_review', 'reviewed', 'needs_addition'] as const;

/** The access-audit actions the query log writes: the overview links to the audit page filtered on these. */
export const KQL_AUDIT_ACTIONS = Object.freeze([
    'kb.query_log.enabled', 'kb.query_log.disabled', 'kb.query_log.retention_changed', 'kb.query_log.purged', 'kb.query_log.names_changed',
    'kb.query_log.high_risk_changed', 'kb.query_log.attested',
    'kb.query_log.exported', 'kb.query_log.content_viewed', 'kb.query_log.subject_exported', 'kb.query_log.subject_deleted',
]);

interface KqlPerson { id: string; name: string | null }

/** What the organisation attested when it switched a base's log on. */
interface KqlAttestation {
    dpia: string | null;
    worksCouncil: string | null;
    worksCouncilReason: string | null;
    privacyNoticeUpdated: boolean;
}

export interface KqlKbRow {
    id: string;
    name: string;
    enabled: boolean;
    retentionDays: number | null;
    changedAt: string | null;
    changedBy: string | null;
    changedByName: string | null;
    managers: KqlPerson[];
    attestation: KqlAttestation | null;
    attestedBy: string | null;
    attestedByName: string | null;
    attestedAt: string | null;
    showNames: boolean;
    aiActHighRisk: boolean;
    acknowledgedUsers: number;
    total: number;
    byOutcome: Record<string, number>;
    byStatus: Record<string, number>;
}

export interface KqlOverview { licensed: boolean; anyEnabled: boolean; kbs: KqlKbRow[] }

export interface KqlEntry {
    id: string;
    kbId: string;
    kbName: string | null;
    createdAt: string | null;
    userId: string | null;
    userName: string | null;
    channel: string;
    outcome: string;
    reviewStatus: string;
}

export interface KqlEntries { rows: KqlEntry[]; total: number; limit: number; offset: number }

export interface KqlSubject {
    userId: string;
    userName: string | null;
    total: number;
    byKb: Array<{ kbId: string; kbName: string | null; count: number }>;
}

/** One row of a person's content, shown only behind an open data-subject request. */
interface KqlContentRow {
    id: string;
    kbName: string | null;
    createdAt: string | null;
    channel: string;
    outcome: string;
    query: string | null;
    answer: string | null;
    chunks: Array<{ title: string | null; sourceUri: string | null }>;
}
export interface KqlContent { rows: KqlContentRow[]; total: number }

export interface KqlEntriesFilter {
    kbId?: string;
    userId?: string;
    channel?: string;
    outcome?: string;
    status?: string;
    from?: string;
    to?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const counts = (v: unknown): Record<string, number> => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'number').map(([k, n]) => [k, n as number])) : {});
const people = (v: unknown): KqlPerson[] => (Array.isArray(v) ? v.filter(isObj).map((p) => ({ id: String(p.id), name: str(p.name) })) : []);

function parseAttestation(v: unknown): KqlAttestation | null {
    if (!isObj(v)) return null;
    return {
        dpia: str(v.dpia), worksCouncil: str(v.worksCouncil), worksCouncilReason: str(v.worksCouncilReason),
        privacyNoticeUpdated: v.privacyNoticeUpdated === true,
    };
}

export function parseOverview(body: unknown): KqlOverview | null {
    if (!isObj(body) || !Array.isArray(body.kbs)) return null;
    return {
        licensed: body.licensed === true,
        anyEnabled: body.anyEnabled === true,
        kbs: body.kbs.filter(isObj).map((k) => ({
            id: String(k.id), name: str(k.name) ?? String(k.id), enabled: k.enabled === true,
            retentionDays: typeof k.retentionDays === 'number' ? k.retentionDays : null,
            changedAt: str(k.changedAt), changedBy: str(k.changedBy), changedByName: str(k.changedByName),
            managers: people(k.managers), attestation: parseAttestation(k.attestation),
            attestedBy: str(k.attestedBy), attestedByName: str(k.attestedByName), attestedAt: str(k.attestedAt),
            showNames: k.showNames === true, aiActHighRisk: k.highRisk === true, acknowledgedUsers: num(k.acknowledgedUsers), total: num(k.total), byOutcome: counts(k.byOutcome), byStatus: counts(k.byStatus),
        })),
    };
}

export function parseEntries(body: unknown): KqlEntries | null {
    if (!isObj(body) || !Array.isArray(body.rows)) return null;
    return {
        total: num(body.total), limit: num(body.limit) || 100, offset: num(body.offset),
        rows: body.rows.filter(isObj).map((r) => ({
            id: String(r.id), kbId: String(r.kbId), kbName: str(r.kbName), createdAt: str(r.createdAt),
            userId: str(r.userId), userName: str(r.userName), channel: String(r.channel ?? ''),
            outcome: String(r.outcome ?? ''), reviewStatus: String(r.reviewStatus ?? ''),
        })),
    };
}

export function parseSubject(body: unknown): KqlSubject | null {
    if (!isObj(body) || typeof body.userId !== 'string') return null;
    return {
        userId: body.userId, userName: str(body.userName), total: num(body.total),
        byKb: Array.isArray(body.byKb) ? body.byKb.filter(isObj).map((b) => ({ kbId: String(b.kbId), kbName: str(b.kbName), count: num(b.count) })) : [],
    };
}

export function parseContent(body: unknown): KqlContent | null {
    if (!isObj(body) || !Array.isArray(body.rows)) return null;
    return {
        total: num(body.total),
        rows: body.rows.filter(isObj).map((r) => ({
            id: String(r.id), kbName: str(r.kbName), createdAt: str(r.createdAt), channel: String(r.channel ?? ''),
            outcome: String(r.outcome ?? ''), query: str(r.query), answer: str(r.answer),
            chunks: Array.isArray(r.chunks) ? r.chunks.filter(isObj).map((c) => ({ title: str(c.title), sourceUri: str(c.sourceUri) })) : [],
        })),
    };
}
