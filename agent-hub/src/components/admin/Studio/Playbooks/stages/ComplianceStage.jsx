import { AlertTriangle, CheckCircle2, ChevronDown, ExternalLink, Loader2, RefreshCw, ScaleIcon, ShieldCheck } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import StageShell from './StageShell';
import { TONES } from '../../../../shared/statusTone';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { studioAppsApi } from '../../AppStudio/studioAppsApi';
import { playbooksApi } from '../playbooksApi';
import { CENTER_PATH, groupFindings, methodLine, verdictOf, writtenWords } from './complianceView';
import FindingRow from './FindingRow';
import RegisterPanel from './RegisterPanel';
import { applyResolvePlan, resolveSummary } from './resolveApply';

/** One write, at the endpoint that owns it. Throws with the status on it. */
async function put(path, body, method = 'PUT') {
    const r = await authFetch(`${API_BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) {
        const e = new Error(`${method} ${path} failed`);
        e.status = r.status;
        e.body = await r.json().catch(() => null);
        throw e;
    }
    return r.json().catch(() => ({}));
}

/**
 * The closing phase: what the playbook built, read against the frameworks this
 * organisation has switched on in the Compliance Center.
 *
 * It opens with a VERDICT — the frameworks it was read against and how many
 * checks came back clean — because a bare list of orange rows reads as "your
 * build is broken", which is not what it means and not what a room should take
 * away (owner, 2026-09-16). Under it, the things to tidy up, each one linking
 * to the thing it found and each one offering to fix itself.
 *
 * The phase itself still changes nothing on its own: Resolve proposes, Apply
 * writes, and every write goes out through the endpoint that already owns and
 * audits it.
 */
// The verdict's ink, per tone. `none` is the one the count alone could never
// express: nothing was checked, so nothing can be said to be clean.
const VERDICT_INK = { clear: 'var(--kind-playbook)', none: 'var(--warning-ink)', attention: 'var(--type-ai)', tidy: 'var(--type-ai)' };

export default function ComplianceStage({ playbook = null, phase, dispatch, t, presenter = false, onNavigate = null }) {
    const status = phase?.status;
    const art = phase?.artifacts || {};
    const findings = useMemo(() => (Array.isArray(art.findings) ? art.findings : []), [art.findings]);
    const frameworks = Array.isArray(art.frameworks) ? art.frameworks : [];
    const facts = art.facts || null;
    const registered = art.registered || null;
    const rechecks = Array.isArray(art.rechecks) ? art.rechecks : [];
    const playbookId = playbook && playbook.id;

    const startedRef = useRef(null);
    useEffect(() => {
        if (status !== 'ready') return;
        const stamp = `${phase.key}:${phase.attempt || 0}`;
        if (startedRef.current === stamp) return;
        startedRef.current = stamp;
        dispatch({ type: 'start', key: phase.key });
    }, [status, phase, dispatch]);

    const running = status === 'running' || status === 'ready';
    const landed = status === 'awaiting' || status === 'done';
    // The phase had NO failed branch, so on a failure both flags were false and
    // the header fell through to its last arm — telling a regulation-literate
    // room that no framework was switched on. That sentence has to be earned.
    const failed = status === 'failed';

    const [keep, setKeep] = useState(null);           // null = "all of them", until touched
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [showLow, setShowLow] = useState(false);
    const kept = keep === null ? findings.map((f) => f.code) : [...keep];

    // ── re-reading after a fix ──────────────────────────────────────
    const [rechecking, setRechecking] = useState(false);
    const recheck = useCallback(async () => {
        if (!playbookId || rechecking) return;
        setRechecking(true);
        try {
            const body = await playbooksApi.runPhase(playbookId, phase.key, { recheck: true });
            if (body && body.playbook) dispatch({ type: 'replace', playbook: body.playbook });
        } catch (e) {
            setError(e?.message || t('playbooks.compliance.recheck_failed', 'It could not be read again.'));
        } finally {
            setRechecking(false);
        }
    }, [playbookId, phase.key, dispatch, rechecking, t]);

    // ── Resolve: propose, then apply, then read it again ────────────
    const automationApi = useAutomationApi();
    const appId = (facts && facts.app && facts.app.id) || null;
    const [plans, setPlans] = useState({});           // code → plan
    const [planBusy, setPlanBusy] = useState(null);   // the code being worked out
    const [planErrors, setPlanErrors] = useState({});
    const [applying, setApplying] = useState(null);
    const [applied, setApplied] = useState(null);

    const propose = useCallback(async (code) => {
        setPlanBusy(code);
        setPlanErrors((m) => ({ ...m, [code]: null }));
        try {
            const body = await playbooksApi.resolvePlan(playbookId, phase.key, code);
            setPlans((m) => ({ ...m, [code]: body && body.plan }));
        } catch (e) {
            setPlanErrors((m) => ({ ...m, [code]: e?.message || t('playbooks.compliance.fix_plan_failed', 'A fix for this one could not be worked out.') }));
        } finally {
            setPlanBusy(null);
        }
    }, [playbookId, phase.key, t]);

    const apply = useCallback(async (code, plan) => {
        setApplying(code);
        setApplied(null);
        const out = await applyResolvePlan(plan, {
            register: (body) => playbooksApi.register(playbookId, phase.key, { ...body, risks: [] }),
            saveAutomation: (id, definition) => automationApi.updateAutomation(id, { definition }),
            publish: (id, body) => studioAppsApi.publish(id, body),
            // Both of these go straight at their endpoint rather than through
            // the hooks that own them elsewhere (useAppRoles wants a query
            // client, useComplianceCore toasts and refetches a page that is
            // not on screen) — a stage should not need either to make one call.
            assignMember: (userId, roleKey) => put(`/api/studio-apps/${encodeURIComponent(appId)}/members`, { userId, roleKey }, 'POST'),
            saveComplianceSettings: (body) => put('/api/compliance/settings', body),
        });
        setApplying(null);
        setApplied({ code, out });
        setPlans((m) => ({ ...m, [code]: null }));
        // Whatever landed, the review is re-read: the point of a fix is being
        // able to see that it worked.
        if (out.applied.length) await recheck();
    }, [playbookId, phase.key, automationApi, appId, recheck]);

    const register = useCallback(async (reg) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const days = Number(reg.retentionDays);
            const body = await playbooksApi.register(playbookId, phase.key, {
                registration: {
                    lawfulBasis: reg.lawfulBasis || undefined,
                    retentionDays: Number.isFinite(days) && days > 0 ? days : undefined,
                    retentionField: reg.retentionField || undefined,
                    subjectColumn: reg.subjectColumn || undefined,
                },
                risks: kept,
            });
            if (body && body.failed && body.failed.length) setError(body.failed.map((f) => f.error || f.what).join(', '));
            if (body && body.playbook) dispatch({ type: 'replace', playbook: body.playbook });
        } catch (e) {
            setError(e?.message || t('playbooks.compliance.register_failed', 'Could not register it.'));
        } finally {
            setBusy(false);
        }
    }, [busy, kept, playbookId, phase.key, dispatch, t]);

    /**
     * The registration finding, whichever half of the review noticed it.
     *
     * The panel's own "Fill this in with AI" runs the same resolver as the
     * finding's Resolve button — and the finding may be one the MODEL wrote
     * ("Missing lawful basis for processing"), which is why this looks at the
     * stamped fix rather than at the code.
     */
    const registrationFinding = findings.find((f) => f.fix_kind === 'registration'
        || f.code === 'ropa_retention' || f.code === 'mirror_personal') || null;
    const suggestRegistration = useCallback(async () => {
        if (!registrationFinding) return null;
        const body = await playbooksApi.resolvePlan(playbookId, phase.key, registrationFinding.code);
        const plan = body && body.plan;
        const call = ((plan && plan.calls) || []).find((c) => c.kind === 'register');
        return {
            registration: (call && call.body && call.body.registration) || null,
            note: (plan && plan.note) || null,
        };
    }, [registrationFinding, playbookId, phase.key]);

    const verdict = verdictOf(art, t);
    const groups = groupFindings(findings);
    const method = methodLine(facts, t);
    const lastRecheck = rechecks.length ? rechecks[rechecks.length - 1] : null;
    const onKeep = (code, on) => setKeep(on ? [...kept, code] : kept.filter((c) => c !== code));
    const rowProps = (f) => ({
        finding: f, facts, t, presenter, onNavigate,
        showKeep: landed && !registered,
        keepChecked: kept.includes(f.code),
        onKeepChange: onKeep,
        onResolve: landed ? propose : null,
        onApply: apply,
        plan: plans[f.code] || null,
        planBusy: planBusy === f.code,
        planError: planErrors[f.code] || null,
        applying: applying === f.code,
    });

    return (
        <StageShell
            kind="compliance"
            icon={ScaleIcon}
            width="default"
            presenter={presenter}
            testId="playbook-stage-compliance"
            phaseKey={phase?.key}
            title={t('playbooks.compliance.title', 'Checked against your frameworks')}
            tone={failed ? 'error' : 'busy'}
            status={(
                <>
                    {failed && <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />}
                    {running && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    {failed
                        ? (phase?.error || t('playbooks.compliance.failed', 'The review did not run — try it again.'))
                        : running
                            ? t('playbooks.compliance.running', 'Reading the table, the automations and the app…')
                            : frameworks.length
                                ? t('playbooks.compliance.against', 'Against: {list}', { list: frameworks.join(', ') })
                                : t('playbooks.compliance.none_active', 'No framework is switched on in the Compliance Center, so there was nothing to check against.')}
                </>
            )}
            actions={onNavigate ? (
                <button type="button" onClick={() => onNavigate(CENTER_PATH)} className="inline-flex items-center gap-1 text-[11px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: 'var(--type-ai)', outlineColor: 'var(--accent-primary)' }} data-testid="playbook-compliance-open">
                    {t('playbooks.compliance.open_center', 'Compliance Center')}<ExternalLink className="w-3 h-3" aria-hidden="true" />
                </button>
            ) : null}
        >

                {/* The verdict — what was checked, and what came back clean. */}
                {landed && (
                    <section
                        className="rounded-2xl"
                        style={{
                            background: 'var(--bg-card)',
                            border: `1px solid ${verdict.tone === 'clear' ? 'var(--kind-playbook)' : verdict.tone === 'none' ? TONES.warning.raw : 'var(--border-default)'}`,
                            boxShadow: 'var(--shadow-md)',
                            padding: presenter ? 28 : 20,
                        }}
                        data-testid="playbook-compliance-verdict"
                        data-tone={verdict.tone}
                    >
                        <div className="flex items-start gap-3">
                            <span className="inline-flex items-center justify-center shrink-0 rounded-xl" style={{ width: presenter ? 44 : 36, height: presenter ? 44 : 36, background: `color-mix(in srgb, ${VERDICT_INK[verdict.tone] || 'var(--type-ai)'} 12%, transparent)`, color: VERDICT_INK[verdict.tone] || 'var(--type-ai)' }}>
                                {verdict.tone === 'clear'
                                    ? <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
                                    : verdict.tone === 'none'
                                        ? <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                                        : <ShieldCheck className="w-5 h-5" aria-hidden="true" />}
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="font-semibold" role="status" aria-live="polite" style={{ fontSize: presenter ? 20 : 16, color: 'var(--text-primary)' }} data-testid="playbook-compliance-headline">
                                    {verdict.headline}
                                </p>
                                {verdict.cleanLine && (
                                    <p className="mt-0.5 flex items-center gap-1.5" style={{ fontSize: presenter ? 14 : 12, color: 'var(--text-secondary)' }} data-testid="playbook-compliance-clean-count">
                                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />
                                        {verdict.cleanLine}
                                    </p>
                                )}
                                {method && <p className="mt-0.5" style={{ fontSize: presenter ? 13 : 11, color: 'var(--text-tertiary)' }} data-testid="playbook-compliance-method">{method}</p>}
                                {lastRecheck && lastRecheck.was > lastRecheck.now && (
                                    <p className="mt-1 font-medium" style={{ fontSize: presenter ? 14 : 12, color: TONES.success.ink }} data-testid="playbook-compliance-delta">
                                        {t('playbooks.compliance.delta', '{n} fewer than a moment ago.', { n: lastRecheck.was - lastRecheck.now })}
                                    </p>
                                )}
                                {applied && (
                                    <p className="mt-1" style={{ fontSize: presenter ? 13 : 11, color: applied.out.failed.length ? TONES.warning.ink : 'var(--text-secondary)' }} data-testid="playbook-compliance-applied">
                                        {resolveSummary(applied.out, t)}
                                    </p>
                                )}
                                {art.modelFailed && (
                                    <p className="mt-1" style={{ fontSize: 11, color: 'var(--text-tertiary)' }} data-testid="playbook-compliance-model-note">
                                        {t('playbooks.compliance.model_note', 'The AI reviewer could not be reached — what you see is what the rules alone found.')}
                                    </p>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={recheck}
                                disabled={rechecking}
                                className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-medium disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)', outlineColor: 'var(--accent-primary)' }}
                                data-testid="playbook-compliance-recheck"
                            >
                                {rechecking
                                    ? <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                    : <RefreshCw className="w-3 h-3" aria-hidden="true" />}
                                {t('playbooks.compliance.recheck', 'Check again')}
                            </button>
                        </div>
                    </section>
                )}

                {landed && findings.length === 0 && (
                    <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }} data-testid="playbook-compliance-clean">
                        {t('playbooks.compliance.clean', 'Nothing came up. What was built does not touch the rules you have switched on.')}
                    </p>
                )}

                {(groups.high.length > 0 || groups.medium.length > 0) && (
                    <ul className="space-y-2" data-testid="playbook-compliance-findings">
                        {[...groups.high, ...groups.medium].map((f) => <FindingRow key={f.code} {...rowProps(f)} />)}
                    </ul>
                )}

                {/* The quiet ones, behind a count — they are notes, not problems. */}
                {groups.low.length > 0 && (
                    <div>
                        <button
                            type="button"
                            onClick={() => setShowLow((v) => !v)}
                            className="inline-flex items-center gap-1.5 text-[11px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{ color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}
                            aria-expanded={showLow}
                            data-testid="playbook-compliance-notes-toggle"
                        >
                            <ChevronDown className="w-3 h-3 transition-transform motion-reduce:transition-none" style={{ transform: showLow ? 'rotate(0deg)' : 'rotate(-90deg)' }} aria-hidden="true" />
                            {groups.low.length === 1
                                ? t('playbooks.compliance.notes_one', '1 note, good to know')
                                : t('playbooks.compliance.notes', '{n} notes, good to know', { n: groups.low.length })}
                        </button>
                        {showLow && (
                            <ul className="mt-2 space-y-2" data-testid="playbook-compliance-notes">
                                {groups.low.map((f) => <FindingRow key={f.code} {...rowProps(f)} />)}
                            </ul>
                        )}
                    </div>
                )}

                {landed && facts && facts.table && (
                    <RegisterPanel
                        playbookId={playbookId}
                        phaseKey={phase.key}
                        facts={facts}
                        t={t}
                        presenter={presenter}
                        busy={busy}
                        error={error}
                        onRegister={register}
                        registered={registered}
                        onNavigate={onNavigate}
                        writtenLines={writtenWords(registered, t)}
                        onSuggest={registrationFinding && !registered ? suggestRegistration : null}
                    />
                )}

                {landed && (
                    <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {t('playbooks.compliance.disclaimer', 'A reading of what was built, not legal advice — and the review itself changed nothing.')}
                    </p>
                )}
        </StageShell>
    );
}
