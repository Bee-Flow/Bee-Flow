/**
 * Test-only: load an agent-hub App Studio module under Jest, so a port can be
 * run against its original on the same fixtures (the differential lockstep
 * tests next to each port).
 *
 * agent-hub has no node_modules of its own in the mobile job; the Babel
 * helpers the web's ESM compiles into resolve through jest.config.js
 * (moduleNameMapper and modulePaths), as for the flow editor's differential
 * tests. The web's `@shared/expr/engine.mjs` alias goes to the vendored engine
 * (byte-identical, exprVendor.lockstep.test.ts), and
 * `lucide-react` becomes a proxy that turns each icon import into its NAME, so
 * a catalog's icons compare as strings.
 *
 * Never imported by app code.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
import path from 'node:path';

const MOBILE = path.resolve(__dirname, '../../../../..');
export const REPO = path.resolve(MOBILE, '..');
export const WEB_APP_STUDIO = path.join(REPO, 'agent-hub/src/components/admin/Studio/AppStudio');

let registered = false;

function register(): void {
    if (registered) return;
    registered = true;
    jest.mock('@shared/expr/engine.mjs', () => jest.requireActual('../../../../shared/expr/vendor/index.mjs'), {
        virtual: true,
    });
    // RuntimeContext.jsx imports React for its provider; buildScope itself is pure.
    jest.mock('react', () => jest.requireActual('react'), { virtual: true });
    jest.mock('react/jsx-runtime', () => jest.requireActual('react/jsx-runtime'), { virtual: true });
    jest.mock(
        'lucide-react',
        () => new Proxy({}, { get: (_t, key) => (key === '__esModule' ? true : { iconName: String(key) }) }),
        { virtual: true },
    );
}

/** require() an App Studio web module by its path under AppStudio/. */
export function loadWeb<T = Record<string, unknown>>(rel: string): T {
    register();
    return require(path.join(WEB_APP_STUDIO, rel)) as T;
}

/** The text of a repository file, for textual lockstep checks. */
export function readRepo(rel: string): string {
    return (require('node:fs') as typeof import('node:fs')).readFileSync(path.join(REPO, rel), 'utf8');
}
