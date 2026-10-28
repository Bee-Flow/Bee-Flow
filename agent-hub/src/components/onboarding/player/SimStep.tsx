import { useMemo, useState } from 'react';
import { Check, X, RotateCcw, Eye } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { LessonStep, OnState, SimConfig, SimStepProps, TranslateFn } from './SimStep.types';
import { matchPickCorrect, evaluateOrder, seededShuffle } from './sims/simLogic';
import { FlowBuildSim } from './FlowBuildSim';
/**
 * SimStep — an interactive widget that IS the question (Brilliant-style): the
 * learner constructs the answer instead of picking prose from a list. Three
 * kinds, all graded locally by sims/simLogic.js:
 *
 *   match      — tap-the-pairs (scenario ↔ concept)
 *   order      — assemble items into the right sequence
 *   flow-build — a mini automation canvas: pick a trigger, build the steps rail
 *
 * Mistake-friendly by design: retries are free with targeted feedback, and
 * after two honest failed checks a "Show solution" appears — taking it records
 * status 'revealed' (still advanceable; no punishment wall).
 *
 * Props:
 *   step    — { sim: {...}, titleKey/Fallback, icon }
 *   saved   — resume state { status, attempts }
 *   onState — called with { status, attempts } on pass/reveal
 */
export default function SimStep({ step, saved, onState }: SimStepProps) {
    const { t } = useTranslation();
    const sim = step.sim || {};
    const alreadyDone = saved?.status === 'passed' || saved?.status === 'revealed';

    return (
        <div>
            <div className="flex items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0 [background:color-mix(in_srgb,var(--accent-primary)_14%,transparent)]" aria-hidden="true">
                    {step.icon || '🧩'}
                </div>
                <div className="pt-0.5">
                    <h2 className="text-base font-bold leading-snug text-[var(--text-primary)]">
                        {t(step.titleKey, step.titleFallback)}
                    </h2>
                    {step.instructionFallback && (
                        <p className="text-[13px] mt-1 leading-relaxed text-[var(--text-secondary)]">
                            {t(step.instructionKey, step.instructionFallback)}
                        </p>
                    )}
                </div>
            </div>

            {alreadyDone && (
                <div className="mb-3 px-3.5 py-2 rounded-lg text-[12.5px] inline-flex items-center gap-1.5 [background:color-mix(in_srgb,#22c55e_12%,transparent)] [color:#15803d]!">
                    <Check className="w-3.5 h-3.5" /> {t('learn.sim.done_before', 'Completed — replay it below if you like.')}
                </div>
            )}

            {sim.kind === 'match' && <MatchSim key={step.id} step={step} sim={sim} t={t} onState={onState} />}
            {sim.kind === 'order' && <OrderSim key={step.id} step={step} sim={sim} t={t} onState={onState} />}
            {sim.kind === 'flow-build' && <FlowBuildSim key={step.id} sim={sim} t={t} onState={onState} />}
        </div>
    );
}

/* ── match: tap-the-pairs ─────────────────────────────────────────────────── */

function MatchSim({ step, sim, t, onState }: { step: LessonStep; sim: SimConfig; t: TranslateFn; onState: OnState }) {
    const pairs = useMemo(() => sim.pairs || [], [sim.pairs]);
    const lefts = useMemo(() => seededShuffle(pairs, `${step.id}-l`), [pairs, step.id]);
    const rights = useMemo(() => seededShuffle(pairs, `${step.id}-r`), [pairs, step.id]);

    const [pickedLeft, setPickedLeft] = useState<string | null>(null);
    const [matched, setMatched] = useState<Set<string>>(() => new Set());
    const [wrongFlash, setWrongFlash] = useState<string | null>(null); // right id that flashed wrong
    const [mistakes, setMistakes] = useState(0);
    const [lastNote, setLastNote] = useState<string | null>(null);

    const done = matched.size === pairs.length && pairs.length > 0;

    const pickRight = (rightId: string) => {
        if (!pickedLeft || matched.has(rightId)) return;
        if (matchPickCorrect(pairs, pickedLeft, rightId)) {
            const next = new Set(matched);
            next.add(rightId);
            setMatched(next);
            const pair = pairs.find((p) => p.id === rightId);
            setLastNote(pair ? t(pair.noteKey, pair.noteFallback) : null);
            setPickedLeft(null);
            if (next.size === pairs.length) {
                onState?.({ status: 'passed', attempts: mistakes + 1 });
            }
        } else {
            setMistakes((m) => m + 1);
            setWrongFlash(rightId);
            setTimeout(() => setWrongFlash(null), 650);
        }
    };

    const tile = (active: boolean, ok: boolean, bad: boolean) => ({
        borderColor: bad ? '#b91c1c' : ok ? '#15803d' : active ? 'var(--accent-primary)' : 'var(--border-default)',
        background: bad ? 'color-mix(in srgb, #ef4444 10%, transparent)'
            : ok ? 'color-mix(in srgb, #22c55e 10%, transparent)'
                : active ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' : 'var(--bg-card)',
        color: 'var(--text-primary)',
    });

    return (
        <div>
            <div className="grid grid-cols-2 gap-2.5">
                <div className="flex flex-col gap-2">
                    {lefts.map((p) => (
                        <button key={p.id} type="button" disabled={matched.has(p.id)}
                            onClick={() => setPickedLeft(pickedLeft === p.id ? null : p.id)}
                            className="text-left px-3 py-2.5 rounded-lg border text-[12.5px] leading-snug transition-colors disabled:opacity-60"
                            style={tile(pickedLeft === p.id, matched.has(p.id), false)}>
                            {matched.has(p.id) && <Check className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5 [color:#15803d]" />}
                            {t(p.leftKey, p.left)}
                        </button>
                    ))}
                </div>
                <div className="flex flex-col gap-2">
                    {rights.map((p) => (
                        <button key={p.id} type="button" disabled={matched.has(p.id)}
                            onClick={() => pickRight(p.id)}
                            className="text-left px-3 py-2.5 rounded-lg border text-[12.5px] leading-snug transition-colors disabled:opacity-60"
                            style={tile(false, matched.has(p.id), wrongFlash === p.id)}>
                            {matched.has(p.id) && <Check className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5 [color:#15803d]" />}
                            {t(p.rightKey, p.right)}
                        </button>
                    ))}
                </div>
            </div>

            {lastNote && !done && (
                <p className="mt-2.5 px-3 py-2 rounded-lg text-[12.5px] [background:color-mix(in_srgb,var(--accent-primary)_8%,transparent)] [color:var(--text-secondary)]!">
                    {lastNote}
                </p>
            )}
            {done && (
                <p className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold [color:#15803d]!">
                    <Check className="w-4 h-4" /> {t('learn.sim.match_done', 'All matched — nice pattern-spotting.')}
                </p>
            )}
        </div>
    );
}

/* ── order: build the sequence ────────────────────────────────────────────── */

function OrderSim({ step, sim, t, onState }: { step: LessonStep; sim: SimConfig; t: TranslateFn; onState: OnState }) {
    const items = useMemo(() => sim.items || [], [sim.items]);
    const bank = useMemo(() => seededShuffle(items, step.id), [items, step.id]);
    const [placed, setPlaced] = useState<string[]>([]); // item ids in chosen order
    const [attempts, setAttempts] = useState(0);
    const [verdict, setVerdict] = useState<{ correct: boolean; firstWrongIndex: number } | null>(null); // { correct, firstWrongIndex }
    const [revealed, setRevealed] = useState(false);

    const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
    const passed = verdict?.correct || revealed;

    const place = (id: string) => {
        if (passed || placed.includes(id)) return;
        setVerdict(null);
        setPlaced((p) => [...p, id]);
    };
    const unplace = (id: string) => {
        if (passed) return;
        setVerdict(null);
        setPlaced((p) => p.filter((x) => x !== id));
    };
    const check = () => {
        const v = evaluateOrder(sim.solution, placed);
        const nextAttempts = attempts + 1;
        setAttempts(nextAttempts);
        setVerdict(v);
        if (v.correct) onState?.({ status: 'passed', attempts: nextAttempts });
    };
    const reveal = () => {
        setPlaced([...(sim.solution || [])]);
        setRevealed(true);
        setVerdict({ correct: true, firstWrongIndex: -1 });
        onState?.({ status: 'revealed', attempts });
    };

    return (
        <div>
            {/* The answer rail */}
            <div className="rounded-xl border p-3 min-h-[54px] flex flex-col gap-1.5"
                style={{ borderColor: passed ? '#15803d' : 'var(--border-default)', background: 'var(--bg-card)' }}>
                {placed.length === 0 && (
                    <span className="text-[12px] text-[var(--text-tertiary)]">
                        {t('learn.sim.order_empty', 'Tap the pieces below in the order you think is right.')}
                    </span>
                )}
                {placed.map((id, i) => {
                    const wrongHere = verdict && !verdict.correct && verdict.firstWrongIndex === i;
                    return (
                        <button key={id} type="button" onClick={() => unplace(id)}
                            className="text-left px-3 py-2 rounded-lg border text-[12.5px] flex items-center gap-2 transition-colors"
                            style={{
                                borderColor: wrongHere ? '#b91c1c' : passed ? '#15803d' : 'var(--border-subtle)',
                                background: wrongHere ? 'color-mix(in srgb, #ef4444 8%, transparent)' : 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                            }}>
                            <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 [background:color-mix(in_srgb,var(--accent-primary)_14%,transparent)] [color:var(--accent-primary)]!">
                                {i + 1}
                            </span>
                            {(() => { const it = byId.get(id); return it ? t(it.labelKey, it.label) : id; })()}
                            {wrongHere && <X className="w-3.5 h-3.5 ml-auto [color:#b91c1c]" />}
                        </button>
                    );
                })}
            </div>

            {/* The parts bank */}
            <div className="mt-2.5 flex flex-wrap gap-2">
                {bank.filter((i) => !placed.includes(i.id)).map((i) => (
                    <button key={i.id} type="button" onClick={() => place(i.id)}
                        className="px-3 py-2 rounded-lg border text-[12.5px] transition-colors hover:bg-[var(--bg-tertiary)] [border-color:var(--border-default)] [background:var(--bg-card)]! [color:var(--text-primary)]!">
                        {t(i.labelKey, i.label)}
                    </button>
                ))}
            </div>

            {verdict && !verdict.correct && (
                <p className="mt-2.5 px-3 py-2 rounded-lg text-[12.5px] [background:color-mix(in_srgb,var(--accent-primary)_8%,transparent)] [color:var(--text-secondary)]!">
                    {sim.feedbackFallback ? t(sim.feedbackKey, sim.feedbackFallback) : t('learn.sim.order_wrong', 'Not quite — the highlighted piece is the first one out of place. Tap pieces to take them back.')}
                </p>
            )}
            {passed && (
                <p className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold [color:#15803d]!">
                    <Check className="w-4 h-4" />
                    {revealed ? t('learn.sim.revealed', 'Solution shown — walk through it once before moving on.') : t('learn.sim.order_done', 'Exactly right.')}
                </p>
            )}

            {!passed && (
                <div className="mt-3 flex items-center gap-2">
                    <button type="button" onClick={check} disabled={placed.length === 0}
                        className="px-4 py-2 rounded-lg text-[13px] font-semibold inline-flex items-center gap-1.5 transition-opacity disabled:opacity-40 [background:var(--accent-primary)] [color:var(--accent-primary-fg,#fff)]!">
                        {attempts > 0 ? <RotateCcw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                        {t('learn.sim.check', 'Check')}
                    </button>
                    {attempts >= 2 && (
                        <button type="button" onClick={reveal}
                            className="px-3 py-2 rounded-lg text-[12.5px] font-medium inline-flex items-center gap-1.5 border transition-colors hover:bg-[var(--bg-tertiary)] [border-color:var(--border-default)] [color:var(--text-secondary)]! [background:transparent]!">
                            <Eye className="w-3.5 h-3.5" /> {t('learn.sim.show_solution', 'Show solution')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/* ── flow-build: the mini automation canvas ──────────────────────────────── */

