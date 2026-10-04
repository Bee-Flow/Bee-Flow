import { AppWindow, ArrowUpRight, CheckCircle2, Play, Scale, ShieldCheck, Square, Table2, Workflow } from 'lucide-react';
import React from 'react';
import { kindTileStyle } from '../../../../shared/kindColors';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { kindOf } from '../phaseMachine';
import { phaseFact, totalElapsed } from '../playbookView';
import { CENTER_PATH } from './complianceView';
import { phaseLabel } from '../recipes';

function DoorLink({ icon, kind, label, name, onClick, t }) {
    const { tile, glyph } = kindTileStyle(kind, { size: 32, pct: 16 });
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-full text-left flex items-center gap-3 rounded-xl px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)', outlineColor: 'var(--accent-primary)' }}
        >
            <span style={tile}>{React.cloneElement(icon, { style: glyph, 'aria-hidden': 'true' })}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-[11px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
                <span className="block text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{name}</span>
            </span>
            <ArrowUpRight className="w-4 h-4 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            <span className="sr-only">{t('playbooks.done.open', 'Open')}</span>
        </button>
    );
}

/**
 * The end of the film: what was built, how long it took, and three doors —
 * the automation, the table, the app. A stopped playbook gets the same card
 * with what DID land; skipped and locked phases are named, not hidden.
 */
export default function DoneCard({ playbook, onNavigate, onBack, onResume = null, t, presenter = false, busy = false }) {
    const phases = Array.isArray(playbook?.phases) ? playbook.phases : [];
    const byKind = (k) => phases.find((p) => kindOf(p) === k) || null;
    const table = byKind('table')?.artifacts || {};
    // Every automation that landed gets a door — the feeding one and the approval one.
    const automations = phases.filter((p) => kindOf(p) === 'automation' && p.artifacts && p.artifacts.automationId);
    const app = byKind('app')?.artifacts || {};
    const fill = byKind('fill');
    const access = byKind('access');
    const compliance = byKind('compliance');
    const stopped = playbook?.status === 'stopped';
    const elapsed = totalElapsed(playbook);
    const doneCount = phases.filter((p) => p.status === 'done').length;
    const notBuilt = phases.filter((p) => p.status === 'skipped' || p.status === 'locked' || (stopped && p.status !== 'done'));
    const go = (route) => { if (onNavigate) onNavigate(route); };

    return (
        <div className="pbk-stage-enter h-full flex items-start justify-center overflow-y-auto" style={{ padding: presenter ? '56px 32px' : '40px 24px' }} data-testid="playbook-done">
            <div className="w-full rounded-2xl" style={{ maxWidth: 560, background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-md)', padding: presenter ? 28 : 22 }}>
                <div className="flex items-start gap-3">
                    {stopped
                        ? <Square className="w-6 h-6 mt-0.5 shrink-0" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                        : <CheckCircle2 className="w-6 h-6 mt-0.5 shrink-0" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />}
                    <div className="min-w-0">
                        <h2 className="font-semibold" style={{ fontSize: presenter ? 22 : 18, color: 'var(--text-primary)' }}>
                            {stopped ? t('playbooks.done.stopped_title', 'Stopped — this is what landed') : t('playbooks.done.title', '{title} is ready', { title: playbook.title })}
                        </h2>
                        <p className="text-xs mt-1 flex flex-wrap gap-x-2" style={{ color: 'var(--text-secondary)' }}>
                            <span>{t('playbooks.done.phases', '{n} of {total} phases built', { n: doneCount, total: phases.length })}</span>
                            {elapsed && (<><span aria-hidden="true">·</span><span>{t('playbooks.done.elapsed', 'in {time}', { time: elapsed })}</span></>)}
                            {Number.isFinite(fill?.artifacts?.rowCount) && (<><span aria-hidden="true">·</span><span>{t('playbooks.done.rows', '{n} rows', { n: fill.artifacts.rowCount })}</span></>)}
                        </p>
                    </div>
                </div>

                <div className="mt-5 grid gap-2">
                    {automations.map((p) => (
                        <DoorLink key={p.key} icon={<Workflow />} kind="automation" label={p.requires === 'approvals' ? phaseLabel(p, t) : t('playbooks.done.automation', 'Automation')} name={p.artifacts.automationTitle || t('playbooks.done.automation_unnamed', 'The automation')} onClick={() => go(`studio/automations/${p.artifacts.automationId}`)} t={t} />
                    ))}
                    {table.datatableId && <DoorLink icon={<Table2 />} kind="datatable" label={t('playbooks.done.table', 'Table')} name={table.datatableName || table.datatableKey || t('playbooks.done.table_unnamed', 'The table')} onClick={() => go(`studio/datatables/${table.datatableId}`)} t={t} />}
                    {app.appId && <DoorLink icon={<AppWindow />} kind="app" label={t('playbooks.done.app', 'App')} name={app.appName || playbook.title} onClick={() => go(`studio/apps/${app.appId}`)} t={t} />}
                    {/* The two phases the audience came for used to end the film
                        unmentioned: no door, no word, nothing. */}
                    {compliance && <DoorLink icon={<Scale />} kind="compliance" label={phaseLabel(compliance, t)} name={phaseFact(compliance, t) || t('playbooks.done.compliance_done', 'Reviewed')} onClick={() => go(CENTER_PATH)} t={t} />}
                </div>

                {access && access.artifacts && access.artifacts.accessApplied && (
                    <p className="mt-3 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }} data-testid="playbook-done-access">
                        <ShieldCheck className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />
                        {access.summary || t('playbooks.fact.access', 'Access set')}
                    </p>
                )}

                {notBuilt.length > 0 && (
                    <ul className="mt-4 text-[11px] space-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                        {notBuilt.map((p) => (
                            <li key={p.key}>
                                {phaseLabel(p, t)}
                                {': '}
                                {p.status === 'locked' ? t('playbooks.done.locked', 'not on this plan') : p.status === 'skipped' ? (p.error === 'no_status_column' ? t('playbooks.skip.no_status_column', 'The table has no status column') : t('playbooks.done.skipped', 'skipped')) : p.status === 'running' ? t('playbooks.done.interrupted', 'stopped mid-build — resume to retry it') : t('playbooks.done.not_reached', 'not reached')}
                            </li>
                        ))}
                    </ul>
                )}

                <div className="mt-5 flex justify-end gap-2">
                    {stopped && onResume ? (
                        <>
                            <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-medium" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                                {t('playbooks.done.back', 'Back to playbooks')}
                            </button>
                            <button type="button" onClick={onResume} disabled={busy} data-testid="playbook-resume" className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                                <Play className="w-3.5 h-3.5" aria-hidden="true" />{t('playbooks.done.resume', 'Resume')}
                            </button>
                        </>
                    ) : (
                        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                            {t('playbooks.done.back', 'Back to playbooks')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
