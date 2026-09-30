/**
 * registry.generated.ts is what scripts/sync-web-icons.mjs writes today.
 *
 * The file is generated from the web's iconRegistry.js and the script's
 * MOBILE_ICONS; hand edits, or a web registry that grew, make it stale. The
 * script's --check mode regenerates in memory and compares.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const MOBILE = path.resolve(__dirname, '../../../..');

describe('registry.generated.ts', () => {
    it('is up to date with scripts/sync-web-icons.mjs', () => {
        expect(() =>
            execFileSync(process.execPath, [path.join(MOBILE, 'scripts/sync-web-icons.mjs'), '--check'], {
                cwd: MOBILE,
                stdio: 'pipe',
            }),
        ).not.toThrow();
    });
});
