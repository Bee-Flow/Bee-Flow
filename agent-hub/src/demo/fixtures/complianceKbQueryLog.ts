/**
 * The Compliance demo's knowledge-base search log, in the shapes
 * routes/compliance/kbQueryLog.js serves:
 *
 *   overview  GET /kb-query-log/overview → { licensed, anyEnabled, kbs }:
 *             per knowledge base the setting, its term, who changed it, its
 *             managers and counts. Never a question or an answer.
 *   entries   GET /kb-query-log/entries → { rows, total, limit, offset }:
 *             metadata only (time, base, person, channel, outcome, status),
 *             filtered like the server's listEntries without content.
 *
 * Content, exports and erasure need an open data-subject request; the demo
 * leaves those routes unfixtured on purpose, so the requests tab shows its
 * "choose an open request" state.
 */

import { pick } from '../lang';
import { DEMO_USER, daysAgo } from './common';

const HANDBOOK = { id: 'kb_demo_handbook', name: pick({ en: 'Staff handbook', nl: 'Personeelshandboek' }) };
const POLICIES = { id: 'kb_demo_policies', name: pick({ en: 'Policy library', nl: 'Beleidsbibliotheek' }) };

const MANAGER = { id: DEMO_USER.id, name: DEMO_USER.displayName };

const ENTRIES = [
    { days: 0, channel: 'agent_chat', outcome: 'answered', status: 'to_review' },
    { days: 1, channel: 'studio_ai_generate', outcome: 'answered', status: 'reviewed' },
    { days: 2, channel: 'direct_chat', outcome: 'no_results', status: 'needs_addition' },
    { days: 3, channel: 'agent_chat', outcome: 'answered', status: 'reviewed' },
    { days: 5, channel: 'studio_kb_query', outcome: 'answered', status: 'to_review' },
].map((e, i) => ({
    id: `kql_demo${String(i + 1).padStart(4, '0')}`,
    kbId: HANDBOOK.id,
    kbName: HANDBOOK.name,
    createdAt: daysAgo(e.days),
    userId: DEMO_USER.id,
    userName: DEMO_USER.displayName,
    channel: e.channel,
    outcome: e.outcome,
    reviewStatus: e.status,
}));

const countBy = (key: 'outcome' | 'reviewStatus') =>
    ENTRIES.reduce<Record<string, number>>((acc, e) => { acc[e[key]] = (acc[e[key]] ?? 0) + 1; return acc; }, {});

function overview() {
    return {
        licensed: true,
        anyEnabled: true,
        kbs: [
            {
                ...HANDBOOK, enabled: true, retentionDays: 90, changedAt: daysAgo(14),
                changedBy: MANAGER.id, changedByName: MANAGER.name, managers: [MANAGER],
                attestation: { purpose: 'ai_quality', dpia: 'not_required', dpiaId: null, worksCouncil: 'not_applicable', worksCouncilReason: 'no_works_council', privacyNoticeUpdated: true },
                attestedBy: MANAGER.id, attestedByName: MANAGER.name, attestedAt: daysAgo(14),
                showNames: false, highRisk: false, acknowledgedUsers: 3,
                total: ENTRIES.length, byOutcome: countBy('outcome'), byStatus: countBy('reviewStatus'),
            },
            {
                ...POLICIES, enabled: false, retentionDays: 90, changedAt: null,
                changedBy: null, changedByName: null, managers: [MANAGER],
                attestation: null, attestedBy: null, attestedByName: null, attestedAt: null,
                showNames: false, highRisk: false, acknowledgedUsers: 0,
                total: 0, byOutcome: {}, byStatus: {},
            },
        ],
    };
}

function entries(query: URLSearchParams) {
    const want = (k: string) => query.get(k) || null;
    const rows = ENTRIES.filter((e) =>
        (!want('kbId') || e.kbId === want('kbId'))
        && (!want('userId') || e.userId === want('userId'))
        && (!want('channel') || e.channel === want('channel'))
        && (!want('outcome') || e.outcome === want('outcome'))
        && (!want('status') || e.reviewStatus === want('status')));
    const limit = Math.min(Number(query.get('limit')) || 50, 200);
    const offset = Math.max(Number(query.get('offset')) || 0, 0);
    return { rows: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

type Ctx = { query: URLSearchParams };

export const KB_QUERY_LOG_ROUTES = {
    'GET /api/compliance/kb-query-log/overview': () => overview(),
    'GET /api/compliance/kb-query-log/entries': ({ query }: Ctx) => entries(query),
};
