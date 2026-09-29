/**
 * The beacon is opt-in, and an operator can decide without a rebuild.
 *
 * WHAT WENT WRONG BEFORE
 * The switch lived entirely in `import.meta.env`, evaluated at `vite build`,
 * and defaulted to ON. Two consequences, both bad for an image that other
 * people run on their own hardware:
 *
 *   * a self-hosted operator could not turn the beacon off at all without
 *     building their own frontend image;
 *   * doing nothing got you telemetry, while silence had to be requested.
 *
 * On a product whose pitch is that data stays where you put it, and whose own
 * documentation said "does not phone home", that combination is a broken
 * promise rather than a preference.
 *
 * WHAT THESE TESTS PIN
 * `shouldStart()` is not exported and the module has heavy side-effect imports,
 * so these assert on the SOURCE. That is weaker than executing the gate and it
 * is deliberate: the alternative is a test that mocks the whole module graph
 * and then proves that the mock behaves, which is how a dead pin is born. Each
 * assertion below names a property of the decision that must survive a rewrite,
 * and the one that matters most — the default — is checked as an exact literal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const SOURCE = read('agent-hub/src/telemetry/openobserve.js');

describe('telemetry is opt-in', () => {
    it('defaults to OFF when nothing says otherwise', () => {
        // The exact literal, not a loose match. `?? 'true'` was the whole bug:
        // an absent value read as consent.
        expect(SOURCE).toMatch(/VITE_OPENOBSERVE_ENABLE\s*\?\?\s*'false'/);
        expect(SOURCE).not.toMatch(/VITE_OPENOBSERVE_ENABLE\s*\?\?\s*'true'/);
    });

    it('treats the runtime file as authoritative in BOTH directions', () => {
        // An operator who sets the variable must get what they asked for — off
        // when they say off, on when they say on. A gate that only ever ORs the
        // runtime value in could not turn a build-enabled beacon off again.
        expect(SOURCE).toMatch(/RUNTIME\s*\n?\s*\?\s*RUNTIME\.enabled === true/);
    });

    it('requires the exact boolean true, so a truthy accident cannot enable it', () => {
        expect(SOURCE).toMatch(/RUNTIME\.enabled === true/);
    });

    it('reads the runtime file defensively — a missing or locked-down window is "no opinion"', () => {
        expect(SOURCE).toMatch(/typeof window !== 'undefined'/);
        expect(SOURCE).toMatch(/catch\s*\{\s*return null/);
    });
});

describe('the image can be told at container start, without a rebuild', () => {
    const ENTRY = 'agent-hub/docker-entrypoint.d/19-beeflow-runtime-config.sh';

    it('ships an entrypoint script that writes the runtime file', () => {
        const sh = read(ENTRY);
        expect(sh).toMatch(/BEEFLOW_TELEMETRY_ENABLED/);
        expect(sh).toMatch(/window\.__BEEFLOW_RUNTIME__/);
    });

    it('enables only on the exact string "true"', () => {
        const sh = read(ENTRY);
        expect(sh).toMatch(/"\$\{BEEFLOW_TELEMETRY_ENABLED:-\}"\s*=\s*"true"/);
    });

    it('escapes values before they reach the file', () => {
        // A stray quote in a token would break the file, and a broken
        // beeflow-runtime.js takes the SPA's boot with it.
        expect(read(ENTRY)).toMatch(/bf_json_str/);
    });

    it('is copied into the image and made executable', () => {
        const dockerfile = read('agent-hub/Dockerfile');
        expect(dockerfile).toMatch(/19-beeflow-runtime-config\.sh \/docker-entrypoint\.d\//);
        expect(dockerfile).toMatch(/chmod \+x \/docker-entrypoint\.d\/19-beeflow-runtime-config\.sh/);
    });

    it('is loaded by index.html before the app module', () => {
        // Match the TAGS, not any mention of the path: index.html also names
        // /src/main.jsx in a comment near the top, and comparing raw indexOf
        // offsets made this fail on a file whose script order was correct.
        const html = read('agent-hub/index.html');
        const runtimeAt = html.search(/<script\s+src="\/beeflow-runtime\.js"/);
        const mainAt = html.search(/<script\s+type="module"\s+src="\/src\/main\.jsx"/);
        expect(runtimeAt, 'no <script src="/beeflow-runtime.js"> tag').toBeGreaterThan(-1);
        expect(mainAt, 'no <script type="module" src="/src/main.jsx"> tag').toBeGreaterThan(-1);
        expect(runtimeAt, 'the runtime file must load before the app module').toBeLessThan(mainAt);
    });

    it('is never cached, so turning it off takes effect on the next load', () => {
        const conf = read('agent-hub/nginx.conf.template');
        const block = conf.slice(conf.indexOf('location = /beeflow-runtime.js'));
        expect(block.slice(0, 300)).toMatch(/no-store/);
    });
});

// build-push-ghcr.yml's beacon-off build arg is checked by the last step of ci.yml's `changes` job.
