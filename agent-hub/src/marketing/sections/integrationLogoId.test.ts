import { describe, expect, it } from 'vitest';
import { resolveIntegrationLogoId } from './integrationLogoId';

describe('resolveIntegrationLogoId', () => {
    it('keeps an explicit logoId', () => {
        expect(resolveIntegrationLogoId({ logoId: 'maps', label: 'Anything' })).toBe('maps');
    });

    it('finds the mark from the label when logoId is empty', () => {
        expect(resolveIntegrationLogoId({ label: 'Outlook (read-only)' })).toBe('outlook_readonly');
        expect(resolveIntegrationLogoId({ label: 'Web search' })).toBe('web_search');
    });

    it('falls back to the icon name, then to nothing', () => {
        expect(resolveIntegrationLogoId({ label: 'Zzz', icon: 'fireflies' })).toBe('fireflies');
        expect(resolveIntegrationLogoId({ label: 'Zzz', icon: 'Star' })).toBeUndefined();
    });
});
