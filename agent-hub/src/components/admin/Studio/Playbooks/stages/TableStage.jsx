import { Check, Cloud, Loader2, Table2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef } from 'react';
import RowsPreview from './RowsPreview';
import StageShell from './StageShell';
import { heroCard, isBusy, stageType } from './stageChrome';
import { revealSchedule } from '../../../../shared/builder/revealSchedule';

const COL_STAGGER_MS = 350;

/**
 * Phase 1 — the server creates (or verifies) the table. Nothing to type, so
 * the film is the table itself materialising: the tile lands, then the
 * columns slide in one by one (revealSchedule, 350 ms apart). An existing
 * table shows its mapping as ✓ rows instead. Under reduced motion every
 * column is simply there.
 */
export default function TableStage({ phase, dispatch, t, reducedMotion = false, presenter = false, tableMode = 'new', onNavigate = null }) {
    const status = phase?.status;
    const art = phase?.artifacts || {};
    const startedRef = useRef(null);
    useEffect(() => {
        if (status !== 'ready') return;
        const stamp = `${phase.key}:${phase.attempt || 0}`;
        if (startedRef.current === stamp) return;
        startedRef.current = stamp;
        dispatch({ type: 'start', key: phase.key });
    }, [status, phase, dispatch]);

    const fields = useMemo(() => (Array.isArray(art.fields) ? art.fields : []), [art.fields]);
    const schedule = useMemo(() => revealSchedule(fields.map((f) => f.key), { stagger: COL_STAGGER_MS }), [fields]);
    const mapping = art.mapping && typeof art.mapping === 'object' ? art.mapping : null;
    const landed = status === 'awaiting' || status === 'done';
    const failed = status === 'failed';
    const type = stageType(presenter);

    // One line that says where the table stands, in the shell's status slot.
    const statusLine = failed
        ? t('playbooks.table.failed', 'The table did not land')
        : isBusy(status)
            ? (<><Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{tableMode === 'existing' ? t('playbooks.table.checking', 'Checking the columns…') : t('playbooks.table.creating', 'Creating the table…')}</>)
            : landed
                ? (
                    <>
                        <span>{t('playbooks.table.ready', 'Table ready')}</span>
                        {Number.isFinite(art.rowCount) && (<><span aria-hidden="true">·</span><span className="tabular-nums">{t('playbooks.table.rows', '{n} rows', { n: art.rowCount })}</span></>)}
                    </>
                )
                : null;

    return (
        <StageShell
            kind="datatable"
            icon={Table2}
            width="narrow"
            presenter={presenter}
            testId="playbook-stage-table"
            phaseKey={phase?.key}
            title={art.datatableName || t('playbooks.table.pending_name', 'The table')}
            status={statusLine}
            tone={failed ? 'error' : 'busy'}
            actions={art.isMirror ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full" style={{ fontSize: type.meta, background: 'color-mix(in srgb, var(--type-ai) 12%, transparent)', color: 'var(--type-ai)' }}>
                    <Cloud className="w-3 h-3" aria-hidden="true" />{t('playbooks.table.mirror', 'Nextcloud mirror')}
                </span>
            ) : null}
        >
            <div style={heroCard(presenter)}>
                    {fields.length === 0 && landed && (
                        <p style={{ fontSize: type.body, color: 'var(--text-secondary)' }} data-testid="playbook-table-empty">
                            {t('playbooks.table.no_columns', 'The table landed, but it has no columns yet.')}
                        </p>
                    )}
                    {fields.length > 0 && (
                        <ul className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }} data-testid="playbook-table-columns">
                            {fields.map((f) => {
                                const slot = schedule.get(f.key);
                                const role = mapping ? Object.keys(mapping).find((r) => mapping[r] === f.key) : null;
                                return (
                                    <li
                                        key={f.key}
                                        className={reducedMotion ? '' : 'pbk-col-in'}
                                        style={{ '--pbk-delay': `${slot ? slot.delayMs : 0}ms`, background: 'var(--bg-primary)', border: '1px solid var(--border-default)', borderRadius: 10, padding: '8px 10px' }}
                                        data-testid="playbook-table-column"
                                    >
                                        <div className="flex items-center gap-1.5 min-w-0">
                                            {mapping && role && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />}
                                            <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{f.name || f.key}</span>
                                        </div>
                                        <div className="text-[11px] flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
                                            <span>{f.type}</span>
                                            {mapping && role && (<><span aria-hidden="true">·</span><span>{role}</span></>)}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    {landed && mapping && art.hasStatus === false && (
                        <p className="mt-4" style={{ fontSize: type.meta, color: 'var(--text-secondary)' }}>{t('playbooks.table.no_status', 'No status column — the approval flow will be skipped.')}</p>
                    )}
                    {art.datatableKey && landed && (
                        <p className="mt-2" style={{ fontSize: type.micro, color: 'var(--text-tertiary)' }}>
                            {t('playbooks.inspect.key', 'Key')}: <code>{art.datatableKey}</code>
                        </p>
                    )}
            </div>
            {landed && art.datatableId && Number.isFinite(art.rowCount) && art.rowCount > 0 && (
                <RowsPreview datatableId={art.datatableId} fields={fields} rowCount={art.rowCount} t={t} onNavigate={onNavigate} reducedMotion={reducedMotion} presenter={presenter} title={t('playbooks.rows.existing', 'What the table holds today')} />
            )}
        </StageShell>
    );
}
