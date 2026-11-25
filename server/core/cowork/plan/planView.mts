/**
 * A plan as a person reads it: its steps (and the order they run in, ./planOrder.mts), each with what kind of work it is (done the same way every run,
 * done by a model, waiting for a person, a result), what it does to the world, and whether it reads outside text.
 * The line "5 fixed, 2 AI, 1 waits for you" is counted here.
 *
 * Derived from the definition alone: the view can never say something the plan does not hold.
 */

import { createRequire } from 'node:module';
import type { Definition, DefStep, Effect, PlanStep, PlanView, StepKind, ToolLookups } from './planTypes.mts';
import { isAnnotation, isHelperStepType, kindOfStepType } from './coworkStepList.mts';
import { runOrderOf } from './planOrder.mts';
import { outsideTextOf } from './outsideText.mts';
import { stepsOf } from './planWalk.mts';

const nodeRequire = createRequire(import.meta.url);
const { stepEffect } = nodeRequire('../../automationModel/stepEffect.js') as { stepEffect: (step: DefStep) => Effect };

/** Words for a name: `fireflies_list_transcripts` reads "Fireflies list transcripts". */
function humanised(name: string): string {
    const words = name.replaceAll('_', ' ').trim();
    return words ? words[0]?.toUpperCase() + words.slice(1) : 'Step';
}

/**
 * What a step is called: its own label, unless that is only its tool's name or its id (the builder writes the tool name
 * when the model gave none); else the tool's label from the lookups, else its tool or its type in plain words.
 */
function titleOf(step: DefStep, type: string, lookups: ToolLookups): string {
    const tool = typeof step.tool === 'string' && step.tool ? step.tool : null;
    const label = typeof step.label === 'string' ? step.label.trim() : '';
    if (label && label !== tool && label !== step.id) return label;
    if (!tool) return humanised(type);
    return lookups.labelOfTool?.(tool)?.trim() || humanised(tool);
}

const emptyMakeUp = (): Record<StepKind, number> => ({ fixed: 0, ai: 0, ask: 0, deliver: 0 });

/**
 * The view of a definition. A step type a plan may not hold is still shown (as a fixed step), so a person sees what
 * ./planChecks.mts refused rather than a plan with a hole in it.
 */
export function planViewOf(definition: Definition | null | undefined, lookups: ToolLookups): PlanView {
    const outside = outsideTextOf(definition, lookups);
    const makeUp = emptyMakeUp();
    const steps: PlanStep[] = [];
    for (const s of stepsOf(definition)) {
        if (isAnnotation(s.type)) continue;
        const kind = kindOfStepType(s.type) ?? 'fixed';
        const tool = typeof s.step.tool === 'string' && s.step.tool ? s.step.tool : null;
        makeUp[kind] += 1;
        steps.push({
            id: s.id,
            type: s.type,
            kind,
            title: titleOf(s.step, s.type, lookups),
            // A plan's script runs with no network, no apps and no secrets (./planRunCopy.mts): it changes and sends nothing.
            effect: s.type === 'code' ? 'reads' : stepEffect(s.step),
            app: tool ? lookups.appOfTool(tool) : null,
            tool,
            readsOutsideText: kind === 'ai' && outside.reads.has(s.id),
            depth: s.depth,
            helper: isHelperStepType(s.type),
        });
    }
    const kind = definition?.trigger?.kind;
    const shown = new Set(steps.map((s) => s.id));
    const runOrder = runOrderOf(definition).filter((id) => shown.has(id));
    return { trigger: typeof kind === 'string' && kind ? kind : null, steps, runOrder, makeUp };
}
