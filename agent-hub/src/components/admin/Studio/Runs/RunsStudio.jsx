import { AlertCircle, Building2, ScrollText, UserRound } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import NowRunningStrip from './NowRunningStrip';
import useAutomationApi from '../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../hooks/useTranslation';
import ExecutionsPanel from '../Executions/ExecutionsPanel';
import { normaliseRunScope } from '../Executions/runScope';

/**
 * Studio → Runs & log (Track H2, Studio Nav artboard: "Runs & logboek").
 *
 * Two things, stacked: the "Now running · last 24 hours" strip from
 * Studio.dc.html 1a, and the full executions surface underneath it
 * (ExecutionsPanel, scope 'global' — the same one the builder's history tab
 * and the routines start screen mount).
 *
 * ── "Log" means automation runs, in v1 ───────────────────────────────────
 *
 * A DEVIATION from the artboard's word, and worth saying out loud because the
 * word promises more than the screen delivers. A product this size has
 * several logs — the audit trail (admin → compliance), agent conversations,
 * app action history, KB ingestion — and none of them is here. What this
 * section holds is every automation RUN: what fired, what it did, what broke.
 * The other logs stay where they are until something merges them, and this
 * screen does not pretend to be their front door.
 *
 * ── The scope switch is the point of this screen ─────────────────────────
 *
 * It opens on MY RUNS, always, on every load — deliberately not remembered.
 * The organisation scope is a different API (GET /_runs/org) behind an
 * explicit manage_automations check, and a remembered scope is browser state
 * that outlives a permission: a person demoted last week would land back on
 * an org view that then 403s, and the screen would have to explain a refusal
 * for a choice nobody made this session.
 *
 * Both buttons are always OFFERED, the way GET /approvals?scope=org is (see
 * ApprovalsStudio). The server is the authority and it refuses in words; a
 * client-side guess at the permission would either hide the switch from
 * someone who has it (a stale permission list) or predict a refusal the
 * person can do nothing about.
 *
 * A refusal does NOT fall back to "my runs". The switch stays where the
 * person put it and the reason is on screen. Silently narrowing would show a
 * smaller, entirely plausible list and say nothing — which is the failure
 * this whole stage is written against.
 */

function ScopeButton({ active, onClick, icon, label, testId }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            data-testid={testId}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                active ? '' : 'hover:bg-[var(--bg-tertiary)]'
            }`}
            style={active
                ? { background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }
                : { background: 'transparent', borderColor: 'transparent', color: 'var(--text-secondary)' }}
        >
            {icon}
            {label}
        </button>
    );
}

/** The scope switch. Both halves always offered — the server refuses in words. */
function ScopeSwitch({ t, scope, setScope }) {
    return (
        <div
            className="shrink-0 inline-flex items-center gap-1 p-0.5 rounded-lg border"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}
            role="group"
            aria-label={t('runs.scope_label', 'Whose runs')}
        >
            <ScopeButton
                active={scope === 'mine'}
                onClick={() => setScope('mine')}
                icon={<UserRound className="w-3 h-3" />}
                label={t('runs.scope_mine', 'My runs')}
                testId="runs-scope-mine"
            />
            <ScopeButton
                active={scope === 'org'}
                onClick={() => setScope('org')}
                icon={<Building2 className="w-3 h-3" />}
                label={t('runs.scope_org', 'Organisation')}
                testId="runs-scope-org"
            />
        </div>
    );
}

/**
 * The refusal banner. It carries the SERVER's sentence, because that is the
 * one that knows whether this is a missing permission, an account with no
 * organisation, or an outage — and it offers the way back explicitly instead
 * of taking it on the person's behalf.
 */
function ScopeError({ t, message, onBackToMine }) {
    return (
        <div
            className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
            style={{ background: 'color-mix(in srgb, var(--error) 12%, transparent)', color: 'var(--error)' }}
            role="alert"
            data-testid="runs-scope-error"
        >
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
            <span className="flex-1 min-w-0">{message}</span>
            <button type="button" onClick={onBackToMine} className="underline font-medium shrink-0" data-testid="runs-scope-back">
                {t('runs.scope_back_to_mine', 'Show my runs')}
            </button>
        </div>
    );
}

/** Title, one sentence, the scope switch, and what the org scope has to admit. */
function RunsHeader({ t, scope, setScope, error }) {
    return (
        <>
            <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                    <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        <ScrollText className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                        {t('runs.title', 'Runs & log')}
                    </h2>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                        {t('runs.intro', 'Every time a routine fired: what started it, what it did, and what went wrong. Opening a run shows it step by step.')}
                    </p>
                </div>
                <ScopeSwitch t={t} scope={scope} setScope={setScope} />
            </div>

            {error && <ScopeError t={t} message={error} onBackToMine={() => setScope('mine')} />}

            {scope === 'org' && !error && (
                <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }} data-testid="runs-org-not-live">
                    {/* Said out loud because the personal scope IS live and
                        nothing else on the screen changes. The run stream only
                        carries the subscriber's own events, so an organisation
                        list would tick for the viewer's rows and freeze for
                        everyone else's. */}
                    {t('runs.org_not_live', "The organisation's runs do not update by themselves — refresh to see new ones. Only the person who started a run can open it.")}
                </div>
            )}
        </>
    );
}

export default function RunsStudio({
    onNavigate = null,
    onEditingChange = null,
    initialRunId = null,
    initialRunStepId = null,
}) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    // Not persisted — see the header. Every visit starts on "my runs".
    const [scope, setScope] = useState('mine');
    // The strip's own read: a FIXED 24-hour window, independent of the table's
    // range chip, because the heading above it says "last 24 hours".
    const [facets, setFacets] = useState(null);
    const [facetsLoading, setFacetsLoading] = useState(true);
    const [facetsError, setFacetsError] = useState(null);

    // Only the latest read may land: a slow refusal of the org scope must not
    // put its error under "my runs" after the person has switched back.
    const facetsRequest = useRef(0);
    const loadFacets = useCallback(async (which) => {
        const runScope = normaliseRunScope(which);
        const request = ++facetsRequest.current;
        const isCurrent = () => request === facetsRequest.current;
        setFacetsLoading(true);
        setFacetsError(null);
        try {
            const query = { range: 24, mode: 'live' };
            const res = runScope === 'org' ? await api.getOrgRunFacets(query) : await api.getRunFacets(query);
            // `null`, not `{}`, for a body this build cannot read: the strip
            // tells "unreadable" and "nothing ran" apart, and it can only do
            // that if the two arrive as different values.
            if (isCurrent()) setFacets(res && typeof res.facets === 'object' ? res.facets : null);
        } catch (err) {
            if (!isCurrent()) return;
            // The previous scope's numbers are cleared. A strip drawn from
            // "my runs" under an "Organisation" heading is a wrong answer,
            // which is worse than no answer.
            setFacets(null);
            setFacetsError(err?.message || t('runs.scope_failed', 'Could not read this scope.'));
        } finally {
            if (isCurrent()) setFacetsLoading(false);
        }
    }, [api, t]);

    useEffect(() => { loadFacets(scope); }, [loadFacets, scope]);

    const openEditor = useCallback((automationId) => {
        if (automationId && onNavigate) onNavigate(`studio/automations/${automationId}`);
    }, [onNavigate]);

    return (
        <div className="h-full min-h-0 flex flex-col" style={{ background: 'var(--bg-primary)' }}>
            {/* The same centred 110rem column as the log below, so on an
                ultrawide screen the heading, the strip and the table line up. */}
            <div className="flex-shrink-0 w-full mx-auto max-w-[110rem] px-4 pt-5 pb-4 space-y-3">
                <RunsHeader t={t} scope={scope} setScope={setScope} error={facetsError} />
                {/* Openen alleen in de eigen scope. In de org-scope zijn dit de
                    routines van collega's, en GET /api/automation/:id weigert die
                    met 403 — de strook bood dus een knop aan die de server niet
                    inwilligt. De facets dragen geen eigendom, dus per rij beslissen
                    kan hier niet; de scope is het enige eerlijke onderscheid dat
                    dit scherm heeft. Het staat ook al zo in de scope-uitleg:
                    alleen wie een run startte kan hem openen. */}
                <NowRunningStrip
                    facets={facets}
                    loading={facetsLoading}
                    failed={!!facetsError}
                    onOpenAutomation={onNavigate && scope === 'mine' ? openEditor : null}
                />
            </div>

            <div className="flex-1 min-h-0">
                <ExecutionsPanel
                    scope="global"
                    runScope={scope}
                    active
                    onOpenEditor={openEditor}
                    onEditingChange={onEditingChange}
                    initialRunId={initialRunId}
                    initialStepId={initialRunStepId}
                />
            </div>
        </div>
    );
}
