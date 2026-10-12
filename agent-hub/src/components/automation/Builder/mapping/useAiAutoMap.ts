import { useCallback, useEffect, useRef } from 'react';
import { aiAutoMap, aiTargets, fillEmpty } from './aiAutoMap';
import type { AiParam, Binding, GroupLike, Inputs, SuggestMappingsApi } from './aiAutoMap';
import useAutomationApi from '../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';

/**
 * The second half of the Auto-map wand: after the deterministic pass has
 * written what it found, ask the AI for the inputs that are still empty
 * (aiAutoMap.ts), fill the ones that are STILL empty when the answer comes
 * back, and say what happened in one toast — "Auto-mapped 3 inputs (1 with
 * AI)". When the AI is not available the toast simply counts the
 * deterministic result; nothing says the AI failed.
 *
 * Shared by the tool-step editor (integrationActionFields.jsx) and the
 * flowlet/Step call editors (flow/useInputMapping.js), which write their
 * inputs differently — hence `write`.
 */

export interface WandRun {
    /** Every input the step declares; aiTargets picks the ones to ask about. */
    params: AiParam[];
    /** The inputs right after the deterministic pass. */
    inputs: Inputs;
    groups: GroupLike[];
    step?: { label?: string; tool?: string } | null;
    /** Optional inputs the form shows by default (see aiTargets). */
    essential?: ((key: string) => boolean) | null;
    /** How many inputs the deterministic pass filled. */
    deterministicCount: number;
    /**
     * Write the AI's bindings: `fill(current)` returns the inputs with only
     * the still-empty keys filled; `latest` is the editor's newest inputs,
     * for a writer that takes a whole map rather than an updater.
     */
    write: (fill: (current: Inputs) => Inputs, latest: Inputs) => void;
}

export interface WandOutcome { aiKeys: string[]; reasons: Record<string, string> }

/** The one toast after a wand click. */
export function wandToastText(t: TranslateFn, { mapped, ai = 0 }: { mapped: number; ai?: number }): { kind: 'success' | 'info'; text: string } {
    if (!mapped) {
        return { kind: 'info', text: t('automations.builder.automap.nothing', 'Nothing to auto-map: no field from the steps above fits the empty inputs.') };
    }
    const text = mapped === 1
        ? t('automations.builder.automap.mapped_one', 'Auto-mapped 1 input')
        : t('automations.builder.automap.mapped_other', 'Auto-mapped {count} inputs', { count: mapped });
    return { kind: 'success', text: ai ? t('automations.builder.automap.with_ai', '{summary} ({ai} with AI)', { summary: text, ai }) : text };
}

export default function useAiAutoMap({ inputs, api = null }: { inputs: Inputs; api?: SuggestMappingsApi | null }) {
    const hookApi = useAutomationApi() as unknown as SuggestMappingsApi;
    const client = api || hookApi;
    const { t } = useTranslation();
    // The answer arrives after the editor has re-rendered (at least with the
    // deterministic result, maybe with the author's own edits): it is merged
    // into the inputs as they are THEN.
    const latest = useRef<Inputs>(inputs);
    useEffect(() => { latest.current = inputs; });
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
    }, []);
    const busy = useRef(false);

    return useCallback(async (run: WandRun): Promise<WandOutcome> => {
        let aiKeys: string[] = [];
        let reasons: Record<string, string> = {};
        // A second click while the first is still waiting has only re-run the
        // deterministic half (which the first already did); the first click's
        // answer and toast follow. One question at a time.
        if (busy.current) return { aiKeys, reasons };
        const targets = aiTargets(run.params, run.inputs, run.essential || null);
        if (targets.length) {
            busy.current = true;
            try {
                const res = await aiAutoMap({ api: client, params: targets, inputs: run.inputs, groups: run.groups, step: run.step });
                if (!alive.current) return { aiKeys: [], reasons: {} };
                aiKeys = fillEmpty(latest.current, res.patch).keys;
                if (aiKeys.length) {
                    const patch: Record<string, Binding> = Object.fromEntries(aiKeys.map(k => [k, res.patch[k]]));
                    run.write((current) => fillEmpty(current, patch).next, latest.current);
                    reasons = Object.fromEntries(aiKeys.filter(k => res.reasons[k]).map(k => [k, res.reasons[k]]));
                }
            } finally {
                busy.current = false;
            }
        }
        if (!alive.current) return { aiKeys, reasons };
        const { kind, text } = wandToastText(t, { mapped: run.deterministicCount + aiKeys.length, ai: aiKeys.length });
        if (kind === 'success') toast.success(text);
        else toast.info(text);
        return { aiKeys, reasons };
    }, [client, t]);
}
