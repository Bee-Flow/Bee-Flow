import React, { useMemo, useRef, useState } from 'react';
import { Check, X, RotateCcw, Loader2 } from 'lucide-react';
import { useTranslation } from '../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { gradePracticeItem } from '../practiceClient';

/**
 * QuizStep — a multiple-choice knowledge check. Single-answer by default; set
 * `step.multi` for "select all that apply". The player gates Next on a pass.
 *
 * Three grading branches:
 *   • built-in quizzes carry their answer key (`choice.correct`) and grade locally;
 *   • org-authored quizzes are `step.serverGraded`: the key never reaches the
 *     client, so the answer is checked via POST /ai/learning/quiz/grade and the
 *     correct ids are only revealed by the server on a pass;
 *   • AI-generated practice items carry `step.practice = { practiceId }` and are
 *     checked via POST /ai/learning/practice/grade the same way — the server also
 *     returns the item's explanation, which built-ins carry client-side.
 *
 * BOTH outcomes are recorded (v2): a wrong submission saves
 * { status:'failed', attempts, wrongChoiceIds } so the review engine can build a
 * mistakes inventory; a pass saves the passing state (plus any wrong tries made
 * on the way). Attempts count per RUN (component mount), so a clean replay
 * genuinely resets the record.
 *
 * Props:
 *   step      — quiz step descriptor
 *   lessonId  — owning lesson (needed for server grading)
 *   saved     — previously recorded state (for resume)
 *   onState   — called with the recorded state after every graded submission
 */

// Cap the persisted wrong-id list — enough to review from, small enough that
// the per-step state stays far under the server's 2KB cap.
const MAX_WRONG_IDS = 8;

export default function QuizStep({ step, lessonId, saved, onState }) {
    const { t } = useTranslation();
    const multi = !!step.multi;
    const serverGraded = !!step.serverGraded;
    const practice = step.practice || null; // { practiceId } for AI-generated items
    const remoteGraded = serverGraded || !!practice;
    const localCorrectIds = useMemo(
        () => new Set((step.choices || []).filter((c) => c.correct).map((c) => c.id)),
        [step],
    );
    // For remotely-graded quizzes the key arrives with a passing verdict.
    const [revealedIds, setRevealedIds] = useState(() => new Set(saved?.correctChoiceIds || []));
    const correctIds = remoteGraded ? revealedIds : localCorrectIds;

    const alreadyPassed = saved?.status === 'passed';
    const [selected, setSelected] = useState(() => new Set(saved?.choiceIds || []));
    const [result, setResult] = useState(alreadyPassed ? 'correct' : null); // null | 'correct' | 'wrong'
    const [checking, setChecking] = useState(false);
    // Practice items get their explanation from the grade response.
    const [practiceExplanation, setPracticeExplanation] = useState('');
    const [practiceNote, setPracticeNote] = useState(null);

    // Per-run bookkeeping for the mistakes inventory.
    const [attempts, setAttempts] = useState(0);
    const wrongIdsRef = useRef(new Set());

    const toggle = (id) => {
        if (result === 'correct') return;
        setResult(null);
        setSelected((prev) => {
            const next = new Set(multi ? prev : []);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const wrongIdsOut = () => [...wrongIdsRef.current].slice(0, MAX_WRONG_IDS);

    const recordFail = (wrongPicked) => {
        const n = attempts + 1;
        setAttempts(n);
        wrongPicked.forEach((id) => { if (wrongIdsRef.current.size < MAX_WRONG_IDS) wrongIdsRef.current.add(id); });
        setResult('wrong');
        onState?.({ status: 'failed', attempts: n, wrongChoiceIds: wrongIdsOut(), answeredAt: new Date().toISOString() });
    };

    const recordPass = (extra = {}) => {
        const n = attempts + 1;
        setAttempts(n);
        setResult('correct');
        onState?.({
            status: 'passed', choiceIds: [...selected], attempts: n,
            ...(wrongIdsRef.current.size ? { wrongChoiceIds: wrongIdsOut() } : {}),
            answeredAt: new Date().toISOString(), ...extra,
        });
    };

    const check = async () => {
        if (practice) {
            if (checking) return;
            setChecking(true);
            setPracticeNote(null);
            const body = await gradePracticeItem({ practiceId: practice.practiceId, itemId: step.id, choiceIds: [...selected] });
            setChecking(false);
            if (body.error === 'practice_expired') {
                setPracticeNote(t('learn.practice.expired', 'This practice set has expired — start a fresh review from the Learning Center.'));
                return;
            }
            if (body.error) {
                setPracticeNote(t('learn.practice.grade_failed', 'Couldn\'t check that answer — try again in a moment.'));
                return;
            }
            setPracticeExplanation(body.explanation || '');
            if (body.correct) {
                setRevealedIds(new Set(body.correctChoiceIds || [...selected]));
                recordPass({ correctChoiceIds: body.correctChoiceIds || [...selected] });
            } else {
                recordFail([...selected]);
            }
            return;
        }
        if (serverGraded) {
            if (checking) return;
            setChecking(true);
            try {
                const res = await authFetch(`${API_BASE}/ai/learning/quiz/grade`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lessonId, stepId: step.id, choiceIds: [...selected] }),
                });
                const body = await res.json().catch(() => null);
                if (res.ok && body?.correct) {
                    setRevealedIds(new Set(body.correctChoiceIds || [...selected]));
                    recordPass({ correctChoiceIds: body.correctChoiceIds || [...selected] });
                } else {
                    recordFail([...selected]);
                }
            } catch (_) {
                setResult('wrong'); // network hiccup — not a graded fail, don't record
            } finally {
                setChecking(false);
            }
            return;
        }
        const sameSize = selected.size === correctIds.size;
        const allRight = sameSize && [...selected].every((id) => correctIds.has(id));
        if (allRight) {
            recordPass();
        } else {
            recordFail([...selected].filter((id) => !correctIds.has(id)));
        }
    };

    const explanation = practice ? practiceExplanation : t(step.explanationKey, step.explanationFallback);

    // Wrong-answer-specific feedback (Brilliant-style): when the learner is
    // wrong and a selected wrong choice carries its own `feedbackFallback`,
    // teach against THAT misconception instead of the generic explanation.
    const wrongChoiceFeedback = result === 'wrong'
        ? (step.choices || [])
            .filter((c) => selected.has(c.id) && !correctIds.has(c.id) && (c.feedbackFallback || c.feedbackKey))
            .map((c) => t(c.feedbackKey, c.feedbackFallback))
            .find(Boolean)
        : null;

    return (
        <div>
            <div className="flex items-start gap-3 mb-3">
                <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
                    style={{ background: 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' }}
                    aria-hidden="true"
                >
                    {step.icon || '❓'}
                </div>
                <h2 className="text-base font-bold leading-snug pt-1.5" style={{ color: 'var(--text-primary)' }}>
                    {t(step.questionKey, step.questionFallback)}
                </h2>
            </div>

            {multi && (
                <p className="text-[12px] mb-2" style={{ color: 'var(--text-tertiary)' }}>
                    {t('learn.quiz.select_all', 'Select all that apply.')}
                </p>
            )}

            <div className="flex flex-col gap-2">
                {(step.choices || []).map((c) => {
                    const isSelected = selected.has(c.id);
                    const showCorrect = result === 'correct' && correctIds.has(c.id);
                    const showWrong = result === 'wrong' && isSelected && !correctIds.has(c.id);
                    let borderColor = 'var(--border-default)';
                    let bg = 'var(--bg-card)';
                    if (showCorrect) { borderColor = '#15803d'; bg = 'color-mix(in srgb, #22c55e 12%, transparent)'; }
                    else if (showWrong) { borderColor = '#b91c1c'; bg = 'color-mix(in srgb, #ef4444 10%, transparent)'; }
                    else if (isSelected) { borderColor = 'var(--accent-primary)'; bg = 'color-mix(in srgb, var(--accent-primary) 10%, transparent)'; }
                    return (
                        <button
                            key={c.id}
                            type="button"
                            onClick={() => toggle(c.id)}
                            disabled={result === 'correct'}
                            className="text-left px-3.5 py-2.5 rounded-lg border text-[13px] flex items-start gap-2.5 transition-colors"
                            style={{ borderColor, background: bg, color: 'var(--text-primary)' }}
                        >
                            <span
                                className="mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0"
                                style={{ borderColor: isSelected ? 'var(--accent-primary)' : 'var(--border-default)' }}
                                aria-hidden="true"
                            >
                                {showCorrect && <Check className="w-3 h-3" style={{ color: '#15803d' }} />}
                                {showWrong && <X className="w-3 h-3" style={{ color: '#b91c1c' }} />}
                                {!showCorrect && !showWrong && isSelected && (
                                    <span className="w-2 h-2 rounded-full" style={{ background: 'var(--accent-primary)' }} />
                                )}
                            </span>
                            <span>{t(c.labelKey, c.labelFallback)}</span>
                        </button>
                    );
                })}
            </div>

            {result && (wrongChoiceFeedback || explanation) && (
                <div
                    className="mt-3 px-3.5 py-2.5 rounded-lg text-[13px] leading-relaxed"
                    style={{
                        background: result === 'correct'
                            ? 'color-mix(in srgb, #22c55e 10%, transparent)'
                            : 'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
                        color: 'var(--text-secondary)',
                    }}
                >
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {result === 'correct' ? t('learn.quiz.correct', 'Correct! ') : t('learn.quiz.not_quite', 'Not quite. ')}
                    </span>
                    {result === 'wrong' ? (wrongChoiceFeedback || explanation) : explanation}
                </div>
            )}

            {practiceNote && (
                <p className="mt-2 text-[12px]" style={{ color: 'var(--text-tertiary)' }} role="status">
                    {practiceNote}
                </p>
            )}

            <div className="mt-4">
                {result !== 'correct' ? (
                    <button
                        type="button"
                        onClick={check}
                        disabled={selected.size === 0 || checking}
                        className="px-4 py-2 rounded-lg text-[13px] font-semibold inline-flex items-center gap-2 transition-opacity disabled:opacity-40"
                        style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg, #fff)' }}
                    >
                        {checking
                            ? (<><Loader2 className="w-4 h-4 animate-spin" /> {t('learn.quiz.checking', 'Checking…')}</>)
                            : result === 'wrong'
                                ? (<><RotateCcw className="w-4 h-4" /> {t('learn.quiz.try_again', 'Try again')}</>)
                                : t('learn.quiz.check', 'Check answer')}
                    </button>
                ) : (
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: '#15803d' }}>
                        <Check className="w-4 h-4" /> {t('learn.quiz.passed', 'Nice — continue below.')}
                    </span>
                )}
            </div>
        </div>
    );
}
