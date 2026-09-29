import React, { useEffect, useMemo, useState } from 'react';
import { FileJson, Fingerprint } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../../shared/DataTable';
import Pager from '../../../../shared/Pager';
import EmptyState from '../../../../shared/EmptyState';
import { TONES } from '../../../../shared/statusTone';
import { API, fetchJson, asArray, asObject } from '../../data/api';
import { shortHash, toMs } from './checkSort';

/**
 * EvidenceTab — the framework's evidence ledger (artboard 1b › Bewijs): a
 * flat, paged list of `compliance_evidence` rows for the regulation from
 * `GET /api/compliance/evidence?regulation=<code>&limit=&offset=` (BE-1a).
 *
 * Every row is one appended link of the org's hash chain, so the table shows
 * the hash and the sequence number — what an auditor asks for — and the
 * check it belongs to, with the title in the interface language when the
 * checks list knows it. The count comes from the same response; when the
 * body carries none, the pager renders nothing rather than "of 0".
 *
 * States: loading (skeleton), failed (its own line — an unreadable ledger is
 * not an empty one), empty, rows.
 */

export const PAGE_SIZE = 25;

const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };

/** `{ rows, total }` from the list body — an array, `{rows,total}`, `{items,count}` or junk. */
export function parseEvidenceBody(body) {
    const arr = asArray(body);
    if (arr) return { rows: arr, total: null };
    const obj = asObject(body);
    if (!obj) return null;
    const rows = asArray(obj.rows) ?? asArray(obj.items) ?? asArray(obj.evidence);
    if (!rows) return null;
    const total = [obj.total, obj.count, obj.total_count].find((n) => Number.isFinite(Number(n)) && n !== null && n !== undefined);
    return { rows, total: total === undefined ? null : Number(total) };
}

export function evidenceUrl(regulation, { limit = PAGE_SIZE, offset = 0 } = {}) {
    const q = new URLSearchParams({ regulation: String(regulation), limit: String(limit), offset: String(offset) });
    return `${API}/evidence?${q.toString()}`;
}

function formatWhen(value, locale) {
    const ms = toMs(value);
    if (ms === null) return '—';
    try {
        return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
    } catch {
        return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    }
}

export function evidenceColumns(t) {
    return [
        { id: 'captured_at', width: '150px', label: t('compliance.tbl_ev_col_when', 'Captured') },
        { id: 'check', width: '1fr', label: t('compliance.tbl_col_check', 'Check') },
        { id: 'subject', width: '140px', label: t('compliance.tbl_ev_col_subject', 'Subject'), foldBelow: 1180 },
        { id: 'hash', width: '150px', label: t('compliance.tbl_ev_col_hash', 'Hash') },
        { id: 'seq', width: '56px', label: t('compliance.tbl_ev_col_seq', 'Seq'), align: 'right' },
        { id: 'actions', width: '40px', label: '', align: 'right' },
    ];
}

export default function EvidenceTab({
    regulation,
    checks = null,
    exportsEnabled = true,
    dl = (url) => url,
    pageSize = PAGE_SIZE,
    isMobile = false,
    testId = 'evidence-tab',
}) {
    const { t, locale } = useTranslation();
    const [offset, setOffset] = useState(0);
    const [state, setState] = useState('loading'); // loading | ready | failed
    const [page, setPage] = useState(null);         // { rows, total }

    useEffect(() => { setOffset(0); }, [regulation]);

    useEffect(() => {
        if (!regulation) return undefined;
        let alive = true;
        setState('loading');
        fetchJson(evidenceUrl(regulation, { limit: pageSize, offset }))
            .then((body) => {
                if (!alive) return;
                const parsed = parseEvidenceBody(body);
                if (!parsed) { setState('failed'); return; }
                setPage(parsed);
                setState('ready');
            })
            .catch(() => { if (alive) setState('failed'); });
        return () => { alive = false; };
    }, [regulation, offset, pageSize]);

    const titleOf = useMemo(() => {
        const map = new Map();
        for (const c of Array.isArray(checks) ? checks : []) if (c?.check_id) map.set(c.check_id, c);
        return (checkId) => {
            const c = map.get(checkId);
            return c?.titleKey ? t(c.titleKey, checkId) : null;
        };
    }, [checks, t]);

    const columns = useMemo(() => evidenceColumns(t), [t]);
    const cells = Object.fromEntries(columns.map((c) => [c.id, c]));
    const rows = state === 'ready' ? page?.rows ?? [] : [];
    const total = state === 'ready' ? page?.total ?? null : null;

    const renderRow = (row) => {
        const title = titleOf(row.check_id);
        const hash = shortHash(row.hash || row.payload_hash);
        const url = exportsEnabled && row.check_id ? dl(`${API}/evidence/${encodeURIComponent(row.check_id)}`) : null;
        return (
            <TableRow columns={columns} testId={`${testId}-row-${row.id ?? row.seq}`}>
                <TableCell column={cells.captured_at} className="text-[11px] text-[var(--text-secondary)] tabular-nums whitespace-nowrap">{formatWhen(row.captured_at, locale)}</TableCell>
                <TableCell column={cells.check} className="flex flex-col gap-0.5">
                    {title && <span className="text-[12px] font-medium text-[var(--text-primary)] truncate">{title}</span>}
                    <span className="text-[10px] text-[var(--text-tertiary)] truncate" style={MONO}>{row.check_id}</span>
                </TableCell>
                <TableCell column={cells.subject} className="text-[11px] text-[var(--text-tertiary)] truncate">
                    {row.subject_type ? `${row.subject_type}${row.subject_id ? ` · ${row.subject_id}` : ''}` : null}
                </TableCell>
                <TableCell column={cells.hash} className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                    {hash && (
                        <>
                            <Fingerprint size={11} aria-hidden="true" style={{ color: TONES.success.ink, flexShrink: 0 }} />
                            <span style={MONO} title={row.hash || row.payload_hash}>{hash}</span>
                        </>
                    )}
                </TableCell>
                <TableCell column={cells.seq} className="text-[11px] text-[var(--text-tertiary)] tabular-nums">{Number.isFinite(Number(row.seq)) && row.seq !== null ? row.seq : null}</TableCell>
                <TableCell column={cells.actions} className="flex justify-end">
                    {url && (
                        <a href={url} target="_blank" rel="noopener noreferrer" aria-label={t('compliance.tbl_evidence_json', 'Evidence (JSON)')} title={t('compliance.tbl_evidence_json', 'Evidence (JSON)')}
                            className="inline-flex items-center justify-center h-7 w-7 rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                            <FileJson size={13} aria-hidden="true" />
                        </a>
                    )}
                </TableCell>
            </TableRow>
        );
    };

    // Phone (1h): the ledger folds to check · when · seq + hash, with the
    // JSON link kept as the row's one 44px target. Same strings as the row.
    const renderCard = (row) => {
        const title = titleOf(row.check_id);
        const hash = shortHash(row.hash || row.payload_hash);
        const url = exportsEnabled && row.check_id ? dl(`${API}/evidence/${encodeURIComponent(row.check_id)}`) : null;
        const seq = Number.isFinite(Number(row.seq)) && row.seq !== null ? row.seq : null;
        return (
            <div className="w-full min-w-0 flex items-center gap-2" data-testid={`${testId}-card-${row.id ?? row.seq}`}>
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    {title && <span className="text-[12px] font-medium text-[var(--text-primary)] truncate">{title}</span>}
                    <span className="text-[10px] text-[var(--text-tertiary)] truncate" style={MONO}>{row.check_id}</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] tabular-nums min-w-0">
                        <span className="whitespace-nowrap">{formatWhen(row.captured_at, locale)}</span>
                        {hash && (
                            <>
                                <Fingerprint size={11} aria-hidden="true" style={{ color: TONES.success.ink, flexShrink: 0 }} />
                                <span className="truncate" style={MONO} title={row.hash || row.payload_hash}>{hash}</span>
                            </>
                        )}
                        {seq !== null && <span className="text-[var(--text-tertiary)]">· {seq}</span>}
                    </span>
                </div>
                {url && (
                    <a href={url} target="_blank" rel="noopener noreferrer" aria-label={t('compliance.tbl_evidence_json', 'Evidence (JSON)')} title={t('compliance.tbl_evidence_json', 'Evidence (JSON)')}
                        className="inline-flex items-center justify-center h-11 w-11 flex-shrink-0 rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                        <FileJson size={15} aria-hidden="true" />
                    </a>
                )}
            </div>
        );
    };

    let empty = null;
    if (state === 'failed') {
        empty = <p className="m-0 text-[12px] text-[var(--text-tertiary)]" data-testid={`${testId}-failed`}>{t('compliance.tbl_evidence_unavailable', 'The evidence ledger could not be read.')}</p>;
    } else if (state === 'ready') {
        empty = <EmptyState title={t('compliance.tbl_evidence_empty', 'No evidence recorded for this framework yet.')} description={t('compliance.trail_evidence_hint', 'Each run appends an immutable, SHA-256-hashed evidence record (GDPR Art. 5(2) accountability).')} />;
    }

    return (
        <div className="flex flex-col gap-3" data-testid={testId} data-state={state}>
            <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r, i) => r.id ?? r.seq ?? i}
                renderRow={renderRow}
                renderCard={renderCard}
                isMobile={isMobile}
                loading={state === 'loading'}
                empty={empty}
                footer={state === 'ready' ? <Pager offset={offset} limit={pageSize} total={total} onOffset={setOffset} testId={`${testId}-pager`} /> : null}
                ariaLabel={t('compliance.tbl_evidence_aria', 'Evidence ledger')}
                testId={`${testId}-table`}
            />
        </div>
    );
}
