import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildPayload, normaliseDoc } from './orgShieldDoc';
import useShieldFields from './useShieldFields';

/**
 * The per-app exceptions in the form: loaded, edited and saved with their
 * tool class, never lost when the class's list changes.
 */

const BUILT_IN = new Set(['Person', 'Email', 'InternationalBankingAccountNumber']);
const DOC = {
    toolPiiPolicy: {
        external: { blockCategories: ['Person', 'Email'], appExemptions: { outlook: ['Person', 'Email'], junk: 'Person' } },
        internal: { blockCategories: [] },
    },
};

describe('per-app exceptions in the form', () => {
    it('are read from the document and always stated in the save', () => {
        const f = normaliseDoc(DOC, BUILT_IN);
        expect(f.toolPiiPolicy.external.appExemptions).toEqual({ outlook: ['Person', 'Email'] });
        expect(f.toolPiiPolicy.internal.appExemptions).toEqual({});
        expect(buildPayload(DOC, f).toolPiiPolicy).toEqual({
            external: { blockCategories: ['Person', 'Email'], appExemptions: { outlook: ['Person', 'Email'] } },
            internal: { blockCategories: [], appExemptions: {} },
        });
    });

    it('survive a change of the class list, losing only the kind that is no longer held back', () => {
        const { result } = renderHook(() => useShieldFields());
        act(() => result.current.applyFields(normaliseDoc(DOC, BUILT_IN)));
        act(() => result.current.toggleToolPiiCat('external', 'InternationalBankingAccountNumber', true));
        expect(result.current.values.toolPiiPolicy.external.appExemptions).toEqual({ outlook: ['Person', 'Email'] });
        act(() => result.current.toggleToolPiiCat('external', 'Email', false));
        expect(result.current.values.toolPiiPolicy.external).toEqual({
            blockCategories: ['Person', 'InternationalBankingAccountNumber'],
            appExemptions: { outlook: ['Person'] },
        });
    });

    it('are added, changed and removed per app', () => {
        const { result } = renderHook(() => useShieldFields());
        act(() => result.current.applyFields(normaliseDoc(DOC, BUILT_IN)));
        act(() => result.current.fields.setAppExemption('external', 'gmail', ['Person']));
        act(() => result.current.fields.setAppExemption('external', 'outlook', null));
        expect(result.current.values.toolPiiPolicy.external.appExemptions).toEqual({ gmail: ['Person'] });
    });
});
