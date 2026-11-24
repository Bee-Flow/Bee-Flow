/**
 * The goal line under a cowork's brief (./CoworkBrief.tsx): "Goal: <sentence> — 46 of 49 this week", or a quiet
 * "Add a goal" link. Either opens the small editor below it: the sentence and its target, "Draft the check", the
 * check in plain words (its steps, and that it only reads), and "Approve the check".
 *
 * Nothing is measured until the owner approves the check (server/usecases/coworkGoals.mts); the editor says so.
 * Working days are Monday to Friday and public holidays count as working days: the editor says that plainly too.
 */
import { useState } from 'react';
import { Target } from 'lucide-react';
import { useCoworkGoal, type CoworkGoal, type GoalCheck } from '@/api/coworkGoals';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import { effectText, goalCountText, trendText } from './coworkGoalModel';

const BUTTON = 'px-2.5 py-1 rounded-md border text-[12px] border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] disabled:opacity-50';
const QUIET = 'text-[12px] underline underline-offset-2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]';

/** The check in plain words: its steps, what each does, and whether it only reads. */
function CheckSteps({ check, t }: { check: GoalCheck; t: TranslateFn }) {
    return (
        <div className="flex flex-col gap-1.5" data-testid="cowork-goal-check">
            <h4 className="text-[11px] font-semibold text-[var(--text-secondary)]">
                {t('cowork_goals.check_heading', 'How the goal is checked after every run')}
            </h4>
            <ol className="list-decimal pl-5 text-[12px] text-[var(--text-secondary)]">
                {check.steps.map((step) => (
                    <li key={step.id}>{step.title} <span className="text-[var(--text-tertiary)]">· {effectText(step.effect, t)}</span></li>
                ))}
            </ol>
            {check.readsOnly
                ? <p className="text-[12px] text-[var(--success)]">{t('cowork_goals.reads_only', 'Reads only: the check changes and sends nothing.')}</p>
                : (
                    <div className="text-[12px] text-[var(--error)]" role="alert">
                        <p>{t('cowork_goals.not_allowed', 'This check cannot be approved:')}</p>
                        <ul className="list-disc pl-5">{check.findings.map((f, i) => <li key={`${f.code}-${i}`}>{f.message}</li>)}</ul>
                    </div>
                )}
        </div>
    );
}

/** Where the check stands: approved, changed since, or not approved yet. */
function approvalText(goal: CoworkGoal, t: TranslateFn): string {
    if (goal.approved && goal.upToDate) return t('cowork_goals.approved', 'The check is approved. It runs after every run of this work.');
    if (goal.approved) return t('cowork_goals.changed', 'The check changed since it was approved. Approve it again.');
    return t('cowork_goals.not_approved', 'The check is not approved yet: nothing is measured until you approve it.');
}

/** The sentence and the target as typed, and whether they can be saved. */
function useGoalForm(goal: CoworkGoal | null) {
    const [sentence, setSentence] = useState(goal?.sentence ?? '');
    const [target, setTarget] = useState(String(goal?.targetPercent ?? 100));
    const trimmed = sentence.trim();
    const targetPercent = Math.round(Number(target));
    const valid = trimmed.length > 0 && trimmed.length <= 500 && targetPercent >= 1 && targetPercent <= 100;
    // The check on screen belongs to the goal as saved: once the sentence is edited, it is drafted again.
    const unchanged = !!goal && goal.sentence === trimmed && goal.targetPercent === targetPercent;
    return { sentence, setSentence, target, setTarget, trimmed, targetPercent, valid, unchanged };
}

type GoalForm = ReturnType<typeof useGoalForm>;

function GoalFields({ form, t }: { form: GoalForm; t: TranslateFn }) {
    return (
        <>
            <label className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
                {t('cowork_goals.sentence_label', 'The goal, in one sentence')}
                <textarea
                    value={form.sentence}
                    onChange={(e) => form.setSentence(e.target.value)}
                    rows={2}
                    maxLength={500}
                    placeholder={t('cowork_goals.sentence_placeholder', 'Every supplier mail gets an answer within two working days')}
                    className="rounded-md border px-2 py-1.5 text-[13px] border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)]"
                />
            </label>
            <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                {t('cowork_goals.target_label', 'Share that should meet it (%)')}
                <input
                    type="number" min={1} max={100} value={form.target} onChange={(e) => form.setTarget(e.target.value)}
                    className="w-20 rounded-md border px-2 py-1 text-[13px] border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)]"
                />
            </label>
            <p className="text-[11.5px] text-[var(--text-tertiary)]">
                {t('cowork_goals.holidays', 'Working days are Monday to Friday. Public holidays count as working days.')}
            </p>
        </>
    );
}

/** Why the last change did not go through, in the server's words when it gave some. */
function FailureLine({ error, t }: { error: Error; t: TranslateFn }) {
    return <p className="text-[12px] text-[var(--error)]" role="alert">{error.message || t('cowork_goals.failed', 'That did not work. Try again.')}</p>;
}

/** Run a mutation from a click; a failure stays on the mutation and is shown under the editor. */
const run = (work: () => Promise<unknown>) => { work().catch(() => undefined); };

function GoalEditor({ coworkId, goal, onClose }: { coworkId: string; goal: CoworkGoal | null; onClose: () => void }) {
    const { t } = useTranslation();
    const { save, draft, approve, remove } = useCoworkGoal(coworkId);
    const form = useGoalForm(goal);
    const busy = [save, draft, approve, remove].some((m) => m.isPending);
    const failure = [save, draft, approve, remove].find((m) => m.error)?.error ?? null;
    // The check shown is the one of the goal as saved, never of a sentence still being typed.
    const shown = form.unchanged && goal?.check ? { goal, check: goal.check } : null;

    const draftCheck = async () => {
        if (!form.unchanged) await save.mutateAsync({ sentence: form.trimmed, targetPercent: form.targetPercent });
        await draft.mutateAsync();
    };
    const takeOff = async () => { await remove.mutateAsync(); onClose(); };

    return (
        <div className="flex flex-col gap-2.5 rounded-[8px] border p-3 border-[var(--border-subtle)] bg-[var(--bg-secondary)]" data-testid="cowork-goal-editor">
            <GoalFields form={form} t={t} />
            <div className="flex flex-wrap gap-2">
                <button type="button" className={BUTTON} disabled={!form.valid || busy} onClick={() => run(draftCheck)}>
                    {draft.isPending ? t('cowork_goals.drafting', 'Drafting the check…') : t('cowork_goals.draft', 'Draft the check')}
                </button>
                {shown && (
                    <button type="button" className={BUTTON} disabled={busy || !shown.check.readsOnly || shown.goal.upToDate} onClick={() => run(() => approve.mutateAsync(shown.check.fingerprint))}>
                        {t('cowork_goals.approve', 'Approve the check')}
                    </button>
                )}
                {goal && <button type="button" className={QUIET} disabled={busy} onClick={() => run(takeOff)}>{t('cowork_goals.remove', 'Take the goal off')}</button>}
                <button type="button" className={`${QUIET} ml-auto`} onClick={onClose}>{t('cowork_goals.close', 'Close')}</button>
            </div>
            {shown && (
                <>
                    <CheckSteps check={shown.check} t={t} />
                    <p className="text-[12px] text-[var(--text-secondary)]" data-testid="cowork-goal-approval">{approvalText(shown.goal, t)}</p>
                </>
            )}
            {failure && <FailureLine error={failure} t={t} />}
        </div>
    );
}

/** The goal line of one cowork, with its editor. */
export default function CoworkGoal({ coworkId }: { coworkId: string }) {
    const { t } = useTranslation();
    const { query } = useCoworkGoal(coworkId);
    const [open, setOpen] = useState(false);
    // Nothing while it loads or when it cannot be read: the brief stands without it.
    if (query.isPending || query.isError) return null;
    const goal = query.data;
    const lastFailed = goal?.results[0] && !goal.results[0].ok ? goal.results[0].error : null;
    return (
        <div className="flex flex-col gap-1.5" data-testid="cowork-goal">
            {goal ? (
                <p className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-secondary)]">
                    <Target aria-hidden="true" className="w-3.5 h-3.5 flex-shrink-0 text-[var(--type-trigger)]" />
                    <span data-testid="cowork-goal-line">
                        {t('cowork_goals.line', 'Goal: {sentence}', { sentence: goal.sentence })} — {goalCountText(goal.count, t)}{trendText(goal.trend, t)}
                    </span>
                    {!open && <button type="button" className={QUIET} onClick={() => setOpen(true)}>{t('cowork_goals.change', 'Change')}</button>}
                </p>
            ) : (
                !open && <button type="button" className={`${QUIET} self-start`} onClick={() => setOpen(true)}>{t('cowork_goals.add', 'Add a goal')}</button>
            )}
            {goal && lastFailed && <p className="text-[11.5px] text-[var(--text-tertiary)]">{t('cowork_goals.last_failed', 'The last check could not count: {reason}', { reason: lastFailed })}</p>}
            {open && <GoalEditor coworkId={coworkId} goal={goal ?? null} onClose={() => setOpen(false)} />}
        </div>
    );
}
