import { Code2 } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `code` step (server/appStudio/componentSpecs/steps/code.js): a small
 * JavaScript function the server runs over the step's inputs, its return value in vars.<resultVar>.
 * A fresh step holds a main() that hands its inputs back, so it is valid and runs the moment it lands.
 */
const STARTER = 'function main(inputs, ctx) {\n  // inputs.<name> holds each input below, already read.\n  return inputs;\n}\n';

const entry: StepKindModule = {
    kind: 'code',
    meta: {
        label: 'Run code',
        labelKey: 'studio_apps_step_code.catalog.label',
        group: 'Data',
        icon: Code2,
        blurb: 'Work out a value with a few lines of JavaScript over the inputs you pass in. No network, no database.',
        blurbKey: 'studio_apps_step_code.catalog.blurb',
        server: true,
    },
    newStep: () => ({ kind: 'code', code: STARTER, inputs: {}, resultVar: 'result' }),
};

export default entry;
