import { Circle, CircleCheck, ExternalLink, Loader2, RefreshCw, ShieldCheck, Radio, LoaderCircle } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { useLicenseContext } from '../../licensing/LicenseContext';
import { getActionCheck, runActionCheck, applicableCriteria } from '../actionChecks';

/**
 * ActionStep — a verified do-it-for-real challenge (the Trailhead pattern).
 * The learner performs the task in the real app; a live criteria checklist
 * verifies it against the product's own APIs (actionChecks.js).
 *
 * Detection is event-driven in spirit: the step checks once on mount (work the
 * learner already did counts immediately — never ask anyone to repeat a thing
 * they've done), then re-checks on a timer while the step is open, so the
 * checklist ticks itself while they work with the player minimized.
 *
 * Fallbacks keep it un-blockable: if the API check errors, or two honest
 * manual checks still fail, an "I've done this" honor button appears
 * (status 'done') — graceful degradation exactly like Trailhead's
 * non-machine-checkable steps.
 *
 * v2: composite (capstone) checks carry per-criterion gates — a criterion the
 * learner lacks the permission/feature for is neither shown nor required
 * (applicableCriteria). The check runs with ctx = { user, hasFeature }.
 *
 * Props:
 *   step     — { checkId, launch: { navigateTo, labelFallback }, … }
 *   user     — current user (gates criteria, scopes ownership checks)
 *   saved    — resume state { status, passes }
 *   onState  — records { status, … } ('passed' | 'done')
 *   onLaunch — player callback: minimize + navigate to step.launch.navigateTo
 */
// The artboard promises "every 5 seconds"; the checklist polls at that cadence.
const POLL_MS = 5000;

export default function ActionStep({ step, user, saved, onState, onLaunch }) {
    const { t } = useTranslation();
    const { hasFeature } = useLicenseContext();
    const check = getActionCheck(step.checkId);
    const ctx = useMemo(() => ({ user, hasFeature }), [user, hasFeature]);
    const criteria = useMemo(() => applicableCriteria(check, ctx), [check, ctx]);
    const [passes, setPasses] = useState(() => saved?.passes || {});
    const [status, setStatus] = useState(saved?.status || null); // 'passed' | 'done' | null
    const [checking, setChecking] = useState(false);
    const [checkError, setCheckError] = useState(null);
    const [manualAttempts, setManualAttempts] = useState(0);
    // When each criterion was first seen passing (artboard 1c shows a time
    // per ticked row) and when the checklist last ran.
    const [passedAt, setPassedAt] = useState({});
    const [lastCheckAt, setLastCheckAt] = useState(null);
    const doneRef = useRef(status === 'passed' || status === 'done');

    // onState is an inline closure from the player (fresh identity per render);
    // route it through a ref so the polling effect below doesn't tear down and
    // re-fire — and re-hit the API — on every parent re-render. Same for ctx.
    const onStateRef = useRef(onState);
    useEffect(() => { onStateRef.current = onState; }, [onState]);
    const ctxRef = useRef(ctx);
    useEffect(() => { ctxRef.current = ctx; }, [ctx]);

    const finish = useCallback((newStatus, newPasses) => {
        if (doneRef.current) return;
        doneRef.current = true;
        setStatus(newStatus);
        onStateRef.current?.({ status: newStatus, passes: newPasses, answeredAt: new Date().toISOString() });
    }, []);

    const doCheck = useCallback(async (manual) => {
        if (!check || doneRef.current) return;
        if (manual) setChecking(true);
        const result = await runActionCheck(step.checkId, ctxRef.current);
        if (manual) {
            setChecking(false);
            if (!result.allPassed) setManualAttempts((n) => n + 1);
        }
        setCheckError(result.error);
        setLastCheckAt(new Date());
        if (!result.error) {
            setPasses(result.passes);
            setPassedAt((prev) => {
                const next = { ...prev };
                const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                for (const [id, ok] of Object.entries(result.passes || {})) if (ok && !next[id]) next[id] = stamp;
                return next;
            });
        }
        if (result.allPassed) finish('passed', result.passes);
    }, [check, step.checkId, finish]);

    // Check once on mount (organic work counts), then poll while unfinished so
    // the checklist ticks itself while the learner works in the real UI.
    useEffect(() => {
        if (!check || doneRef.current) return undefined;
        doCheck(false);
        const timer = setInterval(() => doCheck(false), POLL_MS);
        return () => clearInterval(timer);
    }, [check, doCheck]);

    if (!check) {
        // Unknown check id — never trap the learner behind a config mistake.
        return (
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                {t('learn.action.unavailable', 'This challenge isn’t available right now — you can continue.')}
            </div>
        );
    }

    const finished = status === 'passed' || status === 'done';
    const offerHonor = !finished && (checkError || manualAttempts >= 2);
    const firstUnmet = criteria.find((c) => !(finished || passes[c.id]))?.id || null;
    const fmtTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    return (
        <div className="flex flex-col gap-3">
            <div className="text-[15px] font-semibold leading-5" style={{ color: 'var(--text-primary)' }}>
                {t(step.titleKey, step.titleFallback)}
            </div>
            <div className="leading-[18px]" style={{ color: 'var(--text-secondary)', textWrap: 'pretty' }}>
                {t(step.instructionKey, step.instructionFallback)}
            </div>
            {!finished && step.launch?.navigateTo && (
                <button type="button" onClick={() => onLaunch?.(step.launch.navigateTo)}
                    className="self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-[12px] font-medium whitespace-nowrap transition-colors hover:bg-[var(--bg-tertiary)]"
                    style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
                    <ExternalLink style={{ width: 13, height: 13 }} aria-hidden="true" />
                    {t(step.launch.labelKey, step.launch.labelFallback || 'Open the app')}
                </button>
            )}

            {/* Live criteria checklist (artboard 1c) */}
            <div className="rounded-[10px] overflow-hidden" style={{ border: `1px solid ${finished ? 'var(--learn-complete)' : 'var(--border-default)'}` }} data-testid="action-checklist">
                {criteria.map((c, i) => {
                    const ok = finished || !!passes[c.id];
                    const current = !ok && c.id === firstUnmet;
                    return (
                        <div key={c.id} className="grid items-center gap-2.5"
                            style={{ gridTemplateColumns: '18px minmax(0,1fr) auto', padding: '9px 12px', borderTop: i === 0 ? 'none' : '1px solid var(--border-default)', background: current ? 'var(--bg-secondary)' : undefined }}>
                            {ok
                                ? <CircleCheck style={{ width: 16, height: 16, color: 'var(--learn-complete)' }} aria-hidden="true" />
                                : current && !checkError
                                    ? <LoaderCircle className="animate-spin" style={{ width: 16, height: 16, color: 'var(--accent-primary)' }} aria-hidden="true" />
                                    : <Circle style={{ width: 16, height: 16, color: 'var(--text-tertiary)' }} aria-hidden="true" />}
                            <div className="min-w-0">
                                <div className="font-medium" style={{ color: ok || current ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                                    {t(c.labelKey, c.labelFallback)}
                                    {c.optional && (
                                        <span className="ml-1.5 uppercase font-semibold" style={{ fontSize: 10, letterSpacing: '.04em', color: 'var(--text-tertiary)' }}>
                                            {t('learn.action.optional', 'optional')}
                                        </span>
                                    )}
                                </div>
                                {!ok && c.hintFallback && (
                                    <div className="text-[11px]" style={{ color: current ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}>
                                        {current ? `${t('learn.action.tip', 'Tip')}: ` : ''}{t(c.hintKey, c.hintFallback)}
                                    </div>
                                )}
                            </div>
                            <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                                {ok ? (passedAt[c.id] || '') : (current && !checkError ? t('learn.action.waiting', 'waiting…') : '')}
                            </span>
                        </div>
                    );
                })}
                <div className="flex items-center gap-1.5 text-[11px] flex-wrap" style={{ padding: '8px 12px', borderTop: '1px solid var(--border-default)', color: 'var(--text-tertiary)', background: 'var(--bg-secondary)' }}>
                    {finished ? (
                        <><ShieldCheck style={{ width: 11, height: 11, color: 'var(--learn-complete)' }} aria-hidden="true" />
                            <span style={{ color: 'var(--learn-complete-ink)' }}>
                                {status === 'passed'
                                    ? t('learn.action.verified', 'Verified — you built the real thing. That’s the whole point.')
                                    : t('learn.action.honor_done', 'Marked as done — continue below.')}
                            </span></>
                    ) : checkError ? (
                        <span>{t('learn.action.check_error_short', 'The check could not reach the app right now.')}</span>
                    ) : (
                        <><Radio style={{ width: 11, height: 11, color: 'var(--learn-complete)' }} aria-hidden="true" />
                            {t('learn.action.running', 'Check running')}{lastCheckAt && <> · {t('learn.action.last', 'last {time}').replace('{time}', fmtTime(lastCheckAt))}</>}</>
                    )}
                    {!finished && (
                        <span className="ml-auto inline-flex items-center gap-2.5">
                            <button type="button" onClick={() => doCheck(true)} disabled={checking}
                                className="inline-flex items-center gap-1 underline decoration-[var(--border-default)] hover:decoration-current disabled:opacity-60"
                                style={{ color: 'var(--text-secondary)' }}>
                                {checking ? <Loader2 className="animate-spin" style={{ width: 11, height: 11 }} /> : <RefreshCw style={{ width: 11, height: 11 }} aria-hidden="true" />}
                                {t('learn.action.check', 'Check my work')}
                            </button>
                            {offerHonor && (
                                <button type="button" onClick={() => finish('done', passes)}
                                    className="underline decoration-[var(--border-default)] hover:decoration-current" style={{ color: 'var(--text-secondary)' }}>
                                    {t('learn.action.honor_link', 'Can’t run the check? I’ve done this')}
                                </button>
                            )}
                        </span>
                    )}
                </div>
            </div>

            {!finished && !checkError && (
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {t('learn.action.watching', 'The checklist updates by itself while you work — anything you’ve already done counts.')}
                </p>
            )}
        </div>
    );
}
