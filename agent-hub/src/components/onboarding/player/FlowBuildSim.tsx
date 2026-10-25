import React, { useState } from 'react';
import { Check, X, RotateCcw, Eye, ArrowRight, Zap, Plus, Flag } from 'lucide-react';
import type { OnState, SimConfig, TranslateFn } from './SimStep.types';
import { evaluateFlow } from './sims/simLogic';

export function FlowBuildSim({ sim, t, onState }: { sim: SimConfig; t: TranslateFn; onState: OnState }) {
    const scenarios = sim.scenarios || [];
    const [scenarioIdx, setScenarioIdx] = useState(0);
    const [triggerId, setTriggerId] = useState<string | null>(null);
    const [stepIds, setStepIds] = useState<string[]>([]);
    const [attempts, setAttempts] = useState(0);      // attempts on the CURRENT scenario
    const [problems, setProblems] = useState<string[] | null>(null);
    const [solvedCurrent, setSolvedCurrent] = useState(false);
    const [anyRevealed, setAnyRevealed] = useState(false);
    const [allDone, setAllDone] = useState(false);

    const scenario = scenarios[scenarioIdx] || null;
    if (!scenario) return null;

    const resetBoard = () => { setTriggerId(null); setStepIds([]); setProblems(null); setAttempts(0); setSolvedCurrent(false); };

    const addStep = (id: string) => {
        if (solvedCurrent || stepIds.includes(id)) return;
        setProblems(null);
        setStepIds((s) => [...s, id]);
    };
    const removeStep = (id: string) => {
        if (solvedCurrent) return;
        setProblems(null);
        setStepIds((s) => s.filter((x) => x !== id));
    };

    const finishScenario = (revealedNow: boolean) => {
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

    const stepLabel = (id: string) => (scenario.steps?.palette || []).find((p) => p.id === id)?.label || id;

    const node = (content: React.ReactNode, kind: string) => (
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
            <div className="rounded-xl border p-3.5 mb-3 [border-color:var(--border-default)] [background:color-mix(in_srgb,var(--accent-primary)_5%,transparent)]">
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-1 text-[var(--accent-primary)]">
                    {t('learn.sim.flow_task', 'Build it: task {n} of {total}')
                        .replace('{n}', String(scenarioIdx + 1)).replace('{total}', String(scenarios.length))}
                </div>
                <p className="text-[13px] leading-relaxed text-[var(--text-primary)]">{t(scenario.briefKey, scenario.briefFallback)}</p>
            </div>

            {/* The rail: trigger → steps → result */}
            <div className="rounded-xl border p-3 flex flex-col gap-1.5"
                style={{ borderColor: solvedCurrent ? '#15803d' : 'var(--border-default)', background: 'var(--bg-card)' }}>
                {node(
                    triggerId
                        ? (<><Zap className="w-3.5 h-3.5 flex-shrink-0 text-[var(--accent-primary)]" />
                            <span className="font-semibold">{(scenario.trigger?.options || []).find((o) => o.id === triggerId)?.label || triggerId}</span>
                            {!solvedCurrent && (
                                <button type="button" onClick={() => { setTriggerId(null); setProblems(null); }} className="ml-auto" aria-label={t('learn.sim.remove', 'Remove')}>
                                    <X className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                                </button>
                            )}</>)
                        : (<><Zap className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-tertiary)]" />
                            <span className="text-[var(--text-tertiary)]">{t('learn.sim.flow_pick_trigger', 'Start with a trigger — pick one below')}</span></>),
                    'trigger',
                )}
                {stepIds.map((id, i) => (
                    <React.Fragment key={id}>
                        <div className="pl-4 text-[11px] leading-none text-[var(--text-tertiary)]">↓</div>
                        {node(
                            (<><span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 [background:color-mix(in_srgb,var(--accent-primary)_14%,transparent)] [color:var(--accent-primary)]!">{i + 1}</span>
                                {stepLabel(id)}
                                {!solvedCurrent && (
                                    <button type="button" onClick={() => removeStep(id)} className="ml-auto" aria-label={t('learn.sim.remove', 'Remove')}>
                                        <X className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                                    </button>
                                )}</>),
                            'step',
                        )}
                    </React.Fragment>
                ))}
                <div className="pl-4 text-[11px] leading-none text-[var(--text-tertiary)]">↓</div>
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
                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
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
                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                        {t('learn.sim.flow_steps', 'Steps — tap to add, in order')}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                        {(scenario.steps?.palette || []).filter((p) => !stepIds.includes(p.id)).map((p) => (
                            <button key={p.id} type="button" onClick={() => addStep(p.id)} title={p.hint}
                                className="px-3 py-1.5 rounded-lg border text-[12px] inline-flex items-center gap-1.5 transition-colors hover:bg-[var(--bg-tertiary)] [border-color:var(--border-default)] [background:var(--bg-card)]! [color:var(--text-primary)]!">
                                <Plus className="w-3 h-3 text-[var(--text-tertiary)]" /> {p.label}
                            </button>
                        ))}
                    </div>
                </>
            )}

            {problems && problems.length > 0 && (
                <div className="mt-3 px-3.5 py-2.5 rounded-lg text-[12.5px] flex flex-col gap-1 [background:color-mix(in_srgb,var(--accent-primary)_8%,transparent)] [color:var(--text-secondary)]!">
                    {problems.map((p, i) => <span key={i}>• {p}</span>)}
                </div>
            )}

            <div className="mt-3 flex items-center gap-2">
                {!solvedCurrent && (
                    <>
                        <button type="button" onClick={check} disabled={!triggerId && stepIds.length === 0}
                            className="px-4 py-2 rounded-lg text-[13px] font-semibold inline-flex items-center gap-1.5 transition-opacity disabled:opacity-40 [background:var(--accent-primary)] [color:var(--accent-primary-fg,#fff)]!">
                            {attempts > 0 ? <RotateCcw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                            {t('learn.sim.flow_check', 'Check my flow')}
                        </button>
                        {attempts >= 2 && (
                            <button type="button" onClick={reveal}
                                className="px-3 py-2 rounded-lg text-[12.5px] font-medium inline-flex items-center gap-1.5 border transition-colors hover:bg-[var(--bg-tertiary)] [border-color:var(--border-default)] [color:var(--text-secondary)]! [background:transparent]!">
                                <Eye className="w-3.5 h-3.5" /> {t('learn.sim.show_solution', 'Show solution')}
                            </button>
                        )}
                    </>
                )}
                {solvedCurrent && !allDone && (
                    <button type="button" onClick={nextScenario}
                        className="px-4 py-2 rounded-lg text-[13px] font-semibold inline-flex items-center gap-1.5 [background:var(--accent-primary)] [color:var(--accent-primary-fg,#fff)]!">
                        {t('learn.sim.flow_next', 'Next task')} <ArrowRight className="w-4 h-4" />
                    </button>
                )}
                {allDone && (
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold [color:#15803d]!">
                        <Check className="w-4 h-4" /> {t('learn.sim.flow_all_done', 'All flows built — continue below.')}
                    </span>
                )}
            </div>
        </div>
    );
}
