import React, { useMemo, useState } from 'react';
import { Check, X, RotateCcw, Eye, ArrowRight, Zap, Plus, Flag } from 'lucide-react';
import { useTranslation } from '../../../hooks/useTranslation';
import { matchPickCorrect, evaluateOrder, evaluateFlow, seededShuffle } from './sims/simLogic';

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
export default function SimStep({ step, saved, onState }) {
    const { t } = useTranslation();
    const sim = step.sim || {};
    const alreadyDone = saved?.status === 'passed' || saved?.status === 'revealed';

    return (
        <div>
            <div className="flex items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
                    style={{ background: 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' }} aria-hidden="true">
                    {step.icon || '🧩'}
                </div>
                <div className="pt-0.5">
                    <h2 className="text-base font-bold leading-snug" style={{ color: 'var(--text-primary)' }}>
                        {t(step.titleKey, step.titleFallback)}
                    </h2>
                    {step.instructionFallback && (
                        <p className="text-[13px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {t(step.instructionKey, step.instructionFallback)}
                        </p>
                    )}
                </div>
            </div>

            {alreadyDone && (
                <div className="mb-3 px-3.5 py-2 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
                    style={{ background: 'color-mix(in srgb, #22c55e 12%, transparent)', color: '#15803d' }}>
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

function MatchSim({ step, sim, t, onState }) {
    const pairs = sim.pairs || [];
    const lefts = useMemo(() => seededShuffle(pairs, `${step.id}-l`), [pairs, step.id]);
    const rights = useMemo(() => seededShuffle(pairs, `${step.id}-r`), [pairs, step.id]);

    const [pickedLeft, setPickedLeft] = useState(null);
    const [matched, setMatched] = useState(() => new Set());
    const [wrongFlash, setWrongFlash] = useState(null); // right id that flashed wrong
    const [mistakes, setMistakes] = useState(0);
    const [lastNote, setLastNote] = useState(null);

    const done = matched.size === pairs.length && pairs.length > 0;

    const pickRight = (rightId) => {
        if (!pickedLeft || matched.has(rightId)) return;
        if (matchPickCorrect(pairs, pickedLeft, rightId)) {
            const next = new Set(matched);
            next.add(rightId);
            setMatched(next);
            const pair = pairs.find((p) => p.id === rightId);
            setLastNote(pair?.noteFallback || null);
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

    const tile = (active, ok, bad) => ({
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
                            {matched.has(p.id) && <Check className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" style={{ color: '#15803d' }} />}
                            {p.left}
                        </button>
                    ))}
                </div>
                <div className="flex flex-col gap-2">
                    {rights.map((p) => (
                        <button key={p.id} type="button" disabled={matched.has(p.id)}
                            onClick={() => pickRight(p.id)}
                            className="text-left px-3 py-2.5 rounded-lg border text-[12.5px] leading-snug transition-colors disabled:opacity-60"
                            style={tile(false, matched.has(p.id), wrongFlash === p.id)}>
                            {matched.has(p.id) && <Check className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" style={{ color: '#15803d' }} />}
                            {p.right}
                        </button>
                    ))}
                </div>
            </div>

            {lastNote && !done && (
                <p className="mt-2.5 px-3 py-2 rounded-lg text-[12.5px]"
                    style={{ background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)', color: 'var(--text-secondary)' }}>
                    {lastNote}
                </p>
            )}
            {done && (
                <p className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: '#15803d' }}>
                    <Check className="w-4 h-4" /> {t('learn.sim.match_done', 'All matched — nice pattern-spotting.')}
                </p>
            )}
        </div>
    );
}

/* ── order: build the sequence ────────────────────────────────────────────── */

function OrderSim({ step, sim, t, onState }) {
    const items = sim.items || [];
    const bank = useMemo(() => seededShuffle(items, step.id), [items, step.id]);
    const [placed, setPlaced] = useState([]); // item ids in chosen order
    const [attempts, setAttempts] = useState(0);
    const [verdict, setVerdict] = useState(null); // { correct, firstWrongIndex }
    const [revealed, setRevealed] = useState(false);

    const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
    const passed = verdict?.correct || revealed;

    const place = (id) => {
        if (passed || placed.includes(id)) return;
        setVerdict(null);
        setPlaced((p) => [...p, id]);
    };
    const unplace = (id) => {
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
                    <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
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
                            <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0"
                                style={{ background: 'color-mix(in srgb, var(--accent-primary) 14%, transparent)', color: 'var(--accent-primary)' }}>
                                {i + 1}
                            </span>
                            {byId.get(id)?.label || id}
                            {wrongHere && <X className="w-3.5 h-3.5 ml-auto" style={{ color: '#b91c1c' }} />}
                        </button>
                    );
                })}
            </div>

            {/* The parts bank */}
            <div className="mt-2.5 flex flex-wrap gap-2">
                {bank.filter((i) => !placed.includes(i.id)).map((i) => (
                    <button key={i.id} type="button" onClick={() => place(i.id)}
                        className="px-3 py-2 rounded-lg border text-[12.5px] transition-colors hover:bg-[var(--bg-tertiary)]"
                        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
                        {i.label}
                    </button>
                ))}
            </div>

            {verdict && !verdict.correct && (
                <p className="mt-2.5 px-3 py-2 rounded-lg text-[12.5px]"
                    style={{ background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)', color: 'var(--text-secondary)' }}>
                    {sim.feedbackFallback || t('learn.sim.order_wrong', 'Not quite — the highlighted piece is the first one out of place. Tap pieces to take them back.')}
                </p>
            )}
            {passed && (
                <p className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: '#15803d' }}>
                    <Check className="w-4 h-4" />
                    {revealed ? t('learn.sim.revealed', 'Solution shown — walk through it once before moving on.') : t('learn.sim.order_done', 'Exactly right.')}
                </p>
            )}

            {!passed && (
                <div className="mt-3 flex items-center gap-2">
                    <button type="button" onClick={check} disabled={placed.length === 0}
                        className="px-4 py-2 rounded-lg text-[13px] font-semibold inline-flex items-center gap-1.5 transition-opacity disabled:opacity-40"
                        style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg, #fff)' }}>
                        {attempts > 0 ? <RotateCcw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                        {t('learn.sim.check', 'Check')}
                    </button>
                    {attempts >= 2 && (
                        <button type="button" onClick={reveal}
                            className="px-3 py-2 rounded-lg text-[12.5px] font-medium inline-flex items-center gap-1.5 border transition-colors hover:bg-[var(--bg-tertiary)]"
                            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', background: 'transparent' }}>
                            <Eye className="w-3.5 h-3.5" /> {t('learn.sim.show_solution', 'Show solution')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/* ── flow-build: the mini automation canvas ──────────────────────────────── */

function FlowBuildSim({ sim, t, onState }) {
    const scenarios = sim.scenarios || [];
    const [scenarioIdx, setScenarioIdx] = useState(0);
    const [triggerId, setTriggerId] = useState(null);
    const [stepIds, setStepIds] = useState([]);
    const [attempts, setAttempts] = useState(0);      // attempts on the CURRENT scenario
    const [problems, setProblems] = useState(null);
    const [solvedCurrent, setSolvedCurrent] = useState(false);
    const [anyRevealed, setAnyRevealed] = useState(false);
    const [allDone, setAllDone] = useState(false);

    const scenario = scenarios[scenarioIdx] || null;
    if (!scenario) return null;

    const resetBoard = () => { setTriggerId(null); setStepIds([]); setProblems(null); setAttempts(0); setSolvedCurrent(false); };

    const addStep = (id) => {
        if (solvedCurrent || stepIds.includes(id)) return;
        setProblems(null);
        setStepIds((s) => [...s, id]);
    };
    const removeStep = (id) => {
        if (solvedCurrent) return;
        setProblems(null);
        setStepIds((s) => s.filter((x) => x !== id));
    };

    const finishScenario = (revealedNow) => {
        setSolvedCurrent(true);
        const isLast = scenarioIdx === scenarios.length - 1;
        if (isLast) {
            setAllDone(true);
            onState?.({ status: (revealedNow || anyRevealed) ? 'revealed' : 'passed', attempts });
        }
    };

    const check = () => {
        const verdict = evaluateFlow(scenario, { triggerId, stepIds });
        setAttempts((a) => a + 1);
        if (verdict.correct) {
            setProblems(null);
            finishScenario(false);
        } else {
            setProblems(verdict.problems);
        }
    };

    const reveal = () => {
        setTriggerId(scenario.trigger?.correct || null);
        setStepIds([...(scenario.steps?.solution || [])]);
        setProblems(null);
        setAnyRevealed(true);
        finishScenario(true);
    };

    const nextScenario = () => {
        setScenarioIdx((i) => i + 1);
        resetBoard();
    };

    const stepLabel = (id) => (scenario.steps?.palette || []).find((p) => p.id === id)?.label || id;

    const node = (content, kind) => (
        <div className="px-3 py-2 rounded-lg border text-[12.5px] flex items-center gap-2"
            style={{
                borderColor: solvedCurrent ? '#15803d' : 'var(--border-default)',
                background: kind === 'trigger'
                    ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)'
                    : 'var(--bg-secondary)',
                color: 'var(--text-primary)',
            }}>
            {content}
        </div>
    );

    return (
        <div>
            {/* Scenario brief */}
            <div className="rounded-xl border p-3.5 mb-3"
                style={{ borderColor: 'var(--border-default)', background: 'color-mix(in srgb, var(--accent-primary) 5%, transparent)' }}>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--accent-primary)' }}>
                    {t('learn.sim.flow_task', 'Build it: task {n} of {total}')
                        .replace('{n}', String(scenarioIdx + 1)).replace('{total}', String(scenarios.length))}
                </div>
                <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>{scenario.briefFallback}</p>
            </div>

            {/* The rail: trigger → steps → result */}
            <div className="rounded-xl border p-3 flex flex-col gap-1.5"
                style={{ borderColor: solvedCurrent ? '#15803d' : 'var(--border-default)', background: 'var(--bg-card)' }}>
                {node(
                    triggerId
                        ? (<><Zap className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
                            <span className="font-semibold">{(scenario.trigger?.options || []).find((o) => o.id === triggerId)?.label || triggerId}</span>
                            {!solvedCurrent && (
                                <button type="button" onClick={() => { setTriggerId(null); setProblems(null); }} className="ml-auto" aria-label={t('learn.sim.remove', 'Remove')}>
                                    <X className="w-3.5 h-3.5" style={{ color: 'var(--text-tertiary)' }} />
                                </button>
                            )}</>)
                        : (<><Zap className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                            <span style={{ color: 'var(--text-tertiary)' }}>{t('learn.sim.flow_pick_trigger', 'Start with a trigger — pick one below')}</span></>),
                    'trigger',
                )}
                {stepIds.map((id, i) => (
                    <React.Fragment key={id}>
                        <div className="pl-4 text-[11px] leading-none" style={{ color: 'var(--text-tertiary)' }}>↓</div>
                        {node(
                            (<><span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0"
                                style={{ background: 'color-mix(in srgb, var(--accent-primary) 14%, transparent)', color: 'var(--accent-primary)' }}>{i + 1}</span>
                                {stepLabel(id)}
                                {!solvedCurrent && (
                                    <button type="button" onClick={() => removeStep(id)} className="ml-auto" aria-label={t('learn.sim.remove', 'Remove')}>
                                        <X className="w-3.5 h-3.5" style={{ color: 'var(--text-tertiary)' }} />
                                    </button>
                                )}</>),
                            'step',
                        )}
                    </React.Fragment>
                ))}
                <div className="pl-4 text-[11px] leading-none" style={{ color: 'var(--text-tertiary)' }}>↓</div>
                {node(
                    (<><Flag className="w-3.5 h-3.5 flex-shrink-0" style={{ color: solvedCurrent ? '#15803d' : 'var(--text-tertiary)' }} />
                        <span style={{ color: solvedCurrent ? '#15803d' : 'var(--text-tertiary)' }}>
                            {solvedCurrent ? t('learn.sim.flow_runs', 'This flow runs — nice build.') : t('learn.sim.flow_result', 'Result')}
                        </span></>),
                    'result',
                )}
            </div>

            {/* Trigger options */}
            {!solvedCurrent && (
                <>
                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                        {t('learn.sim.flow_triggers', 'Triggers')}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                        {(scenario.trigger?.options || []).map((o) => (
                            <button key={o.id} type="button" onClick={() => { setTriggerId(o.id); setProblems(null); }}
                                title={o.desc}
                                className="px-3 py-1.5 rounded-full border text-[12px] inline-flex items-center gap-1.5 transition-colors"
                                style={{
                                    borderColor: triggerId === o.id ? 'var(--accent-primary)' : 'var(--border-default)',
                                    background: triggerId === o.id ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' : 'var(--bg-card)',
                                    color: 'var(--text-primary)',
                                }}>
                                <Zap className="w-3 h-3" /> {o.label}
                            </button>
                        ))}
                    </div>

                    {/* Steps palette */}
                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                        {t('learn.sim.flow_steps', 'Steps — tap to add, in order')}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                        {(scenario.steps?.palette || []).filter((p) => !stepIds.includes(p.id)).map((p) => (
                            <button key={p.id} type="button" onClick={() => addStep(p.id)} title={p.hint}
                                className="px-3 py-1.5 rounded-lg border text-[12px] inline-flex items-center gap-1.5 transition-colors hover:bg-[var(--bg-tertiary)]"
                                style={{ borderColor: 'var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
                                <Plus className="w-3 h-3" style={{ color: 'var(--text-tertiary)' }} /> {p.label}
                            </button>
                        ))}
                    </div>
                </>
            )}

            {problems && problems.length > 0 && (
                <div className="mt-3 px-3.5 py-2.5 rounded-lg text-[12.5px] flex flex-col gap-1"
                    style={{ background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)', color: 'var(--text-secondary)' }}>
                    {problems.map((p, i) => <span key={i}>• {p}</span>)}
                </div>
            )}

            <div className="mt-3 flex items-center gap-2">
                {!solvedCurrent && (
                    <>
                        <button type="button" onClick={check} disabled={!triggerId && stepIds.length === 0}
                            className="px-4 py-2 rounded-lg text-[13px] font-semibold inline-flex items-center gap-1.5 transition-opacity disabled:opacity-40"
                            style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg, #fff)' }}>
                            {attempts > 0 ? <RotateCcw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                            {t('learn.sim.flow_check', 'Check my flow')}
                        </button>
                        {attempts >= 2 && (
                            <button type="button" onClick={reveal}
                                className="px-3 py-2 rounded-lg text-[12.5px] font-medium inline-flex items-center gap-1.5 border transition-colors hover:bg-[var(--bg-tertiary)]"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', background: 'transparent' }}>
                                <Eye className="w-3.5 h-3.5" /> {t('learn.sim.show_solution', 'Show solution')}
                            </button>
                        )}
                    </>
                )}
                {solvedCurrent && !allDone && (
                    <button type="button" onClick={nextScenario}
                        className="px-4 py-2 rounded-lg text-[13px] font-semibold inline-flex items-center gap-1.5"
                        style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg, #fff)' }}>
                        {t('learn.sim.flow_next', 'Next task')} <ArrowRight className="w-4 h-4" />
                    </button>
                )}
                {allDone && (
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: '#15803d' }}>
                        <Check className="w-4 h-4" /> {t('learn.sim.flow_all_done', 'All flows built — continue below.')}
                    </span>
                )}
            </div>
        </div>
    );
}
