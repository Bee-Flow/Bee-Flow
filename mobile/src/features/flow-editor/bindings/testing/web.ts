/**
 * Test-only: load the agent-hub ORIGINAL of a ported module, for the
 * differential lockstep tests (ARCHITECTURE.md, "Sharing logic with the web
 * app"). jest.config.js lets these files through Babel and resolves their
 * `@babel/runtime` helpers and `@shared/*` alias; nothing in the app imports
 * this file.
 */

import { webPath as webTreeFile } from '@/shared/testing/webModule';

/** The web builder's folder, where most originals live. */
export const BUILDER = 'components/automation/Builder';

/** A web module's exports, called with whatever the test hands them. */
export type WebModule = Record<string, (...args: unknown[]) => unknown>;

/** A web file by its path under src/, in whichever root holds it (agent-hub/ or modules/<id>/frontend/). */
export function webPath(rel: string): string {
    return webTreeFile(rel);
}

export function requireWeb(rel: string): WebModule {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(webPath(rel)) as WebModule;
}

/** A web module's non-function export (a table, a Set, a regex). */
export function webValue<T>(mod: WebModule, name: string): T {
    return mod[name] as unknown as T;
}
