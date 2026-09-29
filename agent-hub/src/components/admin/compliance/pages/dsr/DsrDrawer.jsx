/**
 * The DSR drawer (artboard 1c, right column): the clock as a block, the data
 * subject (masked), the timeline, what Bee Flow found, the summary and the
 * actions. Closed requests open read-only (Export only).
 *
 * Personal data leaves Bee Flow only by e-mail to the data subject
 * (BFSF-441): the drawer shows the masked address, the export is the file of
 * this request — not the data — and fulfilling e-mails the subject server-side.
 *
 * `mode`: 'inline' (≥1180, beside the table) | 'overlay' (below 1180, over
 * the table; the host is `relative`) | 'modal' (phones: Modal placement="right").
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
    BadgeCheck, BookOpen, ClipboardList, FileJson, MailCheck, MessageSquareText, Play, ShieldCheck, Table,
} from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SideDrawer, { DrawerId, DrawerSection } from '../../../../shared/SideDrawer';
import DeadlineClock from '../../../../shared/DeadlineClock';
import Modal from '../../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { TONES } from '../../../../shared/statusTone';
import {
    articleOf, channelOf, clockPropsOf, completedAtOf, dueAtOf, identityOf, isClosed, isOverdue, receivedAtOf, stateOf,
} from './dsrArticles';
import { channelLabel, formatDateTime, shownEmailOf, typeLabel } from './DsrTable';

const SECONDARY = 'flex-1 inline-flex items-center justify-center gap-1.5 h-[30px] px-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] disabled:opacity-50';
const INPUT = 'w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-2 text-[12px] text-[var(--text-primary)] leading-4 outline-none focus:border-[var(--kind-compliance)]';

function toMs(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime();
    return Number.isFinite(n) ? n : null;
}

/** Tolerant read of one server timeline row → { at, text, tone }. */
export function normaliseTimelineRow(t, row) {
    if (!row || typeof row !== 'object') return null;
    const at = toMs(row.at ?? row.occurred_at ?? row.created_at ?? row.ts ?? row.timestamp);
    const text = row.label ?? row.text ?? row.message ?? row.description ?? row.event ?? row.kind ?? '';
    const actor = row.actor_name ?? row.actor ?? row.by ?? null;
    const tone = row.tone === 'error' || row.severity === 'error' || /overdue|expired|verstreken/i.test(String(row.event ?? row.kind ?? '')) ? 'error' : null;
    return { at, text: actor ? t('compliance.dsr_tl_by', '{text} · by {actor}', { text: String(text), actor: String(actor) }) : String(text), tone };
}

/** The facts we always have when the server has no timeline yet. */
export function fallbackTimeline(t, request, now = Date.now()) {
    const rows = [];
    const received = receivedAtOf(request);
    if (received !== null) rows.push({ at: received, text: t('compliance.dsr_tl_received', 'Received via {channel} · clock started', { channel: channelLabel(t, channelOf(request)) }), tone: null });
    const started = toMs(request?.started_at);
    if (started !== null) {
        const by = request?.started_by_name ?? request?.started_by ?? null;
        rows.push({ at: started, text: by ? t('compliance.dsr_tl_started_by', 'Started by {name}', { name: String(by) }) : t('compliance.dsr_tl_started', 'Started'), tone: null });
    }
    const extended = toMs(request?.extended_until);
    if (extended !== null) rows.push({ at: toMs(request?.extended_at) ?? started ?? received, text: t('compliance.dsr_tl_extended', 'Extended to {date}', { date: formatDateTime(extended) }), tone: null });
    if (isOverdue(request, now)) rows.push({ at: dueAtOf(request), text: t('compliance.dsr_tl_overdue', 'Deadline passed'), tone: 'error' });
    const completed = completedAtOf(request);
    if (completed !== null) {
        rows.push({ at: completed, text: stateOf(request) === 'rejected' ? t('compliance.dsr_tl_rejected', 'Rejected') : t('compliance.dsr_tl_fulfilled', 'Fulfilled · data subject e-mailed'), tone: null });
    }
    return rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

function count(v) {
    if (Array.isArray(v)) return v.length;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

const SOURCE_KIND = [
    ['memories', /memor/i],
    ['rows', /datatable|table|row/i],
    ['form_answers', /form/i],
    ['kb_documents', /kb|knowledge|document/i],
];

/**
 * Discovery body → the four facts the artboard shows. Reads BE-2's
 * `{ sources:[{kind, count, items:[{title}]}], retention_notes:[] }` and the
 * flat `{ memories, rows, tables, form_answers, kb_documents, retained_rows }`
 * spelling alike. Unknown counts render nothing.
 */
export function readDiscovery(discovery) {
    if (!discovery || typeof discovery !== 'object') return null;
    const out = { memories: null, rows: null, tables: [], form_answers: null, kb_documents: null, retention_notes: [] };
    if (Array.isArray(discovery.sources)) {
        for (const src of discovery.sources) {
            const kindWord = String(src?.kind ?? src?.id ?? '');
            const hit = SOURCE_KIND.find(([, re]) => re.test(kindWord));
            if (!hit) continue;
            const n = count(src?.count ?? src?.items);
            if (n === null) continue;
            out[hit[0]] = (out[hit[0]] ?? 0) + n;
            if (hit[0] === 'rows' && Array.isArray(src?.items)) {
                out.tables.push(...src.items.map(i => i?.title ?? i?.name).filter(Boolean));
                out.retention_notes.push(...src.items.map(i => i?.retention_note).filter(Boolean));
            }
        }
    }
    if (out.memories === null) out.memories = count(discovery.memories ?? discovery.memory_count);
    if (out.rows === null) out.rows = count(discovery.rows ?? discovery.row_count ?? discovery.datatable_rows);
    if (!out.tables.length && Array.isArray(discovery.tables)) out.tables = discovery.tables.map(x => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
    if (out.form_answers === null) out.form_answers = count(discovery.form_answers ?? discovery.form_answer_count);
    if (out.kb_documents === null) out.kb_documents = count(discovery.kb_documents ?? discovery.documents ?? discovery.kb_document_count);
    if (Array.isArray(discovery.retention_notes)) out.retention_notes.push(...discovery.retention_notes.map(x => (typeof x === 'string' ? x : x?.text ?? x?.note)).filter(Boolean));
    if (discovery.retention_note) out.retention_notes.push(String(discovery.retention_note));
    out.retained_rows = count(discovery.retained_rows);
    return out;
}

export function discoveryChips(t, discovery) {
    const d = readDiscovery(discovery);
    if (!d) return [];
    const chips = [];
    if (d.memories !== null) chips.push({ id: 'memories', icon: MessageSquareText, color: null, muted: d.memories === 0, label: t('compliance.dsr_found_memories', '{n} memories', { n: d.memories }) });
    if (d.rows !== null) {
        chips.push({ id: 'rows', icon: Table, color: 'var(--type-data)', muted: d.rows === 0, label: d.tables.length ? t('compliance.dsr_found_rows_in', '{n} rows · {tables}', { n: d.rows, tables: [...new Set(d.tables)].join(', ') }) : t('compliance.dsr_found_rows', '{n} rows', { n: d.rows }) });
    }
    if (d.form_answers !== null) chips.push({ id: 'form_answers', icon: ClipboardList, color: 'var(--type-pause)', muted: d.form_answers === 0, label: t('compliance.dsr_found_form_answers', '{n} form answers', { n: d.form_answers }) });
    if (d.kb_documents !== null) chips.push({ id: 'kb_documents', icon: BookOpen, color: null, muted: d.kb_documents === 0, label: t('compliance.dsr_found_kb_docs', '{n} knowledge-base documents', { n: d.kb_documents }) });
    return chips;
}

function useLazy(loader, id) {
    const [value, setValue] = useState(undefined);
    useEffect(() => {
        if (!loader || id === null || id === undefined) { setValue(undefined); return undefined; }
        let alive = true;
        setValue(undefined);
        Promise.resolve()
            .then(() => loader(id))
            .then(v => { if (alive) setValue(v ?? null); })
            .catch(() => { if (alive) setValue(null); });
        return () => { alive = false; };
    }, [loader, id]);
    return value;
}

function DrawerBody({ request, busy, exportUrl, onFulfil, onReject, onExtend, onStart, loadTimeline, loadDiscovery, testId }) {
    const { t, resolvedLocale, locale } = useTranslation();
    const lang = resolvedLocale || locale;
    const closed = isClosed(request);
    const state = stateOf(request);
    const identity = identityOf(request);
    const [summary, setSummary] = useState('');
    const [rejecting, setRejecting] = useState(false);
    const [rejectReason, setRejectReason] = useState('');
    const [extending, setExtending] = useState(false);
    const [extendReason, setExtendReason] = useState('');

    useEffect(() => {
        setSummary(request?.result_summary || '');
        setRejecting(false); setRejectReason('');
        setExtending(false); setExtendReason('');
    }, [request?.id]);

    const timelineRaw = useLazy(loadTimeline, request?.id);
    const discovery = useLazy(loadDiscovery, request?.id);

    const timeline = useMemo(() => {
        const rows = Array.isArray(timelineRaw) ? timelineRaw.map(r => normaliseTimelineRow(t, r)).filter(Boolean) : null;
        return rows && rows.length ? rows : fallbackTimeline(t, request);
    }, [timelineRaw, request, t]);

    const chips = useMemo(() => discoveryChips(t, discovery), [discovery, t]);
    const read = useMemo(() => readDiscovery(discovery), [discovery]);
    const retentionNotes = read?.retention_notes?.length
        ? read.retention_notes
        : (read?.retained_rows > 0 ? [t('compliance.dsr_retention_note', '{n} rows fall under a statutory retention duty — those are anonymised, not deleted.', { n: read.retained_rows })] : []);

    const received = receivedAtOf(request);
    const due = dueAtOf(request);
    const extendedUntil = toMs(request?.extended_until);

    return (
        <>
            <DeadlineClock variant="block" {...clockPropsOf(request)} testId={`${testId}-clock`}>
                {t('compliance.dsr_clock_meta', 'Received {received} · due {due} · {extended}', {
                    received: formatDateTime(received, lang),
                    due: formatDateTime(due, lang),
                    extended: extendedUntil !== null
                        ? t('compliance.dsr_clock_extended', 'extended to {date}', { date: formatDateTime(extendedUntil, lang) })
                        : t('compliance.dsr_clock_not_extended', 'not extended'),
                })}
            </DeadlineClock>

            {state === 'pending' && onStart && (
                <button type="button" onClick={onStart} disabled={busy} data-testid={`${testId}-start`}
                    className="self-start inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)] disabled:opacity-50">
                    <Play size={12} aria-hidden="true" />{t('compliance.dsr_start', 'Start working')}
                </button>
            )}

            <DrawerSection label={t('compliance.dsr_sec_subject', 'Data subject')} testId={`${testId}-subject`}>
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-[12px]" data-testid={`${testId}-email`}>{shownEmailOf(request)}</span>
                    {identity === 'verified_link' || identity === 'verified_manual' ? (
                        <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: TONES.success.ink }} data-testid={`${testId}-identity`} data-identity={identity}>
                            <BadgeCheck size={11} aria-hidden="true" />
                            {identity === 'verified_manual'
                                ? t('compliance.dsr_identity_verified_manual', 'identity confirmed by the handler')
                                : t('compliance.dsr_identity_verified_link', 'identity confirmed via e-mail link')}
                        </span>
                    ) : identity === 'employee' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-identity`} data-identity="employee">
                            <BadgeCheck size={11} aria-hidden="true" />{t('compliance.dsr_identity_employee', 'employee')}
                        </span>
                    ) : (
                        <span className="inline-flex items-center text-[11px] px-2 py-[1px] rounded-full text-[var(--text-secondary)]" style={{ border: '1px dashed var(--text-tertiary)' }}
                            data-testid={`${testId}-identity`} data-identity={identity}>
                            {t('compliance.dsr_identity_pending', 'identity not yet confirmed')}
                        </span>
                    )}
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.dsr_full_address_note', 'The full address is visible only to the DPO and the handler.')}</div>
                {request?.notes && (
                    <div className="text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap" data-testid={`${testId}-notes`}>
                        <span className="text-[var(--text-tertiary)]">{t('compliance.dsr_notes', 'Notes from the requester')}: </span>{request.notes}
                    </div>
                )}
            </DrawerSection>

            <DrawerSection label={t('compliance.dsr_sec_timeline', 'Timeline')} testId={`${testId}-timeline`}>
                <div className="flex flex-col gap-[3px] text-[11px] text-[var(--text-secondary)]" role="list">
                    {timeline.map((row, i) => (
                        <div key={i} role="listitem" className="flex gap-2" style={row.tone === 'error' ? { color: TONES.error.ink } : undefined} data-tone={row.tone || undefined}>
                            <span className={`w-[78px] shrink-0 ${row.tone === 'error' ? '' : 'text-[var(--text-tertiary)]'}`}>{formatDateTime(row.at, lang)}</span>
                            <span className="min-w-0">{row.text}</span>
                        </div>
                    ))}
                </div>
            </DrawerSection>

            {chips.length > 0 && (
                <DrawerSection label={t('compliance.dsr_sec_found', 'Found in Bee Flow')} testId={`${testId}-found`}>
                    <div className="flex flex-wrap gap-1 text-[11px]">
                        {chips.map(c => {
                            const Icon = c.icon;
                            return (
                                <span key={c.id} data-testid={`${testId}-chip-${c.id}`}
                                    className={`inline-flex items-center gap-1 px-2 py-[2px] rounded-full border border-[var(--border-default)] ${c.muted ? 'text-[var(--text-tertiary)]' : ''}`}>
                                    <Icon size={11} aria-hidden="true" style={c.color && !c.muted ? { color: c.color } : undefined} />{c.label}
                                </span>
                            );
                        })}
                    </div>
                    {retentionNotes.map((note, i) => (
                        <div key={i} className="text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-retention`}>{note}</div>
                    ))}
                </DrawerSection>
            )}

            <DrawerSection label={t('compliance.dsr_sec_summary', 'Summary of the handling')} testId={`${testId}-summary`}>
                {closed ? (
                    <div className="text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap" data-testid={`${testId}-summary-text`}>
                        {request?.result_summary || <span className="text-[var(--text-tertiary)]">—</span>}
                    </div>
                ) : (
                    <textarea
                        value={summary}
                        onChange={e => setSummary(e.target.value)}
                        rows={3}
                        placeholder={t('compliance.dsr_summary_placeholder', 'What was done to fulfil (or why rejected) — kept as the accountability record.')}
                        className={`${INPUT} min-h-[56px] resize-y`}
                        data-testid={`${testId}-summary-input`}
                    />
                )}
            </DrawerSection>

            <div className="mt-auto flex flex-col gap-1.5 pt-1" data-testid={`${testId}-actions`}>
                {!closed && (
                    <>
                        <button type="button" disabled={busy} data-testid={`${testId}-fulfil`}
                            onClick={() => onFulfil?.({ status: 'fulfilled', result_summary: summary || undefined, notify_subject: true })}
                            className="inline-flex items-center justify-center gap-1.5 h-[34px] rounded-[10px] text-[12px] font-semibold disabled:opacity-50"
                            style={PRIMARY_ACTION_STYLE}>
                            <MailCheck size={13} aria-hidden="true" />{t('compliance.dsr_fulfil_and_mail', 'Fulfil and e-mail the data subject')}
                        </button>
                        {rejecting && (
                            <div className="flex flex-col gap-1.5" data-testid={`${testId}-reject-form`}>
                                <input value={rejectReason} onChange={e => setRejectReason(e.target.value)} className={INPUT}
                                    placeholder={t('compliance.dsr_reject_reason', 'Reason for rejecting — goes into the reply to the data subject')}
                                    data-testid={`${testId}-reject-reason`} />
                                <div className="flex gap-1.5">
                                    <button type="button" className={SECONDARY} disabled={busy || !rejectReason.trim()} data-testid={`${testId}-reject-confirm`}
                                        onClick={() => onReject?.({ status: 'rejected', result_summary: rejectReason.trim(), notify_subject: true })}>
                                        {t('compliance.dsr_reject_confirm', 'Reject and e-mail the data subject')}
                                    </button>
                                    <button type="button" className={SECONDARY} onClick={() => setRejecting(false)}>{t('common.cancel', 'Cancel')}</button>
                                </div>
                            </div>
                        )}
                        {extending && (
                            <div className="flex flex-col gap-1.5" data-testid={`${testId}-extend-form`}>
                                <input value={extendReason} onChange={e => setExtendReason(e.target.value)} className={INPUT}
                                    placeholder={t('compliance.dsr_extend_reason', 'Reason for the extension (Art. 12(3): complexity or number of requests)')}
                                    data-testid={`${testId}-extend-reason`} />
                                <div className="flex gap-1.5">
                                    <button type="button" className={SECONDARY} disabled={busy || !extendReason.trim()} data-testid={`${testId}-extend-confirm`}
                                        onClick={() => onExtend?.(extendReason.trim())}>
                                        {t('compliance.dsr_extend_confirm', 'Extend by 60 days')}
                                    </button>
                                    <button type="button" className={SECONDARY} onClick={() => setExtending(false)}>{t('common.cancel', 'Cancel')}</button>
                                </div>
                            </div>
                        )}
                        <div className="flex gap-1.5">
                            <button type="button" className={SECONDARY} disabled={busy} data-testid={`${testId}-reject`}
                                onClick={() => { setRejecting(v => !v); setExtending(false); }} aria-expanded={rejecting}>
                                {t('compliance.dsr_reject_ellipsis', 'Reject…')}
                            </button>
                            {extendedUntil === null && onExtend && (
                                <button type="button" className={SECONDARY} disabled={busy} data-testid={`${testId}-extend`}
                                    onClick={() => { setExtending(v => !v); setRejecting(false); }} aria-expanded={extending}>
                                    {t('compliance.dsr_extend_60', 'Extend +60 d')}
                                </button>
                            )}
                            {exportUrl && (
                                <a href={exportUrl} download className={SECONDARY} data-testid={`${testId}-export`}>
                                    <FileJson size={12} aria-hidden="true" />{t('compliance.dsr_export', 'Export')}
                                </a>
                            )}
                        </div>
                    </>
                )}
                {closed && exportUrl && (
                    <div className="flex gap-1.5">
                        <a href={exportUrl} download className={SECONDARY} data-testid={`${testId}-export`}>
                            <FileJson size={12} aria-hidden="true" />{t('compliance.dsr_export', 'Export')}
                        </a>
                    </div>
                )}
                <div className="flex items-start gap-1.5 text-[11px] text-[var(--text-tertiary)] leading-[15px]">
                    <ShieldCheck size={12} aria-hidden="true" className="shrink-0 mt-px" style={{ color: 'var(--kind-compliance)' }} />
                    <span>{t('compliance.dsr_privacy_note', 'Personal data leaves Bee Flow only by e-mail to the data subject. The export is the file of this request, not the data.')}</span>
                </div>
            </div>
        </>
    );
}

function DrawerHeader({ request, t }) {
    const article = articleOf(request?.request_type);
    return (
        <div className="flex items-center gap-2 min-w-0">
            <DrawerId>#{request?.id}</DrawerId>
            <span className="font-semibold text-[13px] truncate">{typeLabel(t, request?.request_type)}</span>
            <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                {article
                    ? t('compliance.dsr_article_via', 'Art. {n} · via {channel}', { n: article, channel: channelLabel(t, channelOf(request)) })
                    : t('compliance.dsr_via', 'via {channel}', { channel: channelLabel(t, channelOf(request)) })}
            </span>
        </div>
    );
}

export default function DsrDrawer({
    request = null,
    open = false,
    onClose,
    mode = 'inline',
    width = 380,
    busy = false,
    exportUrl = null,
    onFulfil,
    onReject,
    onExtend,
    onStart,
    loadTimeline,
    loadDiscovery,
    testId = 'dsr-drawer',
}) {
    const { t } = useTranslation();
    if (!open || !request) return null;
    const body = (
        <DrawerBody
            key={request.id}
            request={request}
            busy={busy}
            exportUrl={exportUrl}
            onFulfil={onFulfil}
            onReject={onReject}
            onExtend={onExtend}
            onStart={onStart}
            loadTimeline={loadTimeline}
            loadDiscovery={loadDiscovery}
            testId={testId}
        />
    );
    const ariaLabel = t('compliance.dsr_drawer_aria', 'Request #{id}', { id: request.id });
    if (mode === 'modal') {
        return (
            <Modal open onClose={onClose} placement="right" size="md" title={<DrawerHeader request={request} t={t} />} className={testId}>
                <div className="flex flex-col gap-3.5 min-h-full" data-testid={testId} data-mode="modal">
                    <div className="contents" data-testid={`${testId}-body`} data-state={isClosed(request) ? 'done' : stateOf(request)} data-readonly={isClosed(request) || undefined}>{body}</div>
                </div>
            </Modal>
        );
    }
    return (
        <SideDrawer open onClose={onClose} mode={mode} width={width} ariaLabel={ariaLabel} header={<DrawerHeader request={request} t={t} />} testId={testId}>
            <div className="contents" data-testid={`${testId}-body`} data-state={isClosed(request) ? 'done' : stateOf(request)} data-readonly={isClosed(request) || undefined}>{body}</div>
        </SideDrawer>
    );
}
