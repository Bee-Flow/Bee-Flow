import { describe, it, expect } from 'vitest';
import { monacoVsUrl } from './monaco';

/** The editor runtime comes from this app, at <base>monaco/vs: never the CDN. */
describe('monacoVsUrl', () => {
    it('is the app\'s own origin at the root', () => {
        expect(monacoVsUrl('/', 'https://beeflow.example')).toBe('https://beeflow.example/monaco/vs');
    });

    it('follows a sub-path base (the Nextcloud embed build)', () => {
        expect(monacoVsUrl('/index.php/apps/app_api/proxy/beeflow/', 'https://cloud.example'))
            .toBe('https://cloud.example/index.php/apps/app_api/proxy/beeflow/monaco/vs');
    });

    it('tolerates a base without a trailing slash', () => {
        expect(monacoVsUrl('/app', 'https://x.example')).toBe('https://x.example/app/monaco/vs');
    });

    it('never points at a CDN', () => {
        expect(monacoVsUrl()).not.toMatch(/jsdelivr|cdn/);
    });
});
