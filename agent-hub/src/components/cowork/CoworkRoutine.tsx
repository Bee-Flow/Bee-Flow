/**
 * "Make it routine", for an item an AI runs (./CoworkPlanPanel.tsx): what its last good runs did every time, in app
 * actions and counts only, and one button that has Cowork propose fixed steps for it. Nothing changes until the plan
 * is approved. ./CoworkRoutineCompare.tsx is the proof, after a try-out.
 */
import { Repeat } from 'lucide-react';
import { useCoworkRoutine } from '../../api/coworkRoutine';
import type { TranslateFn } from '../../hooks/useTranslation';

export default function CoworkRoutine({ coworkId, busy, onPropose, t }: { coworkId: string; busy: boolean; onPropose: () => void; t: TranslateFn }) {
    const advice = useCoworkRoutine(coworkId, true).data;
    const signals = advice?.signals;
    if (!advice?.applicable || !signals?.worthIt) return null;
    return (
        <div className="flex flex-col gap-1.5" data-testid="cowork-routine">
            <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-primary)]">
                <Repeat aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork.routine.heading', 'Make it routine')}
            </span>
            <span className="text-[12px] text-[var(--text-secondary)]">
                {t('cowork.routine.seen', 'It went the same way in its last {count} runs. Every run used: {tools}.', {
                    count: signals.runs,
                    tools: signals.steady.map((h) => t('cowork.routine.tool', '{tool} (about {calls} a run)', { tool: h.tool, calls: h.callsPerRun })).join(', '),
                })}
            </span>
            <span className="text-[12px] text-[var(--text-tertiary)]">
                {t('cowork.routine.hint', 'Cowork can make that fixed steps, with AI only where it has to judge or write. It looked at app actions and counts only, never at what they read. Nothing changes until you approve the plan.')}
            </span>
            <div>
                <button type="button" className="px-3 py-1.5 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50" disabled={busy} onClick={onPropose}>
                    {t('cowork.routine.propose', 'Propose fixed steps')}
                </button>
            </div>
        </div>
    );
}
