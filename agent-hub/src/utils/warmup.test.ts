// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { shouldWarmAuthedApp } from './warmup';

// The warm-up predicate decides whether the entry chunk pre-fetches the
// AuthedApp bundle. Embedded-in-Nextcloud paths MUST warm: missing one of
// them adds a serial 4-hop round trip to every embedded page load — and
// which form appears depends on the customer's rewrite config, which is
// exactly how "Bee Flow is sometimes slow inside Nextcloud" happened.
describe('shouldWarmAuthedApp', () => {
    it('warms the standalone product paths', () => {
        expect(shouldWarmAuthedApp('/app')).toBe(true);
        expect(shouldWarmAuthedApp('/app/admin/modules')).toBe(true);
    });

    it('warms every embedded Nextcloud form', () => {
        expect(shouldWarmAuthedApp('/index.php/apps/app_api/proxy/bee_flow/')).toBe(true); // index.php URLs
        expect(shouldWarmAuthedApp('/apps/app_api/proxy/bee_flow/')).toBe(true);           // pretty URLs
        expect(shouldWarmAuthedApp('/exapps/bee_flow/')).toBe(true);                       // HaRP direct path
    });

    it('skips marketing and anonymous surfaces', () => {
        expect(shouldWarmAuthedApp('/')).toBe(false);
        expect(shouldWarmAuthedApp('/pricing')).toBe(false);
        expect(shouldWarmAuthedApp('/p/some-public-app-token')).toBe(false);
        expect(shouldWarmAuthedApp('/index.php/apps/files/')).toBe(false); // other NC apps are not us
    });

    it('tolerates junk input', () => {
        expect(shouldWarmAuthedApp(undefined)).toBe(false);
        expect(shouldWarmAuthedApp(null)).toBe(false);
        expect(shouldWarmAuthedApp(42)).toBe(false);
    });
});
