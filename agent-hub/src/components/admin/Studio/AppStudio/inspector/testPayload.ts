import type { FormFieldRef, InputMapping, ParamMetaByName } from './appDefinition';
/**
 * What a test run RECEIVES, and what demonstrably is not in it.
 *
 * The test button next to a `run_automation` action ran the automation with only the
 * STATIC values from the input mapping. Anything hooked to a form field
 * — usually the real input — came through as `undefined`, fell out of the JSON, and the
 * automation began with an empty `trigger.output`. The run then looked exactly
 * like a broken step.
 *
 * This function builds the same payload from the CURRENT screen values, and separately
 * returns what is NOT in it and why. That second part is no extra: whoever
 * tests with half the input and doesn't know that draws the wrong
 * conclusion about the automation.
 *
 * ── File fields never travel along ─────────────────────────────────────────
 *
 * Four independent reasons, each on its own already enough:
 *
 *   1. The browser does not have the bytes. A file field only holds a
 *      descriptor: `{ kind:'studio_attachment', fileId, name, mime, size }`
 *      (runtime/components/AppInputFile.jsx).
 *   2. Only the app bridge can unpack that descriptor (`expandFileInput` in
 *      server/appStudio/actionExecutor/automationBridge.js), and that sits behind
 *      `POST /api/studio-apps/:id/actions/:actionId/run` — not behind the
 *      automation route this button points to.
 *   3. That lookup is app- AND owner-scoped, and refuses a file that has not been
 *      scanned or has been quarantined.
 *   4. The download URL is minted per run and expires; a URL copied from a screen
 *      is either dead or a leak.
 *
 * So: skip it, and say so. A step that binds to `trigger.output.<field>.url`
 * would otherwise silently come out empty in the test, which looks like a bug in the step.
 *
 * ── Unknown narrows ────────────────────────────────────────────────────────
 *
 * A field reference for which the screen has no value is NOT invented as
 * `null` or `''`. It is skipped and reported — the same answer with a different face,
 * but the difference is exactly what the tester needs to know.
 *
 * Pure: no React, no fetch. The caller fetches the screen values
 * (editor/ScreenValuesContext) and shows what comes out here.
 */

/** Why a parameter does not travel along. Each with its own sentence in the UI. */
export const SKIP_REASONS = Object.freeze({
    FILE: 'file',           // bestandsveld — kan per definitie niet mee
    NO_SCREEN: 'no_screen', // the form is not (or no longer) on screen
    NO_VALUE: 'no_value',   // the form is there, this field has no value
    UNMAPPED: 'unmapped',   // de mapping is leeg of van een onbekende soort
    NO_MAPPING: 'no_mapping', // de automatisering vraagt de parameter, er is geen regel voor
});

/** Componenttypes die een bestand opleveren in plaats van een waarde. */
const FILE_FIELD_TYPES: (string | undefined)[] = ['input_file'];

/**
 * @param {object}      args
 * @param {object}      args.inputMapping  `{ [param]: {kind:'static',value} | {kind:'field',name} }`
 * @param {Array}       args.formFields    `[{ name, type, multiple }]` of the enclosing form
 * @param {object|null} args.formValues    the LIVE values of that form, or
 *                                         null if it is not on screen
 * @param {object|null} args.paramMeta     `{ [param]: { type, required } }` from the
 *                                         automation's contract, if there is one
 * @returns {{payload: object, skipped: Array<{param: string, field: string|null, reason: string}>}}
 */
interface BuildTestPayloadArgs {
    inputMapping?: Record<string, InputMapping> | null | undefined;
    formFields?: FormFieldRef[];
    formValues?: Record<string, string | undefined> | null;
    paramMeta?: ParamMetaByName | null | undefined;
}

export function buildTestPayload({
    inputMapping = null, formFields = [], formValues = null, paramMeta = null,
}: BuildTestPayloadArgs = {}) {
    const payload: Record<string, string | undefined> = {};
    const skipped: { param: string; field: string|null; reason: string; }[] = [];
    const fieldByName = new Map((formFields || []).filter((f) => f && f.name).map((f) => [f.name, f]));
    const skip = (param: string, field: string | null | undefined, reason: string) => skipped.push({ param, field: field || null, reason });

    // THE UNION, NOT THE MAPPING ALONE.
    //
    // A parameter that the automation DOES declare but that has no mapping rule
    // (the automation got one later, or someone removed the rule) appeared in neither list:
    // it did not travel along AND was not reported. The UI does show it — ContractDrift says “The automation also
    // expects: + invoiceFile *” — but the test run acted as if it did not exist,
    // and that is exactly the half-filled run this module was written against.
    // Declared order first, then what the mapping additionally names (a rule for a
    // parameter the automation no longer knows).
    const mapping0 = inputMapping || {};
    const declared = paramMeta && typeof paramMeta === 'object' ? Object.keys(paramMeta) : [];
    const names = [...new Set([...declared, ...Object.keys(mapping0)])];

    for (const param of names) {
        const mapping = mapping0[param];
        // Declared, but nothing says where the value comes from. Invent nothing:
        // skip and report. A `file` parameter does not fall under this —
        // it already gets the FILE reason above, which is more specific.
        if (mapping === undefined && !Object.prototype.hasOwnProperty.call(mapping0, param)
            && paramMeta?.[param]?.type !== 'file') {
            skip(param, null, SKIP_REASONS.NO_MAPPING);
            continue;
        }
        // The CONTRACT wins over the mapping: a parameter that the automation declares as
        // `file` does not travel along, not even if an empty static string happens to
        // hang on it (the placeholder the picker writes when there is no file field
        // to point to).
        if (paramMeta?.[param]?.type === 'file') {
            skip(param, mapping?.kind === 'field' ? mapping.name : null, SKIP_REASONS.FILE);
            continue;
        }
        if (mapping?.kind === 'static') {
            payload[param] = mapping.value;
            continue;
        }
        if (mapping?.kind === 'field') {
            const field = fieldByName.get(mapping.name as string) || null;
            // Also without a declared contract: a file input is a
            // file input.
            if (field && FILE_FIELD_TYPES.includes(field.type)) {
                skip(param, mapping.name, SKIP_REASONS.FILE);
                continue;
            }
            if (!formValues || typeof formValues !== 'object') {
                skip(param, mapping.name, SKIP_REASONS.NO_SCREEN);
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(formValues, mapping.name as string)) {
                skip(param, mapping.name, SKIP_REASONS.NO_VALUE);
                continue;
            }
            payload[param] = formValues[mapping.name as string];
            continue;
        }
        // Een lege of onbekende mapping. Niets verzinnen.
        skip(param, null, SKIP_REASONS.UNMAPPED);
    }

    return { payload, skipped };
}

/**
 * Which parameters NEVER travel along STRUCTURALLY — purely from the mapping and
 * the contract, without the screen values.
 *
 * This is what can sit under the button before anyone presses it. The rest
 * (is the form on screen, does this field have a value) depends on the moment and
 * belongs in the outcome.
 */
const STRUCTURAL_REASONS = new Set<string>([SKIP_REASONS.FILE, SKIP_REASONS.NO_MAPPING]);

interface AlwaysSkippedArgs {
    inputMapping?: Record<string, InputMapping> | null | undefined;
    formFields?: FormFieldRef[];
    paramMeta?: ParamMetaByName | null | undefined;
}

export function alwaysSkipped({ inputMapping = null, formFields = [], paramMeta = null }: AlwaysSkippedArgs = {}) {
    return buildTestPayload({ inputMapping, formFields, paramMeta, formValues: {} })
        .skipped
        // FILE and NO_MAPPING both depend only on the mapping and the
        // contract, so they are known before anyone presses Test.
        // NO_SCREEN and NO_VALUE depend on the moment and belong in the
        // outcome.
        .filter((s) => STRUCTURAL_REASONS.has(s.reason));
}
