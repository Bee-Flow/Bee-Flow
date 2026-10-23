import {
    AlertTriangle, Database, FileText, Loader2, RefreshCw, Table2, Workflow,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import useTranslation from '../../hooks/useTranslation';
import { formatRelativeTime } from '../../utils/dateFormatters';
import { API_BASE, authFetch } from '../../utils/helpers';
import type { Filed } from '../../components/admin/Studio/Solutions/useAddFiling';
import type { TranslateParams } from '../../hooks/useTranslation';
import type { TableRef, AutomationRef, WarningRef, DataCardsPayload, CardProps, ChipProps, ColumnChipsProps, TableCardProps, AutomationCardProps, WarningCardProps, KnowledgeCardProps, WebpageDataCardsProps } from './WebpageDataCards.types';

const CARDS_URL = (id: string | number | boolean) => `${API_BASE}/api/webpages/${encodeURIComponent(id)}/data-cards`;

async function readJson(res: Response) {
    try { return await res.json(); } catch { return null; }
}

export function Card({ children, tone = 'default' }: CardProps) {
    const border = tone === 'warning' ? 'var(--warning)' : 'var(--border-subtle)';
    return (
        <div
            className="rounded-lg border p-3 flex flex-col gap-2"
            style={{ borderColor: border, background: 'var(--bg-secondary, transparent)' }}
        >
            {children}
        </div>
    );
}

export function Chip({ label, tone = 'default', dashed = false, title }: ChipProps) {
    const color = tone === 'public' ? 'var(--kind-web)'
        : tone === 'muted' ? 'var(--text-secondary)'
            : 'var(--text-primary)';
    return (
        <span
            title={title}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] border"
            style={{ color, borderColor: color, borderStyle: dashed ? 'dashed' : 'solid' }}
        >
            {label}
        </span>
    );
}

function ColumnChips({ t, columns, publicColumns, allColumns }: ColumnChipsProps) {
    const labelOf = (key: string) => {
        const f = (allColumns || []).find(c => c.key === key);
        return (f && f.label) || key;
    };
    if (!columns.length) {
        return (
            <span className="text-[11px] text-[var(--text-secondary)]">
                {t('webpages.data.no_columns_bound', 'No columns picked yet — this page reads nothing from this table')}
            </span>
        );
    }
    const isPublic = new Set(publicColumns || []);
    return (
        <div className="flex flex-wrap gap-1">
            {columns.map(key => (
                <Chip
                    key={key}
                    label={isPublic.has(key) ? `${labelOf(key)} · ${t('webpages.visibility.public', 'Public')}` : labelOf(key)}
                    tone={isPublic.has(key) ? 'public' : 'default'}
                    title={key}
                />
            ))}
        </div>
    );
}

function TableCard({ t, table }: TableCardProps) {
    if (table.missing) {
        return (
            <Card>
                <div className="flex items-center gap-2">
                    <Table2 size={14} className="text-[var(--text-secondary)]" />
                    <span className="text-sm font-medium">
                        {t('webpages.data.table_unavailable', 'Table unavailable')}
                    </span>
                </div>
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.data.table_unavailable_hint',
                        'This page is still linked to {id}, but you cannot open it right now.',
                        { id: table.datatableId })}
                </p>
            </Card>
        );
    }
    return (
        <Card>
            <div className="flex items-center gap-2 flex-wrap">
                <Table2 size={14} style={{ color: 'var(--type-data, #10b981)' }} />
                <span className="text-sm font-medium">{table.name || table.datatableId}</span>
                <Chip
                    label={table.mode === 'readwrite'
                        ? t('webpages.data.mode_readwrite', 'Read and write')
                        : t('webpages.data.mode_read', 'Read only')}
                    tone="muted"
                />
                {/* Alleen als we het echt hebben kunnen vaststellen. */}
                {table.usedInCode === false && (
                    <Chip label={t('webpages.data.not_used', 'Not used on this page')} tone="muted" dashed />
                )}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">
                {table.rowCount === null
                    ? t('webpages.data.rows_unknown', 'Row count unavailable')
                    : t(table.rowCount === 1 ? 'webpages.data.rows' : 'webpages.data.rows_plural',
                        table.rowCount === 1 ? '{count} row (approximate)' : '{count} rows (approximate)',
                        { count: table.rowCount })}
            </div>
            <ColumnChips
                t={t}
                columns={table.columns || []}
                publicColumns={table.publicColumns || []}
                allColumns={table.allColumns || []}
            />
        </Card>
    );
}

function AutomationCard({ t, automation }: AutomationCardProps) {
    return (
        <Card>
            <div className="flex items-center gap-2 flex-wrap">
                <Workflow size={14} style={{ color: 'var(--type-trigger)' }} />
                <span className="text-sm font-medium">
                    {automation.title || t('webpages.data.automation_untitled', 'Untitled automation')}
                </span>
                <Chip
                    label={automation.writes
                        ? t('webpages.data.automation_writes', 'Writes')
                        : t('webpages.data.automation_reads', 'Reads')}
                    tone="muted"
                />
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">
                {t('webpages.data.automation_feeds', 'Feeds {table}', { table: automation.tableName || automation.datatableId })}
                {' · '}
                {automation.lastRunAt
                    ? t('webpages.data.automation_last_run', 'last run {when}', { when: formatRelativeTime(automation.lastRunAt) })
                    : t('webpages.data.automation_never_ran', 'never ran')}
            </div>
            {automation.columns?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {automation.columns.map(c => <Chip key={c} label={c} tone="muted" />)}
                </div>
            )}
        </Card>
    );
}

/**
 * De deeplink naar de Delen-tab van een tabel.
 *
 * `?tab=sharing` wordt vandaag door de Studio-router nog niet gelezen (die
 * kent alleen view/run/step), dus de knop landt op het juiste tabelscherm en
 * niet op het juiste tabblad. Bewust wél meegestuurd: de bedoeling staat er nu
 * in, en de Studio-kant hoeft er straks alleen naar te luisteren.
 */
export function sharingDeepLink(datatableId: string | number | boolean) {
    return `studio/datatables/${encodeURIComponent(datatableId)}?tab=sharing`;
}

function WarningCard({ t, warning, onNavigate }: WarningCardProps) {
    const path = sharingDeepLink(warning.datatableId);
    const label = t('webpages.data.warn_set_up', 'Set up');
    return (
        <Card tone="warning">
            <div className="flex items-start gap-2">
                <AlertTriangle size={14} style={{ color: 'var(--warning)', marginTop: 2 }} />
                <div className="flex-1">
                    <p className="text-sm">
                        {t('webpages.data.warn_writes_directly',
                            '{automation} writes straight into table {table}.',
                            {
                                automation: warning.automationTitle || t('webpages.data.automation_untitled', 'Untitled automation'),
                                table: warning.tableName || warning.datatableId,
                            })}
                    </p>
                    <p className="text-[11px] mt-1 text-[var(--text-secondary)]">
                        {t('webpages.data.warn_writes_directly_hint',
                            'Changes made there show up on this page without anyone editing it.')}
                    </p>
                </div>
                {/* Met een in-app navigator zacht navigeren; zonder alsnog een
                    echte link, want een knop die nergens heen gaat is erger dan
                    een volledige paginalading. */}
                {typeof onNavigate === 'function' ? (
                    <button type="button" className="text-[11px] underline shrink-0" onClick={() => onNavigate(path)}>
                        {label}
                    </button>
                ) : (
                    <a className="text-[11px] underline shrink-0" href={`/app/${path}`}>{label}</a>
                )}
            </div>
        </Card>
    );
}

function KnowledgeCard({ t, sources }: KnowledgeCardProps) {
    const n = sources.length;
    return (
        <Card>
            <div className="flex items-center gap-2">
                <FileText size={14} style={{ color: 'var(--kind-kb)' }} />
                <span className="text-sm font-medium">{t('webpages.data.knowledge', 'Knowledge sources')}</span>
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">
                {t(n === 1 ? 'webpages.data.knowledge_count' : 'webpages.data.knowledge_count_plural',
                    n === 1 ? '{count} source the assistant reads when building this page'
                        : '{count} sources the assistant reads when building this page',
                    { count: n })}
            </div>
        </Card>
    );
}

export default function WebpageDataCards({ webpageId, sources = [], onNavigate = null }: WebpageDataCardsProps) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ loading: boolean; error: string | null; data: DataCardsPayload | null }>({ loading: true, error: null, data: null });

    const load = useCallback(async () => {
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const res = await authFetch(CARDS_URL(webpageId));
            const body = await readJson(res);
            if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
            setState({ loading: false, error: null, data: body });
        } catch (e) {
            // Een mislukte lezing is NIET "er hangt niets aan deze pagina": dan
            // zou de auteur denken dat zijn bindingen weg zijn.
            setState({ loading: false, error: (e as Error).message || 'failed', data: null });
        }
    }, [webpageId]);

    useEffect(() => { if (webpageId) load(); }, [webpageId, load]);

    if (state.loading) {
        return (
            <div className="p-4 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <Loader2 size={14} className="animate-spin" />
                {t('webpages.data.loading', 'Loading what feeds this page…')}
            </div>
        );
    }

    if (state.error) {
        return (
            <div className="p-4 flex flex-col gap-2 items-start">
                <p className="text-sm text-[var(--warning)]">
                    {t('webpages.data.load_failed', 'Could not load what is linked to this page.')}
                </p>
                <button type="button" className="text-xs underline inline-flex items-center gap-1" onClick={load}>
                    <RefreshCw size={12} /> {t('webpages.retry', 'Try again')}
                </button>
            </div>
        );
    }

    const tables = state.data?.tables || [];
    const automations = state.data?.automations || [];
    const warnings = state.data?.warnings || [];

    return (
        <div className="p-3 flex flex-col gap-3">
            {warnings.map(w => (
                <WarningCard key={`${w.automationId}:${w.datatableId}`} t={t} warning={w} onNavigate={onNavigate} />
            ))}

            {tables.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-sm border-[var(--border-subtle)] text-[var(--text-secondary)]">
                    <div className="flex items-center gap-2">
                        <Database size={14} />
                        {t('webpages.data.no_tables', 'No table is linked to this page yet.')}
                    </div>
                </div>
            )}
            {tables.map(tb => <TableCard key={tb.datatableId} t={t} table={tb} />)}

            {automations.map(a => (
                <AutomationCard key={`${a.automationId}:${a.datatableId}`} t={t} automation={a} />
            ))}

            <KnowledgeCard t={t} sources={sources || []} />
        </div>
    );
}

/**
 * Wat de tab-badge telt: tabellen + voedende automatiseringen + de ene
 * Kennisbronnen-kaart. Geëxporteerd zodat de tab dezelfde som maakt als het
 * scherm, in plaats van hem een tweede keer op te schrijven.
 *
 * De KB-kaart telt ALTIJD mee, ook bij nul bronnen: hij staat er dan ook, en
 * "nul bronnen" is zelf informatie. Zonder data (nog aan het laden, of de
 * lezing mislukte) is het antwoord 0 en niet 1 — een badge hoort niets te
 * beloven wat het scherm nog niet kan laten zien.
 */
export function countDataCards(data: DataCardsPayload | null | undefined) {
    if (!data) return 0;
    return (data.tables?.length || 0) + (data.automations?.length || 0) + 1;
}
