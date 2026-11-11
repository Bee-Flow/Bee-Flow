/**
 * The browser side of the client step kinds of the step registry
 * (server/appStudio/componentSpecs/steps/<kind>.js with side 'client'): one file
 * per kind under `browserSteps/<kind>.ts`, default-exporting `{ kind, run }`.
 * ./clientSteps.ts asks here for a kind it has no handler of its own for, so a
 * new client kind is a file, not another entry in that table.
 *
 * browserSteps.lockstep.test.ts holds the files to the server's client kinds: a
 * client kind without a runner would be a step that silently does nothing.
 */
import type { RunStep } from './core';
import type { ClientStepEnv } from './clientSteps';
import type { SeqState } from './serverSteps';

/** What one browserSteps/<kind>.ts exports as default. */
export interface BrowserStepModule {
    kind: string;
    run: (env: ClientStepEnv, step: RunStep, st: SeqState) => void | Promise<void>;
}

/** kind → module, from what `import.meta.glob` hands over (path → module). A file must name its own kind. */
export function buildBrowserSteps(modules: Record<string, { default: BrowserStepModule }>): Record<string, BrowserStepModule> {
    const out: Record<string, BrowserStepModule> = {};
    for (const file of Object.keys(modules).sort()) {
        const entry = modules[file].default;
        const name = file.slice(file.lastIndexOf('/') + 1, file.lastIndexOf('.'));
        if (!entry || entry.kind !== name || typeof entry.run !== 'function') throw new Error(`Browser step file ${file} must export { kind, run } for its own kind as default`);
        out[name] = entry;
    }
    return out;
}

// No type argument on the call, on purpose: vitest keeps a transformed module on disk
// between runs unless its text holds the call exactly as `import.meta.glob(`, and a
// kept copy would not see a file added to the folder.
export const BROWSER_STEPS = buildBrowserSteps(import.meta.glob(['./browserSteps/*.ts', '!./browserSteps/*.test.ts'], { eager: true }) as Record<string, { default: BrowserStepModule }>);

/** The runner of a registry client kind, or null. */
export function browserStepFor(kind: unknown): BrowserStepModule['run'] | null {
    return typeof kind === 'string' && Object.hasOwn(BROWSER_STEPS, kind) ? BROWSER_STEPS[kind].run : null;
}
