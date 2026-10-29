import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { refKindKey } from './skillModel';
import { skillsApi, type SkillTestPayload, type SkillTestRun } from '@/api/skillsApi';
import type { JsonResourceError } from '@/api/client';
import useRelativeTime from '@/hooks/useRelativeTime';
import useTranslation from '@/hooks/useTranslation';
import { usageHref } from '@/components/shared/UsedByTab';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { TestTabProps } from './TestTab.types';
import { TestHistory, TestResults, TestTabSection, TestTabSection2 } from './TestTabParts';
import { logger } from '@/utils/logger';

/**
 * "Test" — one question through the steps (Skills artboard 1c, left).
 *
 * ── WHAT A RUN IS ───────────────────────────────────────────────────
 * `POST /api/skills/:id/test` runs ONE agent turn with this skill in the
 * system prompt and a closed, read-only tool list, then grades the answer
 * step by step. The stream sends the answer first and the verdict after, so
 * a person can read what the agent actually said before being told what a
 * grader thought of it.
 *
 * ── WHAT THIS SCREEN IS ALLOWED TO CLAIM ────────────────────────────
 * Everything green here comes off a run the server graded and stored. Three
 * things are deliberately NOT smoothed over:
 *
 *   - a run that could not be graded shows the failure, not an empty result
 *     list. `results.length === 0` after a "successful" call would read as
 *     "no problems found";
 *   - a step the grader stayed silent about arrives as `warning` with its
 *     own sentence (the server never turns silence into `ok`), and it is
 *     rendered as such;
 *   - the agent picker is loaded from the SAME endpoint the server
 *     authorises `agentId` against. A failed load says so and leaves the
 *     picker on "just this skill" — an empty picker would read as "you have
 *     no agents";
 *   - a history read that FAILED says so too. `runs = []` would render "not
 *     tested", which is a claim about the skill rather than about the read;
 *   - a stream that ENDED without a verdict says so. The reader resolves on
 *     end-of-body, and a body cut after the answer and before `done`/`error`
 *     is indistinguishable from a clean close when the response is
 *     close-delimited (which is exactly how `nextcloud-connector`'s proxy
 *     frames SSE). Without this the tab dropped "Running…", left the answer
 *     on screen, showed no verdict and no failure, and refreshed a history
 *     that has no row in it — a failed grading rendered as a quiet success.
 *
 * ── WHAT THE SERVER SEARCHED, AND WHAT IT DID NOT ───────────────────
 * The run only searches the knowledge bases THIS account may read. When some
 * of the skill's bases fall away the server says so (`notice`/`kb_dropped`)
 * and the line is shown, because the answer and the verdict below it were
 * then built on fewer sources than the skill declares.
 *
 * ── THE ADVICE LINE POINTS SOMEWHERE ────────────────────────────────
 * When the first flagged step references an automation, a table or a knowledge
 * base, the advice carries a link to it — built with `usageHref`, the same
 * deep link the Used-by table and a step's own reference pill use, so the
 * three cannot disagree about where a thing lives.
 */

/** Codes the server answers with, mapped to copy this screen owns. */
function messageForError(t: TranslateFn, err: { code?: string | null; message?: string } | null | undefined) {
    switch (err?.code) {
        case 'no_steps': return t('skills_studio.test.no_steps', 'Add steps first — a test grades one step at a time.');
        case 'empty_skill': return t('skills_studio.test.err_empty', 'This skill has nothing to follow yet — write the steps first.');
        case 'grading_failed': return t('skills_studio.test.err_grading', 'The answer came back, but it could not be graded. Try again.');
        case 'no_answer': return t('skills_studio.test.err_no_answer', 'The model returned no answer, so there is nothing to grade.');
        case 'no_model': return t('skills_studio.test.err_no_model', 'No AI model is configured for this workspace.');
        case 'agent_check_failed': return t('skills_studio.test.err_agents', 'Could not check which agents you may use. Try again.');
        case 'kb_check_failed': return t('skills_studio.test.err_kb_check', 'Could not check which knowledge bases this skill may use, so no test was run. Try again.');
        case 'stream_cut': return t('skills_studio.test.err_stream_cut', 'The test stopped before a verdict came back, so nothing was graded or saved. Try again.');
        default: return err?.message || t('skills_studio.test.err_generic', 'Could not run this test.');
    }
}

export default function TestTab({ skillId, steps = [], onNavigate = null, readOnly = false }: TestTabProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [runs, setRuns] = useState<SkillTestRun[] | false | null>(null);
    const [question, setQuestion] = useState('');
    const [agentId, setAgentId] = useState('');
    // null = still loading, false = the read FAILED (never "you have none").
    const [agents, setAgents] = useState<{ id: string; name: string }[] | false | null>(null);
    const [running, setRunning] = useState(false);
    const [answer, setAnswer] = useState('');
    const [result, setResult] = useState<SkillTestRun | null>(null);
    const [error, setError] = useState<string | null>(null);
    // A 403 on the history read. Kept APART from `runs === false`: "could not
    // load" is a claim about the network, and this is a claim about rights —
    // the account may see this skill but not edit it, and the server refuses
    // the whole test surface on it. Neither one may become "not tested".
    const [forbidden, setForbidden] = useState(false);
    // `{ declared, used }` when the server searched fewer knowledge bases than
    // the skill links. Null = it searched all of them, or none were linked.
    const [kbNotice, setKbNotice] = useState<{ declared: number; used: number; } | null>(null);
    const abortRef = useRef<AbortController>(null);

    // Read-only is read-only whichever way we learned it: the prop the detail
    // hands down, or the server saying so to our face. The screen must not
    // offer what the server would refuse.
    const locked = readOnly || forbidden;
    const refreshHistory = useCallback(async () => {
        try {
            const body = await skillsApi.testRuns(skillId);
            setRuns(Array.isArray(body?.runs) ? body.runs : []);
        } catch (e) {
            // NOT []: "not tested" is a claim about this skill, and a read
            // that failed cannot make it — the same rule the agent picker
            // above follows. A 403 is not a failure at all: it is the answer.
            if ((e as JsonResourceError)?.status === 403 || (e as JsonResourceError)?.code === 'not_editable') setForbidden(true);
            setRuns(false);
        }
    }, [skillId]);
    useEffect(() => {
        if (!skillId) return undefined;
        let alive = true;
        (async () => {
            try {
                const body = await skillsApi.testRuns(skillId);
                if (alive) setRuns(Array.isArray(body?.runs) ? body.runs : []);
            } catch (e) {
                if (!alive) return;
                // 403 = "you may look, not edit", not a storing.
                if ((e as JsonResourceError)?.status === 403 || (e as JsonResourceError)?.code === 'not_editable') setForbidden(true);
                setRuns(false);   // failed ≠ "not tested"
            }
        })();
        return () => { alive = false; };
    }, [skillId]);
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const body = await skillsApi.testAgents();
                if (alive) setAgents(Array.isArray(body?.agents) ? body.agents : []);
            } catch {
                // NOT []: an empty picker is a claim this read cannot make.
                if (alive) setAgents(false);
            }
        })();
        return () => { alive = false; };
    }, []);
    useEffect(() => () => { try { abortRef.current?.abort(); } catch (err) { logger.debug('gone', err); } }, []);
    const canRun = Boolean(skillId) && !locked && question.trim().length > 0 && steps.length > 0 && !running && agents !== null;

    const run = async () => {
        if (!canRun) return;
        try { abortRef.current?.abort(); } catch (err) { logger.debug('none', err); }
        const controller = new AbortController();
        abortRef.current = controller;
        setRunning(true);
        setError(null);
        setAnswer('');
        setResult(null);
        setKbNotice(null);
        try {
            let failed: SkillTestPayload | null = null;
            // The stream must END on purpose. `done` and `error` are the only
            // two ways this endpoint finishes; anything else means the body
            // stopped mid-run, and a run without a verdict may not be
            // rendered as a run that found nothing to report.
            let verdict: SkillTestRun | null = null;
            await skillsApi.test(skillId, {
                agentId: agentId || null,
                question: question.trim(),
                signal: controller.signal,
                onEvent: (name, payload) => {
                    if (name === 'answer') setAnswer(payload?.text || '');
                    else if (name === 'notice') {
                        if (payload?.code === 'kb_dropped') {
                            setKbNotice({ declared: Number(payload.declared) || 0, used: Number(payload.used) || 0 });
                        }
                    } else if (name === 'done') {
                        verdict = payload?.run || null;
                        setResult(verdict);
                    } else if (name === 'error') failed = payload;
                },
            });
            if (failed) setError(messageForError(t, failed));
            // A `done` with no row is the same hole one frame later: the
            // server never sends one, and if it ever did there would be
            // nothing on screen to say the run produced no verdict.
            else if (!verdict) setError(messageForError(t, { code: 'stream_cut' }));
            else await refreshHistory();
        } catch (e) {
            if ((e as Error)?.name !== 'AbortError') setError(messageForError(t, e as Error));
        } finally {
            setRunning(false);
        }
    };

    const results = useMemo(() => (Array.isArray(result?.results) ? result.results : []), [result]);
    // The first flagged step, and where it points — that is what the advice
    // is about. Null when nothing is flagged or the step references nothing.
    const adviceHref = useMemo(() => {
        if (typeof onNavigate !== 'function') return null;
        const flagged = results.find((r) => r.status && r.status !== 'ok');
        if (!flagged) return null;
        const step = steps.find(s => s.id === flagged.stepId);
        const ref = Array.isArray(step?.refs) ? step.refs[0] : null;
        if (!ref) return null;
        return usageHref({ kind: refKindKey(ref.kind), id: ref.id });
    }, [results, steps, onNavigate]);

    return (
        <div className="flex flex-col gap-3 max-w-3xl" data-testid="skill-test">
            <TestTabSection2 t={t} run={run} canRun={canRun} running={running} />

            {locked && (
                <p className="text-xs m-0 text-[var(--warning-ink)]" data-testid="skill-test-readonly">
                    {t(
                        'skills_studio.test.read_only',
                        'You can see this skill but not change it, so you cannot run a test on it.',
                    )}
                </p>
            )}

            <TestTabSection t={t} agentId={agentId} agents={agents} setAgentId={setAgentId} />

            <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                aria-label={t('skills_studio.test.question', 'Question')}
                placeholder={t('skills_studio.test.placeholder', 'Ask something this skill should handle…')}
                className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2 text-xs outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />

            {steps.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)] m-0" data-testid="skill-test-no-steps">
                    {t('skills_studio.test.no_steps', 'Add steps first — a test grades one step at a time.')}
                </p>
            )}

            {error && (
                <p
                    className="text-xs m-0 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--warning-ink)]"
                    data-testid="skill-test-error"
                >
                    {error}
                </p>
            )}

            {kbNotice && (
                <p className="text-xs m-0 text-[var(--warning-ink)]" data-testid="skill-test-kb-dropped">
                    {t(
                        'skills_studio.test.kb_dropped',
                        'Not every knowledge base this skill links is available to you: {used} of {declared} were searched.',
                        { used: kbNotice.used, declared: kbNotice.declared },
                    )}
                </p>
            )}

            {answer && (
                <div className="flex flex-col gap-1" data-testid="skill-test-answer">
                    <h3 className="text-xs font-semibold text-[var(--text-primary)] m-0">
                        {t('skills_studio.test.answer', 'What the agent answered')}
                    </h3>
                    <p className="text-xs whitespace-pre-wrap m-0 px-3 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] text-[var(--text-secondary)]">
                        {answer}
                    </p>
                </div>
            )}

            {results.length > 0 && (
                <TestResults t={t} results={results} advice={result?.advice} adviceHref={adviceHref} onNavigate={onNavigate} />
            )}

            <TestHistory t={t} runs={runs} forbidden={forbidden} rel={rel} />
        </div>
    );
}
