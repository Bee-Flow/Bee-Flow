import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavigateToPage } from './useNavigateToPage';

vi.mock('../utils/unsavedNavigation', () => ({ mayNavigate: () => true }));

function navigation() {
    const setters = Object.fromEntries([
        'setCurrentPage', 'setAdminPath', 'setOrgSettingsPath', 'setInitialCoworkId',
        'setInitialDocumentId', 'setShowProfileMenu', 'setShowAgentDesigner',
        'setShowAgentWizard', 'setShowStudio', 'setStudioRoute',
        'setInitialDesignerAgentId', 'setFormViewToken', 'setAppRunId',
        'setShowSettings', 'setShowSkillsPanel', 'setShowProjects',
    ].map(name => [name, vi.fn()]));
    const { result } = renderHook(() => useNavigateToPage({ isMobileRef: { current: false }, user: { permissions: ['page_chat'] }, ...setters }));
    return { setters, navigate: (page, options) => act(() => result.current(page, options)) };
}

beforeEach(() => window.history.replaceState({}, '', '/app/studio/documents'));

describe('document navigation in the member workspace', () => {
    it('leaves Studio and other panels when opening the member library', () => {
        const { navigate, setters } = navigation();
        navigate('documents');
        expect(window.location.pathname).toBe('/app/documents');
        expect(setters.setCurrentPage).toHaveBeenCalledWith('documents');
        expect(setters.setInitialDocumentId).toHaveBeenCalledWith(null);
        for (const name of ['setShowStudio', 'setShowAgentDesigner', 'setShowAgentWizard', 'setShowSettings', 'setShowSkillsPanel', 'setShowProjects']) {
            expect(setters[name]).toHaveBeenCalledWith(false);
        }
    });

    it('updates the selected item on the same page and returns to its library', () => {
        const { navigate, setters } = navigation();
        navigate('documents/d1');
        expect(window.location.pathname).toBe('/app/documents/d1');
        navigate('documents/notebook/n1');
        expect(window.location.pathname).toBe('/app/documents/notebook/n1');
        expect(setters.setInitialDocumentId).toHaveBeenLastCalledWith('notebook/n1');
        navigate('documents');
        expect(window.location.pathname).toBe('/app/documents');
        expect(setters.setInitialDocumentId).toHaveBeenLastCalledWith(null);
    });

    it('honours replacement navigation without adding history entries', () => {
        const { navigate } = navigation();
        const push = vi.spyOn(window.history, 'pushState');
        const replace = vi.spyOn(window.history, 'replaceState');
        navigate('documents/d1', { replace: true });
        expect(push).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({ page: 'documents' }, '', '/app/documents/d1');
        push.mockRestore();
        replace.mockRestore();
    });
});
