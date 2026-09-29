import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FileJson, FolderKanban, Pencil, Plus } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import ScoreRing from '../shared/ScoreRing';
import StatusPill from '../shared/StatusPill';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import { API, asArray, asObject, fetchJson, jsonInit, json } from '../data/api';
import useResource from '../data/useResource';
import CustomChecksTable, { indexResults } from './custom/CustomChecksTable';
import FrameworkEditorDrawer from './custom/FrameworkEditorDrawer';
import QuestionnaireImport from './custom/QuestionnaireImport';
import AttestDrawer from './custom/AttestDrawer';

/**
 * CustomFrameworksPage — org-defined frameworks (CHECK-CATALOGUE §3): a
 * customer's NIS2 questionnaire, a sector code, an internal standard. Items are
 * attested by a person, with evidence and the same clocks as a built-in check —
 * or mapped onto a built-in check that already answers them.
 *
 * Two views in one page: the LIST (score ring + items + what expires soon) and,
 * once a framework is opened, its DETAIL (items table + paste-import + editor).
 *
 * Reads: `data.frameworks.custom` (the rows `GET /frameworks` already carries,
 * including the score), falling back to `GET /custom/frameworks` when the hub's
 * frameworks read is absent; `GET /custom/frameworks/:id` for the items;
 * `GET /registry` for the "satisfied by a built-in check" picker.
 * Writes: POST/PUT/DELETE `/custom/frameworks…`, `POST /custom/frameworks/:id/checks`,
 * `POST /custom/checks/:id/attest`.
 */

/** The custom-attestation vocabulary (`customFrameworkStore.OUTCOMES`). */
export const OUTCOMES = Object.freeze([
    Object.freeze({ value: 'compliant', tone: 'success', labelKey: 'compliance.custom_outcome_compliant', fallback: 'Compliant' }),
    Object.freeze({ value: 'partial', tone: 'warning', labelKey: 'compliance.custom_outcome_partial', fallback: 'Partly compliant' }),
    Object.freeze({ value: 'non_compliant', tone: 'error', labelKey: 'compliance.custom_outcome_non_compliant', fallback: 'Not compliant' }),
    Object.freeze({ value: 'not_applicable', tone: 'neutral', labelKey: 'compliance.custom_outcome_not_applicable', fallback: 'Not applicable' }),
]);

export const EXPIRY_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** Pure: one framework row, whether it came from /frameworks or from /custom/frameworks. */
export function normaliseFramework(row) {
    if (!row || typeof row !== 'object') return null;
    const id = row.custom_id || (typeof row.id === 'string' && row.id.startsWith('custom:') ? row.id.slice(7) : row.id);
    if (!id) return null;
    return {
        id: String(id),
        code: row.code || '',
        name: row.name || row.code || '',
        reference: row.reference || null,
        description: row.description || null,
        status: row.status || 'draft',
        attestation_valid_months: row.attestation_valid_months ?? 12,
        checks_count: typeof row.checks_count === 'number' ? row.checks_count : null,
        score: typeof row.score === 'number' ? row.score : null,
        locked: row.locked || null,
    };
}

export function normaliseList(rows) {
    if (!Array.isArray(rows)) return null;
    return rows.map(normaliseFramework).filter(Boolean);
}

/**
 * Pure: how many of a framework's items carry an attestation that has expired
 * or expires within 30 days. The custom runner writes `evidence.expires_at` on
 * every result row; a framework whose results have not been read yet returns
 * `null` — an unknown count renders nothing, never a 0.
 */
export function expiringCount(checks, frameworkCode, now = Date.now()) {
    if (!Array.isArray(checks) || !frameworkCode) return null;
    const mine = checks.filter(r => r && r.regulation === 'CUSTOM' && r.framework_code === frameworkCode);
    if (!mine.length) return null;
    const horizon = now + EXPIRY_WINDOW_DAYS * DAY_MS;
    let n = 0;
    for (const row of mine) {
        const raw = row.evidence?.expires_at;
        if (!raw) continue;
        const ms = new Date(raw).getTime();
        if (Number.isNaN(ms)) continue;
        if (ms <= horizon) n += 1;
    }
    return n;
}

const SECONDARY_BUTTON = 'inline-flex items-center gap-1 px-[9px] py-1 rounded-lg border border-[var(--border-default)] text-[12px] font-medium text-[var(--text-primary)] bg-[var(--bg-card)] disabled:opacity-60';

export default function CustomFrameworksPage(props) {
    const { navigate, focusId, exportsEnabled = true, dl, isMobile = false, setHeaderActions, data = {}, now } = props;
    const { t } = useTranslation();
    const fw = data.frameworks || {};
    const core = data.core || {};

    // The hub's frameworks read already carries the custom rows WITH their score;
    // only when it is absent does this page fetch the definitions itself.
    const hubList = useMemo(() => normaliseList(fw.custom), [fw.custom]);
    const own = useResource(`${API}/custom/frameworks`, { enabled: hubList === null, parse: (b) => asArray(b) });
    const list = hubList ?? normaliseList(own.data);
    const listFailed = hubList === null && own.failed && own.data === null;

    const [openId, setOpenId] = useState(focusId ? String(focusId) : null);
    const [editing, setEditing] = useState(null);      // framework row | {} for "new" | null
    const [attesting, setAttesting] = useState(null);  // joined check row | null
    const [history, setHistory] = useState(null);
    const [historyFailed, setHistoryFailed] = useState(false);
    const [busyId, setBusyId] = useState(null);
    const [detail, setDetail] = useState(null);
    const [detailFailed, setDetailFailed] = useState(false);

    useEffect(() => { if (focusId) setOpenId(String(focusId)); }, [focusId]);

    const openNew = useCallback(() => setEditing({}), []);
    useEffect(() => {
        setHeaderActions?.({ onAddFramework: openNew });
        return () => setHeaderActions?.({});
    }, [setHeaderActions, openNew]);

    const selected = useMemo(() => (list || []).find(f => f.id === openId) || null, [list, openId]);
    const results = useMemo(() => indexResults(core.checks), [core.checks]);

    const loadDetail = useCallback(async (id) => {
        setDetail(null);
        setDetailFailed(false);
        try {
            const body = await fetchJson(`${API}/custom/frameworks/${encodeURIComponent(id)}`);
            setDetail(asObject(body));
        } catch {
            setDetailFailed(true);
        }
    }, []);

    useEffect(() => { if (openId) loadDetail(openId); else { setDetail(null); setDetailFailed(false); } }, [openId, loadDetail]);

    // The built-in catalogue for the "satisfied by" picker — only while a framework is open.
    const registry = useResource(`${API}/registry`, {
        enabled: !!openId,
        parse: (b) => { const o = asObject(b); return o && Array.isArray(o.checks) ? o.checks : null; },
    });

    const refreshAll = useCallback(async () => {
        await Promise.all([
            fw.refresh?.(),
            hubList === null ? own.refresh() : Promise.resolve(),
            openId ? loadDetail(openId) : Promise.resolve(),
        ].filter(Boolean));
        data.bump?.();
        await core.refresh?.();
    }, [fw, hubList, own, openId, loadDetail, data, core]);

    const saveFramework = async (body, framework) => {
        const isNew = !framework?.id;
        const row = await fetchJson(
            isNew ? `${API}/custom/frameworks` : `${API}/custom/frameworks/${encodeURIComponent(framework.id)}`,
            jsonInit(isNew ? 'POST' : 'PUT', body),
        );
        await refreshAll();
        if (isNew && row?.id) setOpenId(String(row.id));
        return row;
    };

    const archiveFramework = async (framework) => {
        if (!framework?.id) return;
        setBusyId(framework.id);
        try {
            await fetchJson(`${API}/custom/frameworks/${encodeURIComponent(framework.id)}`, { method: 'DELETE' });
            setEditing(null);
            if (openId === framework.id) setOpenId(null);
            await refreshAll();
        } finally { setBusyId(null); }
    };

    const importChecks = async (rows) => {
        if (!openId) return;
        setBusyId(openId);
        try {
            await fetchJson(`${API}/custom/frameworks/${encodeURIComponent(openId)}/checks`, json({ checks: rows }));
            await refreshAll();
        } finally { setBusyId(null); }
    };

    const mapCheck = async (row, mappedCheckId) => {
        if (!openId) return;
        setBusyId(row.id);
        try {
            await fetchJson(`${API}/custom/frameworks/${encodeURIComponent(openId)}/checks`, json({
                checks: [{
                    ref: row.ref, title: row.title, description: row.description,
                    severity: row.severity, evidence_required: row.evidence_required,
                    mapped_check_id: mappedCheckId, sort_order: row.sort_order,
                }],
            }));
            await refreshAll();
        } finally { setBusyId(null); }
    };

    const deleteCheck = async (row) => {
        setBusyId(row.id);
        try {
            await fetchJson(`${API}/custom/checks/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
            await refreshAll();
        } finally { setBusyId(null); }
    };

    const openAttest = async (row) => {
        setAttesting(row);
        setHistory(null);
        setHistoryFailed(false);
        try {
            const body = await fetchJson(`${API}/custom/checks/${encodeURIComponent(row.id)}/attestations`);
            setHistory(Array.isArray(body) ? body : []);
        } catch { setHistoryFailed(true); }
    };

    const attest = async ({ outcome, statement, evidence_refs: refs }) => {
        await fetchJson(`${API}/custom/checks/${encodeURIComponent(attesting.id)}/attest`, json({
            outcome, statement, evidence_refs: refs,
        }));
        await refreshAll();
    };

    // ── Detail ─────────────────────────────────────────────────────────────
    if (selected) {
        const exportUrl = dl?.(`${API}/custom/frameworks/${encodeURIComponent(selected.id)}/export.json`);
        return (
            <div className="relative h-full min-h-0 overflow-y-auto p-3.5 @[1100px]/cpage:px-7 @[1100px]/cpage:py-[18px] flex flex-col gap-3.5 text-xs" data-testid="custom-detail">
                <div className="flex items-center gap-2 flex-wrap">
                    <button type="button" className={SECONDARY_BUTTON} onClick={() => setOpenId(null)} data-testid="custom-back">
                        <ArrowLeft size={12} aria-hidden="true" />{t('compliance.custom_back', 'All frameworks')}
                    </button>
                    <span className="font-semibold text-[13px] truncate" data-testid="custom-detail-name">{selected.name}</span>
                    <span className="font-mono text-[11px] text-[var(--text-tertiary)]">{selected.code}</span>
                    <StatusPill tone={selected.status === 'active' ? 'success' : 'neutral'} testId="custom-detail-status">
                        {t(`compliance.custom_status_fw_${selected.status}`, selected.status === 'active' ? 'Active' : 'Draft')}
                    </StatusPill>
                    <div className="ml-auto flex items-center gap-2">
                        <QuestionnaireImport onImport={importChecks} busy={busyId === openId} />
                        {exportUrl && exportsEnabled && (
                            <a className={SECONDARY_BUTTON} href={exportUrl} data-testid="custom-export">
                                <FileJson size={12} aria-hidden="true" />{t('compliance.custom_export', 'Answer pack (JSON)')}
                            </a>
                        )}
                        <button type="button" className={SECONDARY_BUTTON} onClick={() => setEditing(selected)} data-testid="custom-edit">
                            <Pencil size={12} aria-hidden="true" />{t('common.edit', 'Edit')}
                        </button>
                    </div>
                </div>

                {detailFailed ? (
                    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-[var(--text-tertiary)]" data-testid="custom-detail-failed">
                        {t('compliance.custom_detail_failed', 'The items of this framework could not be read.')}
                    </div>
                ) : (
                    <CustomChecksTable
                        checks={detail?.checks ?? null}
                        results={results}
                        frameworkCode={selected.code}
                        builtinChecks={registry.data}
                        busyId={busyId}
                        isMobile={isMobile}
                        onAttest={openAttest}
                        onMap={mapCheck}
                        onDelete={deleteCheck}
                    />
                )}

                <FrameworkEditorDrawer
                    open={!!editing}
                    framework={editing?.id ? editing : null}
                    onClose={() => setEditing(null)}
                    onSave={saveFramework}
                    onArchive={archiveFramework}
                    busy={busyId === selected.id}
                />
                <AttestDrawer
                    open={!!attesting}
                    uploadsEnabled={exportsEnabled}
                    onClose={() => setAttesting(null)}
                    title={attesting?.title || ''}
                    subtitle={selected.name}
                    reference={attesting ? `${selected.code} · ${attesting.ref}` : null}
                    options={OUTCOMES}
                    initialOutcome={null}
                    evidenceRequired={!!attesting?.evidence_required}
                    subjectId={attesting?.id || null}
                    uploadSubjectType="custom_check"
                    history={history}
                    historyFailed={historyFailed}
                    onSubmit={attest}
                    testId="custom-attest-drawer"
                />
            </div>
        );
    }

    // ── List ───────────────────────────────────────────────────────────────
    return (
        <div className="relative h-full min-h-0 overflow-y-auto p-3.5 @[1100px]/cpage:px-7 @[1100px]/cpage:py-[18px] flex flex-col gap-3.5 text-xs" data-testid="custom-page">
            <div className="flex items-start gap-2.5">
                <FolderKanban size={15} className="text-[var(--text-secondary)] shrink-0 mt-px" aria-hidden="true" />
                <p className="text-[var(--text-secondary)] leading-4 max-w-[70ch]">
                    {t('compliance.custom_intro', 'A customer questionnaire, a sector code or an internal standard: attest the items yourself — with evidence, an expiry date and the same clocks as a built-in check. An item that a built-in check already answers can point at it instead.')}
                </p>
                <button type="button" className="ml-auto inline-flex items-center gap-1 px-[9px] py-1 rounded-lg text-[12px] font-semibold" style={PRIMARY_ACTION_STYLE} onClick={openNew} data-testid="custom-new">
                    <Plus size={12} aria-hidden="true" />{t('compliance.custom_new', 'New framework')}
                </button>
            </div>

            {listFailed ? (
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-[var(--text-tertiary)]" data-testid="custom-list-failed">
                    {t('compliance.custom_list_failed', 'Your own frameworks could not be read.')}
                </div>
            ) : list === null ? (
                <div className="grid gap-2.5 grid-cols-1 @[860px]/cpage:grid-cols-2" data-testid="custom-loading" aria-busy="true">
                    {[0, 1].map(i => <div key={i} className="h-[92px] rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] animate-pulse" />)}
                </div>
            ) : list.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--border-default)] px-3.5 py-6 text-center text-[var(--text-secondary)] leading-4" data-testid="custom-empty">
                    {t('compliance.custom_empty', 'No own frameworks yet. Start with the questionnaire a customer last sent you.')}
                </div>
            ) : (
                <div className="grid gap-2.5 grid-cols-1 @[860px]/cpage:grid-cols-2" data-testid="custom-grid">
                    {list.map(f => {
                        const expiring = expiringCount(core.checks, f.code, now);
                        return (
                            <button
                                key={f.id}
                                type="button"
                                onClick={() => setOpenId(f.id)}
                                className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] px-3.5 py-3 flex items-center gap-3 text-left hover:bg-[var(--bg-secondary)]"
                                style={{ boxShadow: 'var(--shadow-sm)' }}
                                data-testid="custom-card"
                                data-framework={f.id}
                            >
                                <ScoreRing score={f.score} size={36} label={f.name} testId="custom-card-score" />
                                <div className="min-w-0 flex flex-col gap-0.5">
                                    <span className="font-semibold truncate">{f.name}</span>
                                    <span className="font-mono text-[10px] text-[var(--text-tertiary)] truncate">{f.code}{f.reference ? ` · ${f.reference}` : ''}</span>
                                    <span className="text-[11px] text-[var(--text-secondary)]">
                                        {typeof f.checks_count === 'number' && t('compliance.custom_card_items', '{n} items', { n: f.checks_count })}
                                        {expiring !== null && expiring > 0 && (
                                            <span data-testid="custom-card-expiring">{typeof f.checks_count === 'number' ? ' · ' : ''}{t('compliance.custom_card_expiring', '{n} expiring', { n: expiring })}</span>
                                        )}
                                    </span>
                                </div>
                                <StatusPill className="ml-auto" tone={f.status === 'active' ? 'success' : 'neutral'} testId="custom-card-status">
                                    {t(`compliance.custom_status_fw_${f.status}`, f.status === 'active' ? 'Active' : 'Draft')}
                                </StatusPill>
                            </button>
                        );
                    })}
                </div>
            )}

            <FrameworkEditorDrawer
                open={!!editing}
                framework={editing?.id ? editing : null}
                onClose={() => setEditing(null)}
                onSave={saveFramework}
                onArchive={archiveFramework}
            />
            {navigate && (
                <button type="button" className={`${SECONDARY_BUTTON} w-fit`} onClick={() => navigate('frameworks')} data-testid="custom-to-frameworks">
                    <ArrowLeft size={12} aria-hidden="true" />{t('compliance.custom_to_frameworks', 'Back to frameworks')}
                </button>
            )}
        </div>
    );
}
