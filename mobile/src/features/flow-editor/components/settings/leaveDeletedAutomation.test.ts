import { deletedAutomationDepth, leaveDeletedAutomation } from './leaveDeletedAutomation';

const r = (name: string, id?: string) => ({ name, params: id ? { id } : {} });

describe('leaveDeletedAutomation', () => {
    it('pops every screen of the deleted automation and lands where it was opened from', () => {
        const routes = [r('(drawer)'), r('runs/index'), r('automations/[id]', 'a1'), r('automations/[id]/build', 'a1'), r('automations/[id]/settings', 'a1')];
        expect(deletedAutomationDepth(routes, 'a1')).toBe(3);
        const router = { dismiss: jest.fn(), replace: jest.fn() };
        leaveDeletedAutomation(router, routes, 'a1');
        expect(router.dismiss).toHaveBeenCalledWith(3);
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('stops at another automation', () => {
        expect(deletedAutomationDepth([r('automations/[id]', 'a0'), r('automations/[id]/settings', 'a1')], 'a1')).toBe(1);
    });

    it('falls back to the Automations list when nothing is underneath', () => {
        const router = { dismiss: jest.fn(), replace: jest.fn() };
        leaveDeletedAutomation(router, [r('automations/[id]', 'a1'), r('automations/[id]/settings', 'a1')], 'a1');
        expect(router.dismiss).toHaveBeenCalledWith(1);
        expect(router.replace).toHaveBeenCalledWith('/automations');
    });
});
