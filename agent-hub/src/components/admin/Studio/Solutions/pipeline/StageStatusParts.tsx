import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { pillStatusOf } from './pipelineModel';
import { fmt, kindLabel, StatusPill, statusLabel } from './stageText';
import { useStageLabel } from './StageSwitcher';
import { getStage, type DeploymentSummary, type StageKey, type StageSettingsSummary } from './stagesApi';

/** The lower sections of the Status tab: last deployment and the addresses of a stage. */

function CopyButton({ value }: { value: string }) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* the address is on screen; copying by hand still works */ }
    };
    return (
        <button
            type="button"
            onClick={copy}
            aria-label={t('solution_stages.copy_address', 'Copy address')}
            className="p-2.5 -m-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
        >
            {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
        </button>
    );
}

export function Addresses({ solutionId, stage, refreshKey }: { solutionId: string; stage: StageKey; refreshKey: number }) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; data: StageSettingsSummary | null }>({ status: 'loading', data: null });
    const load = useCallback(async () => {
        const res = await getStage(solutionId, stage);
        setState(res.ok ? { status: 'ok', data: res.data } : { status: 'error', data: null });
    }, [solutionId, stage]);
    useEffect(() => { load(); }, [load, refreshKey]);

    if (state.status === 'loading') {
        return <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)]" aria-label={t('solution_stages.loading', 'Loading…')} />;
    }
    if (state.status === 'error' || !state.data) {
        return (
            <p className="flex items-start gap-2 text-sm text-[var(--text-primary)]" data-testid="stage-addresses-unreadable">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--warning)]" aria-hidden="true" />
                {t('solution_stages.addresses_unreadable', 'The addresses of this stage could not be read, so this is not "there are none".')}
            </p>
        );
    }
    if (state.data.inbound.length === 0) {
        return <p className="text-sm text-[var(--text-tertiary)]">{t('solution_stages.addresses_none', 'This stage has no address anyone can call yet.')}</p>;
    }
    return (
        <ul className="space-y-1.5" data-testid="stage-addresses">
            {state.data.inbound.map(a => (
                <li key={`${a.kind}:${a.url}`} className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)]">
                    <span className="text-xs text-[var(--text-tertiary)] shrink-0">{a.label}</span>
                    <code className="text-xs text-[var(--text-primary)] truncate flex-1 min-w-0">{a.url}</code>
                    <CopyButton value={a.url} />
                </li>
            ))}
        </ul>
    );
}

export function LastDeployment({ last, stage }: { last: DeploymentSummary | null; stage: StageKey }) {
    const { t } = useTranslation();
    const label = useStageLabel();
    return (
        <section>
            <h3 className="text-[11px] font-medium uppercase tracking-wide mb-2 text-[var(--text-tertiary)]">
                {t('solution_stages.last_deployment', 'Last deployment')}
            </h3>
            {last ? (
                <div className="flex items-center gap-3 flex-wrap px-3 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)]" data-testid="stage-status-last">
                    <StatusPill status={pillStatusOf(last.status)} label={statusLabel(t, last.status)} containerName={null} testId="stage-last-pill" />
                    <span className="text-sm text-[var(--text-primary)]">
                        {kindLabel(t, last.kind)}
                        {last.releaseSeq != null && <> {t('solution_stages.release_short', 'R{seq}', { seq: last.releaseSeq })}</>}
                    </span>
                    <span className="text-xs text-[var(--text-tertiary)]">{fmt(last.finishedAt || last.createdAt)}</span>
                    {last.status === 'failed' && (
                        <span className="w-full text-xs text-[var(--text-secondary)]">
                            {t('solution_stages.nothing_changed', 'Nothing changed in {stage}.', { stage: label(stage) })}
                            {last.error?.message ? ` ${last.error.message}` : ''}
                        </span>
                    )}
                </div>
            ) : (
                <p className="px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)]">
                    {t('solution_stages.no_deployments', 'Nothing has been deployed to this stage yet.')}
                </p>
            )}
        </section>
    );
}
