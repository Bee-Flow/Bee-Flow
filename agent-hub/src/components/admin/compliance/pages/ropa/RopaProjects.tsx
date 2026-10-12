// The processing register's "Collaborative projects" section: the projects
// that signals show hold personal data, and every project that already has a
// record. The admin records a purpose, a lawful basis and an optional
// retention per project; a recorded project becomes a processing activity in
// the register above, and GDPR-Art30-project-personal-data passes for it.
//
// loading ≠ empty ≠ failed: each has its own line. A partial list (a signal
// source could not be read) says so rather than looking complete.

import { ExternalLink } from 'lucide-react';
import React, { useId, useState } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { useDateFormat } from '../../shared/formatDates';
import StatusPill from '../../shared/StatusPill';
import { LEGAL_BASES } from '../settings/settingsFields';

export interface ProjectRecord {
    purpose?: string | null;
    lawful_basis?: string | null;
    retention_days?: number | null;
    confirmed_at?: string | null;
}

export interface RopaProjectRow {
    project_id: string;
    name: string;
    kinds: string[];
    special: boolean;
    sources?: string[];
    registration: ProjectRecord | null;
}

export interface RopaProjectsBody { projects?: RopaProjectRow[]; complete?: boolean; error?: boolean }

export interface ProjectRecordBody { purpose: string | null; lawful_basis: string; retention_days: number | null }

const KIND_FALLBACK: Record<string, string> = {
    name: 'Names', email: 'E-mail addresses', phone: 'Phone numbers', address: 'Addresses',
    id_number: 'Identity numbers', financial: 'Bank and payment details', birth: 'Dates of birth',
    health: 'Health data', online_id: 'Online identifiers', supplier: 'Supplier contacts', personal: 'Personal data',
};

const INPUT = 'w-full rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]';
const BTN = 'inline-flex items-center h-7 px-2.5 rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-60';
const PRIMARY = 'inline-flex items-center h-7 px-2.5 rounded-[8px] text-[11px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-60';

function RecordForm({ row, onSave, onRemove, onClose }: {
    row: RopaProjectRow;
    onSave: (projectId: string, body: ProjectRecordBody) => Promise<unknown>;
    onRemove?: (projectId: string) => Promise<unknown>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const ids = { purpose: useId(), basis: useId(), days: useId() };
    const reg = row.registration;
    const [purpose, setPurpose] = useState(reg?.purpose || '');
    const [basis, setBasis] = useState(reg?.lawful_basis || '');
    const [days, setDays] = useState(reg?.retention_days != null ? String(reg.retention_days) : '');
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true); setFailed(false);
        try { await fn(); onClose(); } catch { setFailed(true); } finally { setBusy(false); }
    };
    const save = () => run(() => onSave(row.project_id, {
        purpose: purpose.trim() || null,
        lawful_basis: basis,
        retention_days: days.trim() ? Number(days) : null,
    }));

    return (
        <form
            className="flex flex-col gap-1.5 p-2 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)]"
            aria-label={t('compliance.ropa_projects.form_aria', 'Processing record for {name}', { name: row.name })}
            onSubmit={(e) => { e.preventDefault(); if (basis) void save(); }}
            data-testid={`ropa-project-form-${row.project_id}`}
        >
            <label htmlFor={ids.purpose} className="text-[11px] font-medium text-[var(--text-primary)]">{t('compliance.ropa_projects.purpose', 'Purpose')}</label>
            <textarea id={ids.purpose} rows={2} maxLength={1000} value={purpose} onChange={(e) => setPurpose(e.target.value)} className={`${INPUT} py-1`} />
            <label htmlFor={ids.basis} className="text-[11px] font-medium text-[var(--text-primary)]">{t('compliance.ropa_projects.lawful_basis', 'Lawful basis')}</label>
            <select id={ids.basis} value={basis} onChange={(e) => setBasis(e.target.value)} className={`${INPUT} h-7`} required>
                <option value="">{t('compliance.ropa_projects.choose_basis', 'Choose a lawful basis')}</option>
                {LEGAL_BASES.map((b: { value: string; key: string; en: string }) => <option key={b.value} value={b.value}>{t(b.key, b.en)}</option>)}
            </select>
            <label htmlFor={ids.days} className="text-[11px] font-medium text-[var(--text-primary)]">{t('compliance.ropa_projects.retention', 'Keep for (days, optional)')}</label>
            <input id={ids.days} type="number" min={30} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className={`${INPUT} h-7 w-32`} />
            <div className="flex flex-wrap items-center gap-2 pt-1">
                <button type="submit" className={PRIMARY} disabled={busy || !basis} data-testid={`ropa-project-save-${row.project_id}`}>
                    {busy ? t('compliance.ropa_projects.saving', 'Saving…') : t('compliance.ropa_projects.save', 'Save record')}
                </button>
                {reg && onRemove ? (
                    <button type="button" className={BTN} disabled={busy} onClick={() => run(() => onRemove(row.project_id))} data-testid={`ropa-project-remove-${row.project_id}`}>
                        {t('compliance.ropa_projects.remove', 'Remove record')}
                    </button>
                ) : null}
                <button type="button" className={BTN} disabled={busy} onClick={onClose}>{t('compliance.ropa_projects.cancel', 'Cancel')}</button>
                {failed ? <span role="alert" className="text-[11px] text-[var(--text-secondary)]">{t('compliance.ropa_projects.save_failed', 'The record could not be saved.')}</span> : null}
            </div>
        </form>
    );
}

export default function RopaProjects({ body, onSave, onRemove, onNavigate }: {
    body: RopaProjectsBody | null | undefined;
    onSave?: (projectId: string, body: ProjectRecordBody) => Promise<unknown>;
    onRemove?: (projectId: string) => Promise<unknown>;
    onNavigate?: ((path: string) => void) | null;
}) {
    const { t } = useTranslation();
    const { formatDay } = useDateFormat();
    const [editing, setEditing] = useState<string | null>(null);
    const loading = body === null || body === undefined;
    const failed = !loading && (!!body.error || !Array.isArray(body.projects));
    const rows = !loading && !failed ? (body.projects as RopaProjectRow[]) : [];
    const basisLabel = (v: string | null | undefined) => {
        const b = LEGAL_BASES.find((x: { value: string }) => x.value === v) as { key: string; en: string } | undefined;
        return b ? t(b.key, b.en) : (v || '');
    };

    return (
        <section className="flex flex-col gap-2" data-testid="ropa-projects">
            <h3 className="m-0 text-xs font-bold text-[var(--text-primary)]">{t('compliance.ropa_projects.title', 'Collaborative projects')}</h3>
            <p className="m-0 text-xs text-[var(--text-secondary)]">
                {t('compliance.ropa_projects.desc', 'Projects where signals show personal data, and every project with a record. Record the purpose, lawful basis and retention; recorded projects appear in the register above.')}
            </p>
            {loading ? <p className="m-0 text-xs text-[var(--text-tertiary)]" data-testid="ropa-projects-loading">{t('compliance.ropa_projects.loading', 'Reading projects…')}</p> : null}
            {failed ? <p className="m-0 text-xs text-[var(--text-tertiary)]" data-testid="ropa-projects-failed">{t('compliance.ropa_projects.failed', 'The projects could not be read.')}</p> : null}
            {!loading && !failed && body.complete === false ? (
                <p className="m-0 text-xs text-[var(--text-tertiary)]" data-testid="ropa-projects-partial">{t('compliance.ropa_projects.partial', 'Some signals could not be read, so this list may be incomplete.')}</p>
            ) : null}
            {!loading && !failed && rows.length === 0 ? (
                <p className="m-0 text-xs text-[var(--text-tertiary)]" data-testid="ropa-projects-empty">{t('compliance.ropa_projects.empty', 'No project holds personal data according to the latest signals.')}</p>
            ) : null}
            {rows.length > 0 ? (
                <ul className="m-0 p-0 list-none flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)]" data-testid="ropa-projects-list">
                    {rows.map((row) => (
                        <li key={row.project_id} className="flex flex-col gap-1.5 px-3 py-2 border-t border-[var(--border-default)] first:border-t-0" data-testid={`ropa-project-${row.project_id}`}>
                            <div className="flex flex-wrap items-center gap-2">
                                {onNavigate ? (
                                    <button type="button" onClick={() => onNavigate(`projects/${row.project_id}`)} className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--text-primary)] hover:underline">
                                        {row.name} <ExternalLink className="w-3 h-3 text-[var(--text-tertiary)]" aria-hidden="true" />
                                    </button>
                                ) : <span className="text-xs font-semibold text-[var(--text-primary)]">{row.name}</span>}
                                {row.special ? <StatusPill tone="warning" icon={null} title={undefined} testId={`ropa-project-special-${row.project_id}`}>{t('compliance.ropa_projects.special', 'Special category')}</StatusPill> : null}
                                <span className="text-[11px] text-[var(--text-secondary)]">
                                    {row.kinds.map((k) => t(`compliance.pd_kind.${k}`, KIND_FALLBACK[k] || k)).join(', ')}
                                </span>
                                <span className="ml-auto text-[11px] text-[var(--text-secondary)]" data-testid={`ropa-project-record-${row.project_id}`}>
                                    {row.registration?.lawful_basis
                                        ? t('compliance.ropa_projects.confirmed', '{basis} · confirmed {date}', {
                                            basis: basisLabel(row.registration.lawful_basis),
                                            date: formatDay(row.registration.confirmed_at),
                                        })
                                        : t('compliance.ropa_projects.no_record', 'None yet')}
                                </span>
                                {onSave && editing !== row.project_id ? (
                                    <button type="button" className={BTN} onClick={() => setEditing(row.project_id)} data-testid={`ropa-project-edit-${row.project_id}`}>
                                        {row.registration ? t('compliance.ropa_projects.edit', 'Edit') : t('compliance.ropa_projects.record', 'Record')}
                                    </button>
                                ) : null}
                            </div>
                            {onSave && editing === row.project_id ? (
                                <RecordForm row={row} onSave={onSave} onRemove={onRemove} onClose={() => setEditing(null)} />
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
