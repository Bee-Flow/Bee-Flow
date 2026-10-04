import { Clock } from 'lucide-react';
import type { Pattern } from '../../../../../api/queries/automation/repeating';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { useTranslation } from '../../../../../hooks/useTranslation';
import type { MiniFamily } from '../../../../automation/Builder/flow/canvasClasses';
import MiniFlow from '../../../../automation/Builder/flow/MiniFlow';
import type { MiniNodeProps } from '../../../../automation/Builder/flow/MiniNode';

const MAX_STEPS = 3;
const STEP_FAMILIES: ReadonlySet<string> = new Set(['app', 'ai', 'data', 'branch']);
const asFamily = (f: string): MiniFamily => (STEP_FAMILIES.has(f) ? f as MiniFamily : 'app');

/**
 * The automation a pattern would become, as compact canvas nodes: the trigger,
 * up to three steps, then "+n more". Without a draft the trigger is a dashed
 * "Trigger to choose" placeholder, followed by the apps the pattern touches.
 */
export function previewNodes(p: Pattern, labelFor: (id: string) => string, t: TranslateFn): MiniNodeProps[] {
    const eyebrow = t('automations.ndv.family.trigger', 'Trigger');
    const choose = t('automations.repeating.chooseTrigger', 'Trigger to choose');
    if (!p.draft) {
        return [
            { family: 'trigger', eyebrow, title: choose, dashed: true },
            ...p.apps.slice(0, MAX_STEPS).map((app): MiniNodeProps => ({ family: 'app', appId: app, title: labelFor(app) })),
        ];
    }
    const { trigger, steps } = p.draft;
    const head: MiniNodeProps = {
        family: 'trigger',
        eyebrow,
        title: trigger.label || choose,
        ...(trigger.app ? { appId: trigger.app } : {}),
        ...(trigger.kind === 'schedule' ? { icon: <Clock size={14} aria-hidden="true" /> } : {}),
        dashed: !trigger.label,
    };
    const shown = steps.slice(0, MAX_STEPS).map((s): MiniNodeProps => ({
        family: asFamily(s.family), title: s.label, ...(s.app ? { appId: s.app } : {}),
    }));
    const more = steps.length - shown.length;
    if (more > 0) shown.push({ family: 'data', dashed: true, title: t('automations.repeating.previewMore', '+{count} more', { count: more }) });
    return [head, ...shown];
}

export default function PatternStepPreview({ pattern, labelFor }: { pattern: Pattern; labelFor: (id: string) => string }) {
    const { t } = useTranslation();
    return <MiniFlow compact nodes={previewNodes(pattern, labelFor, t)} testId="pattern-step-preview" />;
}
