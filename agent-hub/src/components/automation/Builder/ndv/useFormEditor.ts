// What the node drawer hands a form page so it can open the full-screen form
// editor: every form page of the automation, a way to save ANOTHER page than the
// open one, and (on the form trigger) the shell's own "run this form" path.
import { useCallback, useMemo, useRef } from 'react';
import { normalizeDefinitionShape } from '../flow/normalizeDefinition';
import { mergeStepPatchIntoDefinition } from '../flow/switchCaseOps';
import { collectFormPages } from '../flow/settings/formPages';
import type { FormEditorContext } from '../flow/settings/FormPageEditor';
import type { FlowDefinition, FlowStep } from '../flow/types';

type Form = Record<string, unknown>;

const merge = mergeStepPatchIntoDefinition as (def: unknown, step: unknown, patch: unknown) => FlowDefinition;
const normalize = normalizeDefinitionShape as (def: unknown) => FlowDefinition | null;

export default function useFormEditor({ definition, step, onSaveStep, onTest }: {
    definition: FlowDefinition | null;
    step: FlowStep | null;
    onSaveStep: ((next: unknown) => Promise<unknown> | unknown) | null;
    /** Opens the trigger's form over the canvas (the Execute path); null when a run cannot start. */
    onTest: (() => void) | null;
}): FormEditorContext | null {
    const pages = useMemo(() => collectFormPages(definition), [definition]);
    // Forms being saved right now. Two pages edited inside one round trip must
    // both land: the second save is built on a definition that does not carry the
    // first yet, so every in-flight form is applied again on top of it.
    const inFlight = useRef(new Map<string, Form>());
    const latest = useRef({ definition, onSaveStep });
    latest.current = { definition, onSaveStep };

    const savePage = useCallback((id: string, form: Form) => {
        const { definition: def, onSaveStep: save } = latest.current;
        if (!def || typeof save !== 'function') return undefined;
        inFlight.current.set(id, form);
        let next: FlowDefinition = normalize(def) || def;
        const all: FlowStep[] = [def.trigger, ...(def.triggers || []), ...(def.steps || [])].filter((s): s is FlowStep => !!s);
        for (const [pid, f] of inFlight.current) {
            const target = all.find(s => s.id === pid);
            if (target) next = merge(next, target, { form: f });
        }
        return Promise.resolve(save(next)).finally(() => {
            if (inFlight.current.get(id) === form) inFlight.current.delete(id);
        });
    }, []);

    return useMemo(() => {
        if (!step || pages.length === 0) return null;
        if (!pages.some(p => p.id === step.id)) return null;
        return { pages, savePage, onTestForm: step.type === 'trigger' ? onTest : null };
    }, [pages, savePage, step, onTest]);
}
