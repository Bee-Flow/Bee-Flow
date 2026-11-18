/**
 * The executor of the `sanctions_screen` step (componentSpecs/steps/sanctions_screen.js).
 *
 *   1. Access, for the app's OWNER and organisation: the licence feature `sanctions_screening`
 *      and the `sanctions-lists` integration switched on (core/sanctions/service.mts access).
 *      A viewer pressing the button screens under the owner's licence, like every other
 *      server step; the step reveals nothing about the owner beyond the public list data.
 *   2. The bindings (`name`, `birthDate`, `country`, `function`) resolved by the server walk.
 *   3. The screening itself (core/sanctions/service.mts screen), on this server against the
 *      stored public lists. The result is the step's result (the walker puts it in
 *      vars.<resultVar>). No side effect, so a dry run runs it for real.
 *
 * Never throws: every failure is `{ ok: false, error, code, retryable }`.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type App = { id: string; userId: string; organizationId?: string | null };
type StepFailure = { ok: false; error: string; code: string; retryable: boolean };
type StepSuccess = { ok: true; result: unknown };
type Service = typeof import('../../../core/sanctions/service.mts');

export type SanctionsStepDeps = {
    service: () => Pick<Service, 'access' | 'screen'>;
    integrationOn: (userId: string) => Promise<boolean>;
    resolve: (binding: unknown, ctx: Obj) => unknown;
};

function defaultDeps(): SanctionsStepDeps {
    return {
        service: () => nodeRequire('../../../core/sanctions/service.mts') as Service,
        integrationOn: (userId) => (nodeRequire('../../../core/integrations/integrationTools.js') as {
            isIntegrationPermittedForUser: (o: { userId: string; appId: string }) => Promise<boolean>;
        }).isIntegrationPermittedForUser({ userId, appId: 'sanctions-lists' }),
        resolve: (binding, ctx) => {
            const exec = nodeRequire('../shared.js') as { buildServerScope: (c: Obj) => unknown; resolveBinding: (b: unknown, c: Obj, s: unknown) => unknown };
            return exec.resolveBinding(binding, ctx, exec.buildServerScope(ctx));
        },
    };
}

const fail = (error: string, code: string, retryable = false): StepFailure => ({ ok: false, error, code, retryable });

const text = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return undefined;
};

export async function runSanctionsScreen(app: App, step: Obj, ctx: Obj, deps: SanctionsStepDeps = defaultDeps()): Promise<StepSuccess | StepFailure> {
    const svc = deps.service();
    const allowed = await svc.access({ userId: app.userId, orgId: app.organizationId ?? null }, deps.integrationOn);
    if (!allowed.ok) return fail(allowed.error, allowed.code);
    const value = (field: string): string | undefined => (step[field] === undefined ? undefined : text(deps.resolve(step[field], ctx)));
    const name = value('name');
    const fn = value('function');
    if (!name?.trim() && !fn?.trim()) return fail('The sanctions_screen step needs a name to screen or a function to check; both were empty.', 'bad_input');
    try {
        const result = await svc.screen({
            name, birthDate: value('birthDate'), country: value('country'), function: fn,
            lists: Array.isArray(step.lists) ? step.lists : undefined,
            minScore: typeof step.minScore === 'number' ? step.minScore : undefined,
            maxResults: typeof step.maxResults === 'number' ? step.maxResults : undefined,
        });
        return { ok: true, result };
    } catch {
        return fail('The sanctions lists could not be read just now. Try again in a moment.', 'sanctions_unavailable', true);
    }
}

/** The registry's executor entry (dispatch.js fileStepHandler). */
export async function runStep(app: App, _model: unknown, step: Obj, ctx: Obj): Promise<StepSuccess | StepFailure> {
    return runSanctionsScreen(app, step ?? {}, ctx ?? {});
}
