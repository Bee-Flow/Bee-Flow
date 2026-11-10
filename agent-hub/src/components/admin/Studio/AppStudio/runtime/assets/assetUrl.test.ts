import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/utils/helpers';
import { assetIdOf, assetNeedsFetch, assetUrl, isAssetRef, isImageValue } from './assetUrl';

describe('assetUrl', () => {
    it('reads asset:<id> by the server rule, character by character', () => {
        expect(isAssetRef('asset:3f1c-a_9')).toBe(true);
        expect(isAssetRef('asset:')).toBe(false);
        expect(isAssetRef('asset:a.b')).toBe(false);
        expect(isAssetRef(`asset:${'a'.repeat(65)}`)).toBe(false);
        expect(isAssetRef('https://example.com/x.png')).toBe(false);
        expect(assetIdOf('asset:abc')).toBe('abc');
        expect(isImageValue('https://example.com/x.png')).toBe(true);
        expect(isImageValue('http://example.com/x.png')).toBe(false);
    });

    it('addresses the signed-in app by id and a public page by its token', () => {
        expect(assetUrl('asset:abc', { appId: 'app 1' })).toBe(`${API_BASE}/api/studio-apps/app%201/assets/abc`);
        expect(assetUrl('asset:abc', { appId: 'app1', publicToken: 'f00d' })).toBe(`${API_BASE}/api/public-app/f00d/assets/abc`);
        expect(assetUrl('asset:abc', {})).toBeNull();
        expect(assetUrl('https://example.com/x.png', { appId: 'app1' })).toBeNull();
    });

    it('links directly outside a demo and outside a header-session embedding', () => {
        expect(assetNeedsFetch({ appId: 'app1' })).toBe(false);
        expect(assetNeedsFetch({ publicToken: 'f00d' })).toBe(false);
    });
});
