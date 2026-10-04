import { describe, expect, it, vi } from 'vitest';
import { mayNavigate, registerNavigationGuard } from './unsavedNavigation';
describe('unsaved navigation', () => {
    it('blocks navigation until the active form allows it and unregisters on unmount', () => {
        const guard = vi.fn(() => false);
        const dispose = registerNavigationGuard(guard);
        expect(mayNavigate()).toBe(false);
        guard.mockReturnValue(true);
        expect(mayNavigate()).toBe(true);
        dispose();
        expect(mayNavigate()).toBe(true);
    });
    it('cleanup of an old form cannot remove a newer guard', () => {
        const old = registerNavigationGuard(() => true);
        const current = registerNavigationGuard(() => false);
        old(); expect(mayNavigate()).toBe(false);
        current(); expect(mayNavigate()).toBe(true);
    });
});
