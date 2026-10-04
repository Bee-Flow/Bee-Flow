// Pin / Duplicate / Disable / Delete for the step drawer: what each does and
// when it is offered. The header's ⋯ menu and the quick strip's Pin button
// both read from here.
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { isTruncatedOutput } from '../mapping/realOutputs';
import type { FlowStep } from '../flow/types';
import type { NdvStepMenuProps } from './NdvStepMenu';

const isTruncated = isTruncatedOutput as (v: unknown) => boolean;

export default function stepPlumbing({
    step, runStep, quick, isTrigger, outputPinned, persistStepPatch, onDuplicateStep, onDeleteStep, onClose, t,
}: {
    step: FlowStep;
    runStep: { output?: unknown } | null | undefined;
    quick: boolean;
    isTrigger: boolean;
    outputPinned: boolean;
    persistStepPatch: (patch: Record<string, unknown>) => Promise<void>;
    onDuplicateStep: ((id: string) => void) | null;
    onDeleteStep: ((id: string) => void) | null;
    onClose: (() => void) | null | undefined;
    t: TranslateFn;
}) {
    // A truncated output is a server sentinel, not data: pinning it would freeze a placeholder.
    const canPin = !!runStep?.output && !isTruncated(runStep.output);
    // `pinnedSource: undefined`, not null: the key drops out of the JSON, so
    // "absent" keeps meaning "captured from a run".
    const togglePin = async () => {
        if (outputPinned) await persistStepPatch({ pinnedOutput: null, pinnedAt: null, pinnedSource: undefined });
        else if (canPin) await persistStepPatch({ pinnedOutput: runStep?.output, pinnedAt: new Date().toISOString(), pinnedSource: undefined });
    };
    const pinTitle = outputPinned
        ? t('automations.ndv.unpin_title', 'Unpin output (re-enable live execution)')
        : t('automations.ndv.pin_title', 'Pin this output (skip live execution; reuse the latest output)');
    // Never on a trigger: the runner never enters dispatchStep for it (so
    // Disable would be a lie) and it never gets a run row (so Pin could only
    // ever be disabled). The quick dialog leaves the plumbing out too.
    const menu: NdvStepMenuProps | null = (!quick && !isTrigger) ? {
        pinned: outputPinned,
        canPin,
        pinTitle,
        onTogglePin: () => { void togglePin(); },
        disabled: !!step.disabled,
        onToggleDisabled: () => { void persistStepPatch({ disabled: !step.disabled }); },
        onDuplicate: typeof onDuplicateStep === 'function' ? () => { onDuplicateStep(step.id); onClose?.(); } : null,
        onDelete: typeof onDeleteStep === 'function' ? () => { onDeleteStep(step.id); onClose?.(); } : null,
    } : null;
    return { canPin, togglePin, pinTitle, menu };
}
