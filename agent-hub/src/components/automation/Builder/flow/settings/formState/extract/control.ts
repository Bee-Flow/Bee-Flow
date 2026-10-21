/**
 * extractFormState for the steps that shape the run itself: loops, flowlets
 * and blocks, waits, stops, the return to an app and hosted form pages.
 */
import type { TypeExtractor } from '../types';

export const controlExtractors: Record<string, TypeExtractor> = {
    loop: (step, base) => ({
        ...base,
        overRef: step.overRef || '',
        // Display truth == persisted truth (C9): the inspector always SHOWED
        // "item" while an absent itemVar persisted '' — activation stayed
        // blocked by loop.itemVar_missing on a value the user could see.
        itemVar: step.itemVar || 'item',
        maxIterations: step.maxIterations ?? 100,
        batchSize: step.batchSize ?? 1,
        body: Array.isArray(step.body) ? step.body : [],
    }),
    // Flowlets (inline — contract derives from rootDefinition, not the step)
    call_layer: (step, base) => ({ ...base, inputs: step.inputs || {} }),
    // Steps (external — contract derives from the catalog, not the step)
    call_block: (step, base) => ({ ...base, inputs: step.inputs || {} }),
    layer_output: (step, base) => ({ ...base, fields: step.fields || {} }),
    wait: (step, base) => ({ ...base, seconds: typeof step.seconds === 'number' ? step.seconds : 5 }),
    stop_error: (step, base) => ({ ...base, message: step.message || '' }),
    // `return_to_app` — the three effect fields plus the fallback choice. They
    // are FLATTENED so every form field has its own key (a nested object in
    // the draft lets one keystroke replace the whole object); the patch
    // writer (buildPatch) rebuilds the nested shape.
    return_to_app: (step, base) => {
        return {
            ...base,
            navigateScreenId: step.navigateTo?.screenId || '',
            navigateRecordRef: step.navigateTo?.recordRef || '',
            toastMessage: step.toast?.message || '',
            toastTone: step.toast?.tone || 'info',
            refresh: step.refresh || '',
            // Missing narrows to 'stay' — the same answer the runner gives
            // when the field is empty.
            onError: step.onError === 'errorScreen' ? 'errorScreen' : 'stay',
        };
    },
    form_page: (step, base) => {
        return {
            ...base,
            mode: step.mode === 'ending' ? 'ending' : 'input',
            // `null` is meaningful inside the declaration (theme: null =
            // inherit the trigger's), so the whole object is passed through
            // rather than defaulted here.
            form: step.form && typeof step.form === 'object' ? step.form : null,
            waitSeconds: typeof step.waitSeconds === 'number' ? step.waitSeconds : 3600,
            // "Only show this page when…": an expression, '' = always shown.
            when: typeof step.when === 'string' ? step.when : '',
        };
    },
};
