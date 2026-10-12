import React, { useEffect, useMemo } from 'react';
import { ArrowLeftRight, Check, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import { TONES } from '../../../shared/statusTone';
import { API, asArray } from '../data/api';
import useResource from '../data/useResource';

/**
 * PortabilityPage — the Data Act export matrix (Art. 30 / Art. 23; CHECK-CATALOGUE §4.1).
 *
 * One row per kind of data the platform holds for this organisation, from
 * `GET /api/compliance/portability` (server/compliance/dataPortability/exportRegistry.js →
 * `coverageMatrix`):
 *
 *   { kind, label_key, held: number|null, held_scope: 'org'|'platform',
 *     route: { method, path } | null, extra_routes: [{method,path}],
 *     render_only: { method, path, formats } | null, formats: string[],
 *     scope: 'per-item'|'bulk', mounted: boolean, gap_key: string|null }
 *
 * The five kinds WITHOUT a portable route (agents, knowledge bases, conversations,
 * AI webpages, form submissions) are the point of the page, not an accident: they
 * render in error ink with the product-gap note the registry carries. A declared
 * route that is not mounted any more is the same red — the matrix is an honest
 * inventory, never a marketing table.
 *
 * `held` is `null` when the count could not be read (an unprovisioned table):
 * that renders nothing, never a `0`.
 */

/** Pure: the tone one matrix row wears. A missing route and a broken route are both red. */
export function rowTone(row) {
    if (!row) return 'neutral';
    if (!row.route) return 'error';
    if (!row.mounted) return 'error';
    return 'success';
}

/** Pure: is this kind portable today? (a route that exists AND is mounted) */
export function isPortable(row) {
    return !!(row && row.route && row.mounted);
}

/** Pure: `{ portable, total, held }` over the matrix; `null` until it is loaded. */
export function coverageSummary(rows) {
    if (!Array.isArray(rows)) return null;
    return {
        total: rows.length,
        portable: rows.filter(isPortable).length,
        held: rows.filter(r => typeof r.held === 'number' && r.held > 0).length,
    };
}

/** Pure: every route the row declares, flattened for the route cell. */
export function routeLines(row) {
    const out = [];
    if (row?.route) out.push({ ...row.route, role: 'primary' });
    for (const r of row?.extra_routes || []) out.push({ ...r, role: 'extra' });
    if (row?.render_only) out.push({ method: row.render_only.method, path: row.render_only.path, role: 'render_only' });
    return out;
}

const MONO = 'font-mono text-[11px]';

export default function PortabilityPage(props) {
    const { isMobile = false, setHeaderActions } = props;
    const { t } = useTranslation();
    const res = useResource(`${API}/portability`, { parse: (b) => asArray(b) });
    const rows = res.data;
    const summary = useMemo(() => coverageSummary(rows), [rows]);

    useEffect(() => {
        setHeaderActions?.({ portabilityCoverage: summary, onRefreshPortability: res.refresh });
        return () => setHeaderActions?.({});
    }, [setHeaderActions, summary, res.refresh]);

    const columns = [
        { id: 'kind', width: '1fr', label: t('compliance.pf_col_kind', 'Kind of data') },
        { id: 'held', width: '84px', align: 'right', label: t('compliance.pf_col_held', 'Held') },
        { id: 'route', width: '2fr', label: t('compliance.pf_col_route', 'Export route') },
        { id: 'formats', width: '150px', label: t('compliance.pf_col_formats', 'Formats'), foldBelow: 1180 },
        { id: 'mounted', width: '90px', label: t('compliance.pf_col_mounted', 'Served') },
        { id: 'scope', width: '96px', label: t('compliance.pf_col_scope', 'Scope'), foldBelow: 1180 },
    ];

    if (res.failed && rows === null) {
        return (
            <div className="h-full min-h-0 overflow-y-auto p-3.5 @[1100px]/cpage:px-7 @[1100px]/cpage:py-[18px]" data-testid="portability-page-failed">
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]">
                    {t('compliance.pf_read_failed', 'The export matrix could not be read.')}
                </div>
            </div>
        );
    }

    return (
        <div className="h-full min-h-0 overflow-y-auto p-3.5 @[1100px]/cpage:px-7 @[1100px]/cpage:py-[18px] flex flex-col gap-3.5 text-xs" data-testid="portability-page">
            {/* The coverage is said twice already: the header pill and the
                table's footer sentence. The intro only explains the matrix. */}
            <section
                className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] px-3.5 py-3 flex items-start gap-2.5 shadow-[var(--shadow-sm)]"
                data-testid="pf-intro"
            >
                <ArrowLeftRight size={15} className="text-[var(--text-secondary)] shrink-0 mt-px" aria-hidden="true" />
                <div className="min-w-0 flex flex-col gap-1">
                    <span className="font-semibold">{t('compliance.pf_title', 'Data Act export matrix')}</span>
                    <p className="text-[var(--text-secondary)] leading-4">
                        {t('compliance.pf_intro', 'Art. 30 asks that a customer can take their data along when they switch: every kind this platform holds, in a structured, commonly used, machine-readable format. A kind without a working export route is a gap in the exit procedure — it is listed here, not hidden.')}
                    </p>
                </div>
            </section>

            <DataTable
                columns={columns}
                rows={rows || []}
                loading={rows === null}
                isMobile={isMobile}
                rowKey={(r) => r.kind}
                ariaLabel={t('compliance.pf_title', 'Data Act export matrix')}
                testId="pf-table"
                renderCard={(row) => {
                    const gap = !row.route;
                    return (
                        <div className="w-full min-w-0 flex flex-col gap-1" data-testid="pf-card" data-kind={row.kind}>
                            <span className="flex items-center gap-2 min-w-0">
                                <span className="text-xs font-medium truncate" data-testid="pf-kind" data-kind={row.kind}>{t(row.label_key, row.kind)}</span>
                                {typeof row.held === 'number' && <span className="tabular-nums text-[11px] text-[var(--text-secondary)]" data-testid="pf-held">{row.held}</span>}
                            </span>
                            {row.held_scope === 'platform' && (
                                <span className="text-[10px] text-[var(--text-tertiary)]">{t('compliance.pf_scope_platform', 'platform-wide, not per organisation')}</span>
                            )}
                            {gap ? (
                                <span className="flex items-start gap-1.5 min-w-0 text-[11px]" data-testid="pf-gap" style={{ color: TONES.error.ink }}>
                                    <TriangleAlert size={12} className="shrink-0 mt-px" aria-hidden="true" />
                                    <span className="leading-4">
                                        <b className="font-semibold">{t('compliance.pf_no_route', 'No export route')}</b>
                                        {row.gap_key ? <>{' · '}<span className="font-normal">{t(row.gap_key, '')}</span></> : null}
                                    </span>
                                </span>
                            ) : routeLines(row).map(r => (
                                <span
                                    key={`${r.method} ${r.path}`}
                                    className={`${MONO} truncate text-[11px]`}
                                    style={{ color: r.role === 'render_only' ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}
                                    data-testid={r.role === 'render_only' ? 'pf-route-render-only' : 'pf-route'}
                                    title={`${r.method} ${r.path}`}
                                >
                                    {r.method} {r.path}
                                    {r.role === 'render_only' && <span> · {t('compliance.pf_render_only', 'renders, does not migrate')}</span>}
                                </span>
                            ))}
                            <span className="flex items-center gap-2 flex-wrap text-[11px]">
                                {row.route ? (
                                    <span
                                        className="inline-flex items-center gap-1 font-semibold"
                                        style={{ color: row.mounted ? TONES.success.ink : TONES.error.ink }}
                                        data-testid="pf-mounted"
                                        data-mounted={row.mounted ? 'true' : 'false'}
                                    >
                                        {row.mounted ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
                                        {row.mounted ? t('compliance.pf_mounted_yes', 'yes') : t('compliance.pf_mounted_no', 'not served')}
                                    </span>
                                ) : (
                                    <span className="text-[var(--text-tertiary)]" data-testid="pf-mounted" data-mounted="none">—</span>
                                )}
                                <span className="text-[var(--text-secondary)]">{row.scope === 'bulk' ? t('compliance.pf_scope_bulk', 'in bulk') : t('compliance.pf_scope_item', 'per item')}</span>
                                {row.formats?.length ? (
                                    <span className="flex flex-wrap gap-1" data-testid="pf-formats">
                                        {row.formats.map(f => (
                                            <span key={f} className="px-[6px] py-px rounded-full border border-[var(--border-default)] text-[10px] uppercase tracking-[.04em] text-[var(--text-secondary)]">{f}</span>
                                        ))}
                                    </span>
                                ) : null}
                            </span>
                        </div>
                    );
                }}
                renderRow={(row, ctx) => {
                    const tone = rowTone(row);
                    const gap = !row.route;
                    return (
                        <TableRow
                            key={row.kind}
                            columns={ctx.columns}
                            accent={tone === 'success' ? null : tone}
                            testId="pf-row"
                        >
                            <TableCell column={ctx.columns[0]} className="min-w-0">
                                <div className="flex flex-col gap-0.5 min-w-0">
                                    <span className="font-medium truncate" data-testid="pf-kind" data-kind={row.kind}>{t(row.label_key, row.kind)}</span>
                                    {row.held_scope === 'platform' && (
                                        <span className="text-[10px] text-[var(--text-tertiary)]">{t('compliance.pf_scope_platform', 'platform-wide, not per organisation')}</span>
                                    )}
                                </div>
                            </TableCell>
                            <TableCell column={ctx.columns[1]} align="right" className="tabular-nums text-[var(--text-secondary)]">
                                {typeof row.held === 'number' ? <span data-testid="pf-held">{row.held}</span> : <span className="text-[var(--text-tertiary)]">—</span>}
                            </TableCell>
                            <TableCell column={ctx.columns[2]} className="min-w-0">
                                <div className="flex flex-col gap-0.5 min-w-0">
                                    {gap && (
                                        <div className="flex items-start gap-1.5 min-w-0" data-testid="pf-gap" style={{ color: TONES.error.ink }}>
                                            <TriangleAlert size={12} className="shrink-0 mt-px" aria-hidden="true" />
                                            <span className="leading-4">
                                                <b className="font-semibold">{t('compliance.pf_no_route', 'No export route')}</b>
                                                {row.gap_key ? <>{' · '}<span className="font-normal">{t(row.gap_key, '')}</span></> : null}
                                            </span>
                                        </div>
                                    )}
                                    {routeLines(row).map(r => (
                                        <span
                                            key={`${r.method} ${r.path}`}
                                            className={`${MONO} truncate`}
                                            style={{ color: r.role === 'render_only' ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}
                                            data-testid={r.role === 'render_only' ? 'pf-route-render-only' : 'pf-route'}
                                            title={`${r.method} ${r.path}`}
                                        >
                                            {r.method} {r.path}
                                            {r.role === 'render_only' && <span> · {t('compliance.pf_render_only', 'renders, does not migrate')}</span>}
                                        </span>
                                    ))}
                                </div>
                            </TableCell>
                            <TableCell column={ctx.columns[3]} className="min-w-0">
                                {row.formats?.length ? (
                                    <span className="flex flex-wrap gap-1" data-testid="pf-formats">
                                        {row.formats.map(f => (
                                            <span key={f} className="px-[6px] py-px rounded-full border border-[var(--border-default)] text-[10px] uppercase tracking-[.04em] text-[var(--text-secondary)]">{f}</span>
                                        ))}
                                    </span>
                                ) : (
                                    <span className="text-[var(--text-tertiary)]">—</span>
                                )}
                            </TableCell>
                            <TableCell column={ctx.columns[4]}>
                                {row.route ? (
                                    <span
                                        className="inline-flex items-center gap-1 text-[11px] font-semibold"
                                        style={{ color: row.mounted ? TONES.success.ink : TONES.error.ink }}
                                        data-testid="pf-mounted"
                                        data-mounted={row.mounted ? 'true' : 'false'}
                                    >
                                        {row.mounted ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
                                        {row.mounted ? t('compliance.pf_mounted_yes', 'yes') : t('compliance.pf_mounted_no', 'not served')}
                                    </span>
                                ) : (
                                    <span className="text-[var(--text-tertiary)]" data-testid="pf-mounted" data-mounted="none">—</span>
                                )}
                            </TableCell>
                            <TableCell column={ctx.columns[5]} className="text-[11px] text-[var(--text-secondary)]">
                                {row.scope === 'bulk' ? t('compliance.pf_scope_bulk', 'in bulk') : t('compliance.pf_scope_item', 'per item')}
                            </TableCell>
                        </TableRow>
                    );
                }}
                footer={summary ? (
                    <div className="px-3.5 py-2 text-[11px] text-[var(--text-tertiary)] leading-4" data-testid="pf-footer">
                        {t('compliance.pf_footer', '{portable} of {total} kinds have a working export route. The gaps are product work, tracked with the Data Act checks — the exit procedure describes them honestly until they close.', summary)}
                    </div>
                ) : null}
            />
        </div>
    );
}
