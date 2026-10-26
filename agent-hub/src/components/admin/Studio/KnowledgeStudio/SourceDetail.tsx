import {
    Check, ChevronDown, Ellipsis, FileSpreadsheet, FileText, Image as ImageIcon,
    Loader2, Search, ShieldCheck, TriangleAlert,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { refreshModeKey } from './freshness';
import { knowledgeApi, type KbDocument, type KbSource } from './knowledgeApi';
import { nOf } from './plural';
import ScheduleMenu from './ScheduleMenu';
import { sourceKind } from './sourceKinds';
import useRelativeTime from '@/hooks/useRelativeTime';
import useTranslation from '@/hooks/useTranslation';
import AnchoredMenu from '@/components/shared/AnchoredMenu';
import StudioSectionHeader from '@/components/shared/StudioSectionHeader';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { ScheduleChange } from './ScheduleMenu';
import type { RelativeTimeInput } from '@/hooks/useRelativeTime';
import type { SourceDetailProps, LoadArgs, FilterChipsProps, DocRowProps, PagerProps } from './SourceDetail.types';

const PAGE_SIZE = 50;
const POLL_MS = 3000;

export default function SourceDetail({
    kbId,
    kbName,
    source,
    canManage = false,
    onBack,
    onChanged,
    onRenamed,
    onSchedule,
}: SourceDetailProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [docs, setDocs] = useState<KbDocument[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState('all');
    const [query, setQuery] = useState('');
    const [offset, setOffset] = useState(0);
    const [scheduleOpen, setScheduleOpen] = useState(false);
    const scheduleRef = useRef<HTMLButtonElement>(null);

    const sid = source?.id || null;
    const params = useMemo(() => {
        const p: { limit: number; offset: number; status?: string; pii?: string; q?: string } = { limit: PAGE_SIZE, offset };
        if (filter === 'processed') p.status = 'processed,redacted';
        if (filter === 'skipped') p.status = 'skipped,error';
        if (filter === 'pii') p.pii = 'found';
        if (query.trim()) p.q = query.trim();
        return p;
    }, [filter, query, offset]);

    const load = useCallback(async ({ quiet = false }: LoadArgs = {}) => {
        if (!kbId || !sid) return;
        if (!quiet) setLoading(true);
        try {
            const body = await knowledgeApi.listSourceDocuments(kbId, sid, params);
            setDocs(Array.isArray(body?.documents) ? body.documents : []);
            setTotal(Number(body?.total) || 0);
            setError(null);
        } catch (e) {
            setError((e as Error).message || t('knowledge.err_documents', 'Could not load the documents in this source'));
            setDocs([]);
        } finally {
            if (!quiet) setLoading(false);
        }
    }, [kbId, sid, params, t]);

    useEffect(() => { load(); }, [load]);

    // Poll while anything is still being processed — the upload route answers
    // 202 with real ids and flips each row under the SAME id as it settles,
    // so the list is the progress bar. It stops the moment nothing is
    // pending, and depends on the BOOLEAN so a fresh array identity per tick
    // does not tear the interval down and rebuild it every three seconds.
    const pending = useMemo(() => docs.some(isPending), [docs]);
    useEffect(() => {
        if (!pending) return undefined;
        const id = setInterval(() => load({ quiet: true }), POLL_MS);
        return () => clearInterval(id);
    }, [pending, load]);

    const meta = sourceKind(source?.kind);
    const Icon = meta.icon;
    const counts = source || {};

    return (
        <div className="h-full flex flex-col overflow-hidden" data-testid="kb-source-detail" data-source-id={sid}>
            <StudioSectionHeader
                kind="kb"
                icon={Icon}
                title={source?.name || ''}
                onRename={canManage ? (next: string) => {
                    knowledgeApi.updateSource(kbId, String(sid), { name: next })
                        .then(() => onRenamed?.(String(sid), next))
                        .catch(e => setError(e.message));
                } : undefined}
                onBack={onBack}
                backLabel={t('knowledge.back_to_kb', 'Back to {name}', { name: kbName || '' })}
                statusChip={t('knowledge.doc_pill', '{total} files · {done} processed', {
                    total: Number(counts.documentCount) || 0,
                    done: (Number(counts.processedCount) || 0) + (Number(counts.redactedCount) || 0),
                })}
                primary={canManage ? (
                    <>
                        <button
                            ref={scheduleRef}
                            type="button"
                            onClick={() => setScheduleOpen(v => !v)}
                            aria-haspopup="menu"
                            aria-expanded={scheduleOpen}
                            className="inline-flex items-center gap-2 h-8 px-3 rounded-[10px] text-xs [border:1px_solid_var(--border-default)] [background:var(--bg-card)] [color:var(--text-primary)]!"
                        >
                            {t('knowledge.sources.refresh_label', 'Refresh: {mode}', {
                                mode: t(refreshModeKey(source?.refreshMode), source?.refreshMode || 'manual'),
                            })}
                            <ChevronDown className="w-3 h-3 text-[var(--text-tertiary)]" aria-hidden="true" />
                        </button>
                        <ScheduleMenu
                            open={scheduleOpen}
                            onClose={() => setScheduleOpen(false)}
                            anchorRef={scheduleRef}
                            source={source}
                            onChange={(refresh) => onSchedule?.(String(sid), refresh)}
                        />
                    </>
                ) : null}
            />

            <div className="flex-1 overflow-y-auto px-7 py-5 flex flex-col gap-3 text-[12px]">
                <div className="flex items-center gap-2.5">
                    <FilterChips t={t} value={filter} onChange={(v) => { setFilter(v); setOffset(0); }} source={source} />
                    <label className="relative block shrink-0 ml-auto w-[220px]">
                        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-tertiary)]" aria-hidden="true" />
                        <input
                            value={query}
                            onChange={(e) => { setQuery(e.target.value); setOffset(0); }}
                            placeholder={t('knowledge.docs.search', 'Search a file…')}
                            aria-label={t('knowledge.docs.search_label', 'Search the files in this source')}
                            className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 [background:var(--bg-card)] [border-color:var(--border-default)] [color:var(--text-primary)]! [outline-color:var(--accent-primary)]!"
                        />
                    </label>
                </div>

                <div
                    className="overflow-hidden [border-radius:12px] [background:var(--bg-card)] [border:1px_solid_var(--border-default)] [box-shadow:var(--shadow-sm)]"
                >
                    <div
                        className="grid gap-3 px-3.5 py-2 text-[10px] font-semibold uppercase [grid-template-columns:1fr_1.2fr_130px_130px_32px] [letter-spacing:.08em] [color:var(--text-tertiary)]! [border-bottom:1px_solid_var(--border-default)]"
                    >
                        <span>{t('knowledge.docs.col_file', 'File')}</span>
                        <span>{t('knowledge.docs.col_extracted', 'What the AI took from it')}</span>
                        <span>{t('knowledge.docs.col_status', 'Status')}</span>
                        <span>{t('knowledge.docs.col_changed', 'Changed')}</span>
                        <span />
                    </div>

                    {loading ? (
                        <p className="px-3.5 py-6 text-center text-[var(--text-tertiary)]">
                            <Loader2 className="w-4 h-4 animate-spin inline" aria-hidden="true" />
                            <span className="sr-only">{t('knowledge.loading', 'Loading…')}</span>
                        </p>
                    ) : error ? (
                        <p className="px-3.5 py-4 text-[var(--warning)]">{error}</p>
                    ) : docs.length === 0 ? (
                        <p className="px-3.5 py-6 text-center text-[var(--text-secondary)]">
                            {t('knowledge.docs.empty', 'Nothing here yet.')}
                        </p>
                    ) : docs.map((d, i) => (
                        <DocRow
                            key={d.id}
                            t={t}
                            rel={rel}
                            doc={d}
                            last={i === docs.length - 1}
                            canManage={canManage}
                            kbId={kbId}
                            onChanged={() => { load(); onChanged?.(); }}
                        />
                    ))}
                </div>

                {total > PAGE_SIZE && (
                    <Pager t={t} total={total} offset={offset} onOffset={setOffset} />
                )}

                <p
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                >
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    {t('knowledge.docs.redacted_note', '“Shielded” means personal data (name, address, IBAN) was replaced before the text entered the knowledge base. The AI knows the terms, not the customer.')}
                </p>

                {docs.some(d => d.pii_status === 'unscanned' && d.status !== 'skipped') && (
                    <p
                        data-testid="kb-unscanned-banner"
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--warning-ink)]"
                    >
                        <TriangleAlert className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        {t('knowledge.docs.unchecked_note', 'Some of these were stored without being checked for personal data — the checker was unavailable or the document was too large. They are checked again on the next refresh.')}
                    </p>
                )}
            </div>
        </div>
    );
}

function FilterChips({ t, value, onChange, source = {} }: FilterChipsProps) {
    const n = (k: keyof KbSource) => Number(source[k]) || 0;
    const chips = [
        { id: 'all', label: t('knowledge.docs.filter_all', 'All'), count: n('documentCount') },
        { id: 'processed', label: t('knowledge.docs.filter_processed', 'Processed'), count: n('processedCount') + n('redactedCount') },
        { id: 'skipped', label: t('knowledge.docs.filter_skipped', 'Skipped'), count: n('skippedCount') + n('errorCount'), warn: true },
        { id: 'pii', label: t('knowledge.docs.filter_pii', 'With personal data'), count: n('piiFoundCount') },
    ];
    return (
        <div role="group" aria-label={t('knowledge.docs.filter_label', 'Filter documents')} className="flex gap-1 text-[11px]">
            {chips.map(c => {
                const on = value === c.id;
                return (
                    <button
                        key={c.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onChange(c.id)}
                        data-testid={`kb-doc-filter-${c.id}`}
                        className="px-2 py-0.5 rounded-full font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                        style={on
                            ? { background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)', border: '1px solid transparent', outlineColor: 'var(--accent-primary)' }
                            : {
                                background: 'transparent',
                                color: c.warn && c.count > 0 ? 'var(--warning-ink)' : 'var(--text-secondary)',
                                border: `1px solid ${c.warn && c.count > 0 ? 'var(--warning)' : 'var(--border-default)'}`,
                                outlineColor: 'var(--accent-primary)',
                            }}
                    >
                        {c.label} {c.count}
                    </button>
                );
            })}
        </div>
    );
}

function DocRow({ t, rel, doc, last, canManage, kbId, onChanged }: DocRowProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLButtonElement>(null);
    const Icon = fileIcon(doc.mime, doc.title);
    const status = statusOfDoc(doc);

    return (
        <div
            className="grid gap-3 items-center px-3.5 py-2.5"
            style={{ gridTemplateColumns: '1fr 1.2fr 130px 130px 32px', borderBottom: last ? 'none' : '1px solid var(--border-default)' }}
            data-testid="kb-doc-row"
            data-doc-id={doc.id}
            data-status={doc.status || 'processed'}
        >
            <span className="flex items-center gap-2 min-w-0">
                <Icon className="w-3.5 h-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                <span className="min-w-0">
                    <span className="block font-medium truncate text-[var(--text-primary)]">{doc.title}</span>
                    <span className="block truncate text-[var(--text-tertiary)]">{sizeLine(t, doc)}</span>
                </span>
            </span>

            <span className="truncate" style={{ color: doc.extract_summary ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>
                {/* The summary when there is one; otherwise the reason a file
                    was skipped, which is more useful than an empty cell. */}
                {doc.extract_summary || doc.status_reason || ''}
                {doc.overlaps_document_id && (
                    <span className="text-[var(--text-tertiary)]">
                        {' · '}{t('knowledge.docs.overlaps', 'overlaps another source')}
                    </span>
                )}
            </span>

            <span className="inline-flex items-center gap-1.5 min-w-0" style={{ color: status.colour }}>
                <status.Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{t(status.key, status.fallback)}</span>
                {/* A document that was STORED without being checked must not
                    read as one that was checked and found clean. The status
                    says "processed" — true — and this says the other half. */}
                {doc.pii_status === 'unscanned' && doc.status !== 'skipped' && (
                    <span
                        data-testid="kb-doc-unscanned"
                        title={doc.status_reason || undefined}
                        className="shrink-0 px-1 rounded text-[10px] font-semibold [border:1px_solid_var(--warning)] [color:var(--warning-ink)]!"
                    >
                        {t('knowledge.docs.not_checked', 'not checked')}
                    </span>
                )}
            </span>

            <span className="text-[var(--text-secondary)]">
                {rel(doc.source_modified_at || doc.updated_at || doc.created_at)}
            </span>

            <span className="justify-self-end">
                {canManage && (
                    <>
                        <button
                            ref={menuRef}
                            type="button"
                            onClick={() => setMenuOpen(v => !v)}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-label={t('knowledge.docs.row_menu', 'Actions for {name}', { name: doc.title })}
                            className="p-1 rounded text-[var(--text-tertiary)]"
                        >
                            <Ellipsis className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                        <AnchoredMenu open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuRef} align="right" width={180} role="menu"
                            className="py-1 [background:var(--bg-card)]! [border-color:var(--border-default)]! [color:var(--text-primary)]!"
                        >
                            <button
                                type="button"
                                role="menuitem"
                                onClick={async () => {
                                    setMenuOpen(false);
                                    await knowledgeApi.removeDocument(kbId, doc.id).catch(() => {});
                                    onChanged?.();
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-secondary)] text-[var(--error)]"
                            >
                                {t('knowledge.docs.delete', 'Delete')}
                            </button>
                        </AnchoredMenu>
                    </>
                )}
            </span>
        </div>
    );
}

function Pager({ t, total, offset, onOffset }: PagerProps) {
    const from = offset + 1;
    const to = Math.min(offset + PAGE_SIZE, total);
    return (
        <div className="flex items-center gap-2 justify-end text-[var(--text-secondary)]">
            <span>{t('knowledge.docs.range', '{from}–{to} of {total}', { from, to, total })}</span>
            <button type="button" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}
                className="px-2 py-1 rounded-lg disabled:opacity-40 [border:1px_solid_var(--border-default)]">
                {t('knowledge.docs.prev', 'Previous')}
            </button>
            <button type="button" disabled={to >= total} onClick={() => onOffset(offset + PAGE_SIZE)}
                className="px-2 py-1 rounded-lg disabled:opacity-40 [border:1px_solid_var(--border-default)]">
                {t('knowledge.docs.next', 'Next')}
            </button>
        </div>
    );
}

/**
 * A row still being worked on. The upload route parks a new row as
 * `skipped` + "Queued for processing" because `processing` is not a value
 * of the documents.status CHECK (K1b deviation 2) — so the poll asks the
 * REASON, not just the status, or it would stop the moment the first row
 * was parked and never see it settle.
 */
export function isPending(doc: KbDocument | null | undefined) {
    return doc?.status === 'skipped' && /queued/i.test(String(doc?.status_reason || ''));
}

/** Status → icon, token and words. `--type-guard` is the Privacy Shield ink. */
export function statusOfDoc(doc: KbDocument | null | undefined) {
    if (isPending(doc)) return { Icon: Loader2, colour: 'var(--text-tertiary)', key: 'knowledge.docs.status_processing', fallback: 'processing' };
    switch (doc?.status) {
        case 'redacted': return { Icon: ShieldCheck, colour: 'var(--type-guard)', key: 'knowledge.docs.status_redacted', fallback: 'shielded' };
        case 'skipped': return { Icon: TriangleAlert, colour: 'var(--warning-ink)', key: 'knowledge.docs.status_skipped', fallback: 'skipped' };
        case 'error': return { Icon: TriangleAlert, colour: 'var(--error)', key: 'knowledge.docs.status_error', fallback: 'failed' };
        case 'duplicate': return { Icon: Check, colour: 'var(--text-tertiary)', key: 'knowledge.docs.status_duplicate', fallback: 'duplicate' };
        default: return { Icon: Check, colour: 'var(--success-ink)', key: 'knowledge.docs.status_processed', fallback: 'processed' };
    }
}

function fileIcon(mime: string | undefined, title: string = '') {
    const m = String(mime || '');
    if (m.startsWith('image/')) return ImageIcon;
    if (/sheet|excel|csv/i.test(m) || /\.(xlsx?|csv)$/i.test(title)) return FileSpreadsheet;
    return FileText;
}

/** "14 pagina's" / "3 tabbladen" / "1,8 MB" — whichever the file actually has. */
function sizeLine(t: TranslateFn, doc: KbDocument) {
    if (Number(doc.page_count) > 0) return nOf(t, 'knowledge.docs.pages', doc.page_count, '{count} page', '{count} pages');
    if (Number(doc.sheet_count) > 0) return nOf(t, 'knowledge.docs.sheets', doc.sheet_count, '{count} sheet', '{count} sheets');
    if (Number(doc.size_bytes) > 0) return formatBytes(doc.size_bytes);
    return '';
}

function formatBytes(n: number | undefined) {
    const mb = Number(n) / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(Number(n) / 1024))} kB`;
}
