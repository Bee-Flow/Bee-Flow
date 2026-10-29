import { ExternalLink, ScaleIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '@/utils/helpers';
import StageShell from './StageShell';
import useAutomationApi from '@/hooks/useAutomationApi';
import { studioAppsApi } from '../../AppStudio/studioAppsApi';
import { playbooksApi } from '../playbooksApi';
import { CENTER_PATH, groupFindings, methodLine, verdictOf, writtenWords, type ComplianceArtifacts } from './complianceView';
import FindingRow from './FindingRow';
import RegisterPanel from './RegisterPanel';
import { ComplianceStatus, QuietNotes, VerdictCard } from './ComplianceStageParts';
import { applyResolvePlan } from './resolveApply';
import type { Finding, ResolvePlan } from './compliance.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { Phase, PlaybookEvent, PlaybookLike } from '../phaseMachine';
import { request, errorBody, RefusedError } from '@/api/mutate';

/** One write, at the endpoint that owns it. Throws with the status on it. */
async function put(path: string, body: unknown, method: string = 'PUT') {
    let r: Response;
    try {
        r = await request(`${API_BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    } catch (err) {
        if (!(err instanceof RefusedError)) throw err;
        const e: Error & { status?: number; body?: unknown } = new Error(`${method} ${path} failed`);
        e.status = err.status;
        e.body = (errorBody(err) ?? null);
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

interface ComplianceStageProps {
    playbook?: (PlaybookLike & { id: string }) | null;
    phase: Phase;
    dispatch: (event: PlaybookEvent) => Promise<PlaybookLike | null>;
    t: TranslateFn;
    onNavigate?: ((to: string) => void) | null;
    presenter?: boolean;
}

interface ResolveArgs {
    playbookId: string | null | undefined;
    phaseKey: string;
    facts: ComplianceArtifacts['facts'] | null;
    t: TranslateFn;
    recheck: () => Promise<void>;
}

/** Resolve: propose a fix per finding, apply it through the endpoints that own the writes, then read the review again. */
function useResolve({ playbookId, phaseKey, facts, t, recheck }: ResolveArgs) {
    // ── Resolve: propose, then apply, then read it again ────────────
    const automationApi = useAutomationApi();
    const appId = (facts && facts.app && facts.app.id) || null;
    const [plans, setPlans] = useState<Record<string, ResolvePlan | null>>({});           // code → plan
    const [planBusy, setPlanBusy] = useState<string | null>(null);   // the code being worked out
    const [planErrors, setPlanErrors] = useState<Record<string, string | null>>({});
    const [applying, setApplying] = useState<string | null>(null);
    const [applied, setApplied] = useState<{ code: string; out: Awaited<ReturnType<typeof applyResolvePlan>> } | null>(null);

    const propose = useCallback(async (code: string) => {
        setPlanBusy(code);
        setPlanErrors((m) => ({ ...m, [code]: null }));
        try {
            const body = await playbooksApi.resolvePlan(playbookId as string, phaseKey, code);
            setPlans((m) => ({ ...m, [code]: body && body.plan }));
        } catch (e) {
            setPlanErrors((m) => ({ ...m, [code]: (e as Error)?.message || t('playbooks.compliance.fix_plan_failed', 'A fix for this one could not be worked out.') }));
        } finally {
            setPlanBusy(null);
        }
    }, [playbookId, phaseKey, t]);

    const apply = useCallback(async (code: string, plan: ResolvePlan) => {
        setApplying(code);
        setApplied(null);
        const out = await applyResolvePlan(plan, {
            register: (body) => playbooksApi.register(playbookId as string, phaseKey, { ...body, risks: [] }),
            saveAutomation: (id, definition) => automationApi.updateAutomation(id, { definition }),
            publish: (id, body) => studioAppsApi.publish(id, body),
            // Both of these go straight at their endpoint rather than through
            // the hooks that own them elsewhere (useAppRoles wants a query
            // client, useComplianceCore toasts and refetches a page that is
            // not on screen) — a stage should not need either to make one call.
            assignMember: (userId, roleKey) => put(`/api/studio-apps/${encodeURIComponent(String(appId))}/members`, { userId, roleKey }, 'POST'),
            saveComplianceSettings: (body) => put('/api/compliance/settings', body),
        });
        setApplying(null);
        setApplied({ code, out });
        setPlans((m) => ({ ...m, [code]: null }));
        // Whatever landed, the review is re-read: the point of a fix is being
        // able to see that it worked.
        if (out.applied.length) await recheck();
    }, [playbookId, phaseKey, automationApi, appId, recheck]);

    return { plans, planBusy, planErrors, applying, applied, propose, apply };
}

export default function ComplianceStage({ playbook = null, phase, dispatch, t, presenter = false, onNavigate = null }: ComplianceStageProps) {
    const status = phase?.status;
    const art = (phase?.artifacts || {}) as ComplianceArtifacts;
    const findings = useMemo(() => (Array.isArray(art.findings) ? art.findings : []), [art.findings]);
    const frameworks = Array.isArray(art.frameworks) ? art.frameworks : [];
    const facts = art.facts || null;
    const registered = art.registered || null;
    const rechecks = Array.isArray(art.rechecks) ? art.rechecks : [];
    const playbookId = playbook && playbook.id;

    const startedRef = useRef<string>(null);
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

    const [keep, setKeep] = useState<string[] | null>(null);           // null = "all of them", until touched
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showLow, setShowLow] = useState(false);
    const kept = useMemo(() => (keep === null ? findings.map((f) => f.code) : [...keep]), [keep, findings]);

    // ── re-reading after a fix ──────────────────────────────────────
    const [rechecking, setRechecking] = useState(false);
    const recheck = useCallback(async () => {
        if (!playbookId || rechecking) return;
        setRechecking(true);
        try {
            const body = await playbooksApi.runPhase(playbookId, phase.key, { recheck: true });
            if (body && body.playbook) dispatch({ type: 'replace', playbook: body.playbook });
        } catch (e) {
            setError((e as Error)?.message || t('playbooks.compliance.recheck_failed', 'It could not be read again.'));
        } finally {
            setRechecking(false);
        }
    }, [playbookId, phase.key, dispatch, rechecking, t]);

    const { plans, planBusy, planErrors, applying, applied, propose, apply } = useResolve({ playbookId, phaseKey: phase.key, facts, t, recheck });

    const register = useCallback(async (reg: { lawfulBasis: string; retentionDays: number | string; retentionField: string; subjectColumn: string }) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const days = Number(reg.retentionDays);
            const body = await playbooksApi.register(playbookId as string, phase.key, {
                registration: {
                    lawfulBasis: reg.lawfulBasis || undefined,
                    retentionDays: Number.isFinite(days) && days > 0 ? days : undefined,
                    retentionField: reg.retentionField || undefined,
                    subjectColumn: reg.subjectColumn || undefined,
                },
                risks: kept,
            });
            if (body && body.failed && body.failed.length) setError(body.failed.map((f: { error?: string; what?: string }) => f.error || f.what).join(', '));
            if (body && body.playbook) dispatch({ type: 'replace', playbook: body.playbook });
        } catch (e) {
            setError((e as Error)?.message || t('playbooks.compliance.register_failed', 'Could not register it.'));
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
        const body = await playbooksApi.resolvePlan(playbookId as string, phase.key, registrationFinding.code);
        const plan = body && body.plan;
        const call = ((plan && plan.calls) || []).find((c: { kind: string; }) => c.kind === 'register');
        return {
            registration: (call && call.body && call.body.registration) || null,
            note: (plan && plan.note) || null,
        };
    }, [registrationFinding, playbookId, phase.key]);

    const verdict = verdictOf(art, t);
    const groups = groupFindings(findings);
    const method = methodLine(facts, t);
    const lastRecheck = rechecks.length ? rechecks[rechecks.length - 1] : null;
    const onKeep = (code: string, on: boolean) => setKeep(on ? [...kept, code] : kept.filter((c: string) => c !== code));
    const rowProps = (f: Finding) => ({
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
            status={<ComplianceStatus t={t} failed={failed} running={running} error={phase?.error} frameworks={frameworks} />}
            actions={onNavigate ? (
                <button type="button" onClick={() => onNavigate(CENTER_PATH)} className="inline-flex items-center gap-1 text-[11px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [color:var(--type-ai)]! [outline-color:var(--accent-primary)]!" data-testid="playbook-compliance-open">
                    {t('playbooks.compliance.open_center', 'Compliance Center')}<ExternalLink className="w-3 h-3" aria-hidden="true" />
                </button>
            ) : null}
        >

                {/* The verdict — what was checked, and what came back clean. */}
                {landed && (
                    <VerdictCard t={t} presenter={presenter} verdict={verdict} method={method} lastRecheck={lastRecheck} applied={applied}
                        modelFailed={!!art.modelFailed} rechecking={rechecking} onRecheck={recheck} />
                )}

                {landed && findings.length === 0 && (
                    <p className="text-[11px] text-[var(--text-secondary)]" data-testid="playbook-compliance-clean">
                        {t('playbooks.compliance.clean', 'Nothing came up. What was built does not touch the rules you have switched on.')}
                    </p>
                )}

                {(groups.high.length > 0 || groups.medium.length > 0) && (
                    <ul className="space-y-2" data-testid="playbook-compliance-findings">
                        {[...groups.high, ...groups.medium].map((f) => <FindingRow key={f.code} {...rowProps(f)} />)}
                    </ul>
                )}

                {/* The quiet ones, behind a count — they are notes, not problems. */}
                {groups.low.length > 0 && <QuietNotes t={t} low={groups.low} showLow={showLow} setShowLow={setShowLow} rowProps={rowProps} />}

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
                    <p className="text-[11px] text-[var(--text-secondary)]">
                        {t('playbooks.compliance.disclaimer', 'A reading of what was built, not legal advice — and the review itself changed nothing.')}
                    </p>
                )}
        </StageShell>
    );
}
