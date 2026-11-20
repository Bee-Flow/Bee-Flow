import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDocTypeLabel, useLibraryTypesText, useVisibilityLabel } from './labels';

describe('useDocTypeLabel', () => {
    it('names a blank designed document a customer document, and uses Quote and Security statement', () => {
        const { result } = renderHook(() => useDocTypeLabel());
        expect(result.current('document')).toBe('Customer document');
        expect(result.current('quote')).toBe('Quote');
        expect(result.current('security')).toBe('Security statement');
        expect(result.current('page')).toBe('Page');
    });
});

describe('useVisibilityLabel', () => {
    it('says Shared for a document shared with some people, Organisation for one shared with everyone', () => {
        const { result } = renderHook(() => useVisibilityLabel());
        expect(result.current({ visibility: 'team', audience: 'restricted' })).toBe('Shared');
        expect(result.current({ visibility: 'team', audience: 'organisation' })).toBe('Organisation');
        // The library row says only "team" today: shared, with whom it does not tell.
        expect(result.current({ visibility: 'team' })).toBe('Shared');
        expect(result.current({ visibility: 'private' })).toBeNull();
        expect(result.current({})).toBeNull();
    });
});

describe('useLibraryTypesText', () => {
    it('names only what this reader can make', () => {
        const { result } = renderHook(() => useLibraryTypesText());
        expect(result.current({ notebooks: false, spreadsheets: false })).toBe('Make pages, customer documents and presentations here, on your own or together.');
        expect(result.current({ notebooks: true, spreadsheets: false })).toBe('Make pages, notebooks, customer documents and presentations here, on your own or together.');
        expect(result.current({ notebooks: true, spreadsheets: true })).toBe('Make pages, notebooks, spreadsheets, customer documents and presentations here, on your own or together.');
        expect(result.current({ notebooks: false, spreadsheets: true })).toBe('Make pages, spreadsheets, customer documents and presentations here, on your own or together.');
    });
});
