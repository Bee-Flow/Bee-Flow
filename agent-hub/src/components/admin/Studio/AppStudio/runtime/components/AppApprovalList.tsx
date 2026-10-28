import { ChevronDown, ChevronRight, Clock, Download, FileText, Loader2, LogIn, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import { FormRichText } from '@/components/forms/PublicFormRenderer';
import ApprovalDecisionControls, { type ApprovalField } from '@/components/admin/Studio/Approvals/ApprovalDecisionControls';
import { approvalStatusChip, formatWhen, stageChainInfo, type ApprovalRowLike, type ApprovalStageInfo } from '@/components/admin/Studio/Approvals/approvalDisplay';
import { useDataContext } from '../DataContext';
import { hoverable } from '../hoverable';
import { useRuntime } from '../RuntimeContext';
import type { TranslateParams } from '@/hooks/useTranslation';
import type React from 'react';
import type { NodeProps } from './appNode.types';
import { mutate, request, errorBody, RefusedError } from '@/api/mutate';

/**
 * App Studio runtime — 'approval_list'. Spec: server/appStudio/componentSpecs.js.
 *
 * The viewer's approvals, decided WITHOUT leaving the app. Deliberately a
 * component with its own session-authed fetch rather than a data binding:
 * bindings read acts-as-owner, while approvals must be read and decided as
 * the REAL signed-in viewer — the server's canView/canDecide scoping is the
 * only authority, and this component simply carries the viewer's own cookie
 * to the same /api/automation/approvals routes the Studio section uses.
 *
 * Anonymous/public viewers get a static sign-in wall and NO fetch — an
 * `anon:` id can request an approval (a public form's submit), never see or
 * decide one. The editor canvas renders a static sample: the editor has no
 * viewer to scope by, and an empty "nothing waiting" while designing reads
 * as broken.
 *
 * Reuses the Studio section's decision controls verbatim (reason-required
 * reject, inline required-question validation) so the rules cannot fork
 * between the two decide surfaces.
 */

interface ApprovalAttachment {
    fileId: string;
    label?: string;
    filename?: string;
}

/** One approval as the list reads it. */
interface ApprovalRow extends ApprovalRowLike {
    id: string;
    stages?: (ApprovalStageInfo & { approvers?: { userId: string }[]; rule?: string })[] | null;
    createdAt?: string;
    expiresAt?: string;
    decidedAt?: string;
    decidedByName?: string;
    decisionReason?: string | null;
    detailsMd?: string | null;
    attachments?: ApprovalAttachment[];
    answers?: unknown;
    fields?: ApprovalField[] | null;
}

/** The open row's detail: the approval (once loaded), whether this viewer may decide, or why not. */
interface ApprovalDetail {
    error?: string;
    approval?: ApprovalRow;
    canDecide?: boolean;
}

const SHOW_TO_STATUS: Record<string, string | null> = {
    waiting: 'pending',
    decided: 'approved,rejected,expired,cancelled',
    all: null,
};

const SAMPLE_ROWS: ApprovalRow[] = [
    // The first sample is STAGED on purpose: an author designing this
    // component should see that a chained approval says which stage it is
    // waiting on, without having to build one first.
    {
        id: 'sample-1', status: 'pending', prompt: 'Approve the €12.400 quote for Jansen BV?',
        automationTitle: 'Quote portal', createdAt: new Date().toISOString(),
        stage: 'sample-b',
        stages: [
            { key: 'sample-a', name: 'Team lead', approvers: [{ userId: 'sample' }], rule: 'all' },
            { key: 'sample-b', name: 'Finance', approvers: [{ userId: 'sample' }], rule: 'all' },
        ],
    },
    { id: 'sample-2', status: 'approved', prompt: 'Publish the June newsletter?', automationTitle: 'Marketing', createdAt: new Date().toISOString(), decidedByName: 'Fleur' },
];

interface ApprovalListProps {
    scope?: string;
    show?: string;
    limit?: number;
    emptyText?: string;
    showDetails?: boolean;
}

export default function AppApprovalList({ node }: NodeProps<ApprovalListProps>) {
    const { t } = useTranslation();
    const { mode, currentUser, runAction } = useRuntime();
    const { appId } = useDataContext();
    const {
        scope = 'mine', show = 'waiting', limit = 10,
        emptyText = t('studio_apps_runtime.approvals.empty', 'No approvals right now.'), showDetails = true,
    } = node.props || {};

    const tRef = useRef(t);
    tRef.current = t;
    const tr = useCallback((key: string, fallback: string | TranslateParams, params?: TranslateParams) => tRef.current(key, fallback, params), []);
    const live = mode === 'run' && !!currentUser;
    const [rows, setRows] = useState<ApprovalRow[]>([]);
    const [loading, setLoading] = useState(live);
    const [error, setError] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    const [detail, setDetail] = useState<ApprovalDetail | null>(null);   // { approval, canDecide } for openId
    const gen = useRef(0);

    const load = useCallback(async () => {
        if (!live) return;
        const g = ++gen.current;
        try {
            const q = new URLSearchParams();
            q.set('scope', 'mine');                       // viewer scope is the server's law
            const status = SHOW_TO_STATUS[show] ?? SHOW_TO_STATUS.waiting;
            if (status) q.set('status', status);
            q.set('limit', String(Math.max(1, Math.min(50, Number(limit) || 10))));
            if (scope === 'app' && appId) q.set('appId', appId);
            let res: Response;
            try {
                res = await request(`${API_BASE}/api/automation/approvals?${q}`);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                if (g === gen.current) setError(errorBody(err)?.error || tr('studio_apps_runtime.approvals.load_failed', 'Could not load approvals'));
                return;
            }
            const body = await res.json().catch(() => null);
            if (g !== gen.current) return;
            setError(null);
            setRows(Array.isArray(body?.approvals) ? body.approvals : []);
        } catch {
            if (g === gen.current) setError(tr('studio_apps_runtime.approvals.load_failed', 'Could not load approvals'));
        } finally {
            if (g === gen.current) setLoading(false);
        }
    }, [live, show, limit, scope, appId, tr]);

    useEffect(() => { setLoading(live); load(); }, [load, live]);

    // Liveness at the platform's bell cadence — polling, deliberately (prod is
    // multi-pod; there is no per-viewer push channel to approvals).
    useEffect(() => {
        if (!live) return undefined;
        const t = setInterval(load, 30_000);
        return () => clearInterval(t);
    }, [live, load]);

    const openRow = useCallback(async (row: ApprovalRow) => {
        if (!showDetails) return;
        if (openId === row.id) { setOpenId(null); setDetail(null); return; }
        setOpenId(row.id);
        setDetail(null);
        try {
            let res: Response;
            try {
                res = await request(`${API_BASE}/api/automation/approvals/${encodeURIComponent(row.id)}`);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                setDetail({ error: errorBody(err)?.error || tr('studio_apps_runtime.approvals.open_failed', 'Could not open this approval') });
                return;
            }
            setDetail(await res.json().catch(() => null));
        } catch {
            setDetail({ error: tr('studio_apps_runtime.approvals.open_failed', 'Could not open this approval') });
        }
    }, [showDetails, openId, tr]);

    const decide = useCallback(async (approval: ApprovalRow, decision: string, reason: string | undefined, answers: unknown) => {
        let res: Response;
        try {
            res = await mutate(`${API_BASE}/api/automation/approvals/${encodeURIComponent(approval.id)}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision, reason, answers }),
        });
        } catch (err) {
            if (!(err instanceof RefusedError)) throw err;
            const body = errorBody(err) ?? null;
            setDetail((d) => ({ ...(d || {}), error: body?.error || tr('studio_apps_runtime.approvals.decision_rejected', 'The decision was not accepted') }));
            load();
            return;
        }
        const body = await res.json().catch(() => null);
        // A panel that has not resolved records a VOTE: the row stays pending
        // and nothing downstream fires yet — refresh and keep waiting.
        if (body?.decision === 'vote_recorded') {
            setDetail({ approval: body.approval, canDecide: false });
            load();
            return;
        }
        const fresh = body?.approval || { ...approval, status: decision === 'approve' ? 'approved' : 'rejected' };
        setDetail({ approval: fresh, canDecide: false });
        // A row whose new status no longer matches the visible slice LEAVES the
        // list — a just-approved request lingering under "waiting" reads as a bug.
        const visible = SHOW_TO_STATUS[show] ?? SHOW_TO_STATUS.waiting;
        setRows((prev) => prev
            .map((r) => (r.id === fresh.id ? fresh : r))
            .filter((r) => !visible || visible.split(',').includes(r.status)));
        // The in-app reaction channel: a wired onDecided runs its sequence
        // with the decision in the triggering form scope — TERMINAL outcomes
        // only, never an intermediate panel vote.
        if (node.onDecided && fresh.status !== 'pending') {
            const payload = {
                approvalId: fresh.id,
                decision: fresh.status,
                reason: fresh.decisionReason ?? null,
                answers: fresh.answers ?? null,
                context: fresh.context ?? null,
            };
            runAction(node.onDecided, { formValues: payload, ...payload });
        }
    }, [load, node.onDecided, runAction, show, tr]);

    // ── Editor preview ───────────────────────────────────────────────────
    if (mode !== 'run') {
        return (
            <Frame>
                {SAMPLE_ROWS.map((r) => <RowLine key={r.id} row={r} onOpen={null} open={false} />)}
                <p className="text-[11px] mt-2 text-[var(--text-tertiary)]">
                    {t('studio_apps_runtime.approvals.preview_note', 'Preview — signed-in viewers see their own approvals here.')}
                </p>
            </Frame>
        );
    }

    // ── Public/anonymous wall: no data, no fetch ─────────────────────────
    if (!currentUser) {
        return (
            <Frame>
                <div className="flex items-center gap-2.5 py-2">
                    <LogIn size={16} className="text-[var(--text-tertiary)]" aria-hidden="true" />
                    <span className="text-sm text-[var(--text-secondary)]">
                        {t('studio_apps_runtime.approvals.sign_in', 'Sign in to see and decide approvals.')}
                    </span>
                </div>
            </Frame>
        );
    }

    if (loading) {
        return <Frame><div className="flex items-center gap-2 py-2 text-sm text-[var(--text-tertiary)]"><Loader2 size={14} className="animate-spin" /> {t('studio_apps_runtime.approvals.loading', 'Loading approvals…')}</div></Frame>;
    }
    if (error) {
        return <Frame><div className="py-2 text-sm [color:var(--error)]!">{error}</div></Frame>;
    }
    if (!rows.length) {
        return <Frame><div className="py-2 text-sm text-[var(--text-tertiary)]">{emptyText}</div></Frame>;
    }

    return (
        <Frame>
            <div className="divide-y [border-color:var(--border-default,rgba(0,0,0,0.08))]">
                {rows.map((row) => (
                    <div key={row.id}>
                        <RowLine row={row} open={openId === row.id} onOpen={showDetails ? () => openRow(row) : null} />
                        {openId === row.id && (
                            <DetailPanel detail={detail} onDecide={(decision, reason, answers) => decide(detail?.approval || row, decision, reason, answers)} />
                        )}
                    </div>
                ))}
            </div>
        </Frame>
    );
}

interface FrameProps {
    children?: React.ReactNode;
}

function Frame({ children }: FrameProps) {
    const { t } = useTranslation();
    return (
        <div className="rounded-lg border px-3 py-2 [border-color:var(--border-default,rgba(0,0,0,0.08))] [background:var(--bg-primary,transparent)]" data-component="approval_list">
            <div className="flex items-center gap-1.5 mb-1 text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
                <ShieldCheck size={12} aria-hidden="true" /> {t('studio_apps_runtime.approvals.title', 'Approvals')}
            </div>
            {children}
        </div>
    );
}

interface RowLineProps {
    row: ApprovalRow;
    open: boolean;
    onOpen: (() => Promise<void>) | null;
}

function RowLine({ row, open, onOpen }: RowLineProps) {
    const { t } = useTranslation();
    const chip = approvalStatusChip(row.status);
    // A staged row says WHERE in the chain it is waiting. Someone seated in
    // stage 3 is asked only once stages 1 and 2 have passed, and without this
    // the request simply appears one day with no explanation of why now.
    const chain = row.status === 'pending' ? stageChainInfo(row) : null;
    const body = (
        <>
            {onOpen ? (open ? <ChevronDown size={14} className="shrink-0 text-[var(--text-tertiary)]" /> : <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />) : null}
            <span className="flex-1 min-w-0 text-left">
                <span className="block text-sm truncate text-[var(--text-primary)]" {...hoverable(row.prompt)}>{row.prompt || t('studio_apps_runtime.approvals.requested', 'Approval requested')}</span>
                <span className="block text-[11px] truncate text-[var(--text-tertiary)]">
                    {row.automationTitle || '—'}
                    {row.status === 'pending' && row.expiresAt ? <> · <Clock size={10} className="inline -mt-0.5" /> {formatWhen(row.expiresAt)}</> : <> · {formatWhen(row.createdAt)}</>}
                </span>
                {chain?.index && (
                    <span className="block text-[11px] truncate text-[var(--text-secondary)]" data-testid="approval-list-stage">
                        {t('approvals.stage_of', 'Stage {n} of {m}', { n: String(chain.index), m: String(chain.total) })}
                        {chain.name ? ` · ${chain.name}` : ''}
                    </span>
                )}
            </span>
            <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${chip.cls}`}>{chip.label}</span>
        </>
    );
    if (!onOpen) return <div className="flex items-center gap-2 py-2">{body}</div>;
    return (
        <button type="button" onClick={onOpen} className="w-full flex items-center gap-2 py-2 hover:opacity-80 transition" data-testid="approval-list-row">
            {body}
        </button>
    );
}

interface DetailPanelProps {
    detail: ApprovalDetail | null;
    onDecide: (decision: string, reason: string | undefined, answers: unknown) => void;
}

function DetailPanel({ detail, onDecide }: DetailPanelProps) {
    const { t } = useTranslation();
    if (!detail) {
        return <div className="pb-2 pl-6 text-[12px] text-[var(--text-tertiary)]">{t('studio_apps_runtime.approvals.loading_detail', 'Loading…')}</div>;
    }
    if (detail.error && !detail.approval) {
        return <div className="pb-2 pl-6 text-[12px] [color:var(--error)]!">{detail.error}</div>;
    }
    const { approval, canDecide } = detail;
    if (!approval) return null;
    const chain = approval.status === 'pending' ? stageChainInfo(approval) : null;
    return (
        <div className="pb-3 pl-6 space-y-3">
            {chain?.index && (
                <div className="text-[12px] text-[var(--text-secondary)]">
                    <span className="text-[var(--text-primary)]">
                        {t('approvals.stage_of', 'Stage {n} of {m}', { n: String(chain.index), m: String(chain.total) })}
                        {chain.name ? ` · ${chain.name}` : ''}
                    </span>
                    {chain.description ? <div>{chain.description}</div> : null}
                </div>
            )}
            {approval.detailsMd && (
                <div className="rounded-md px-3 py-2 text-[13px] [background:var(--bg-secondary,rgba(0,0,0,0.03))]">
                    <FormRichText>{approval.detailsMd}</FormRichText>
                </div>
            )}
            {Array.isArray(approval.attachments) && approval.attachments.length > 0 && (
                <div className="space-y-1">
                    {approval.attachments.map((att: ApprovalAttachment) => (
                        <a
                            key={att.fileId}
                            href={`${API_BASE}/api/automation/approvals/${encodeURIComponent(approval.id)}/files/${encodeURIComponent(att.fileId)}`}
                            className="flex items-center gap-2 text-[13px] hover:underline text-[var(--text-primary)]"
                        >
                            <FileText size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                            <span className="truncate" {...hoverable(att.label || att.filename)}>{att.label || att.filename}</span>
                            <Download size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                        </a>
                    ))}
                </div>
            )}
            {detail.error && <div className="text-[12px] [color:var(--error)]!">{detail.error}</div>}
            {approval.status === 'pending' ? (
                canDecide ? (
                    <ApprovalDecisionControls fields={approval.fields} onDecide={onDecide} />
                ) : (
                    <div className="text-[12px] text-[var(--text-tertiary)]">
                        {chain?.index
                            ? t('approvals.waiting_stage', 'Waiting for {name} — stage {n} of {m}.', {
                                name: chain.name || t('approvals.stage_unnamed', 'this stage'),
                                n: String(chain.index),
                                m: String(chain.total),
                            })
                            : t('studio_apps_runtime.approvals.waiting_approver', 'Waiting for the assigned approver to decide.')}
                    </div>
                )
            ) : (
                <div className="text-[12px] text-[var(--text-secondary)]">
                    {approvalStatusChip(approval.status).label}
                    {approval.decidedByName ? ` ${t('studio_apps_runtime.approvals.decided_by', 'by {name}', { name: approval.decidedByName })}` : ''}
                    {approval.decidedAt ? ` · ${formatWhen(approval.decidedAt)}` : ''}
                    {approval.decisionReason ? ` — “${approval.decisionReason}”` : ''}
                </div>
            )}
        </div>
    );
}
