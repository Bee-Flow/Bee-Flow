import { deletedRoutineDepth, leaveDeletedRoutine } from './leaveDeletedRoutine';

const r = (name: string, id?: string) => ({ name, params: id ? { id } : {} });

describe('leaveDeletedRoutine', () => {
    it('pops every screen of the deleted routine and lands where it was opened from', () => {
        const routes = [r('(drawer)'), r('runs/index'), r('automations/[id]', 'a1'), r('automations/[id]/build', 'a1'), r('automations/[id]/settings', 'a1')];
        expect(deletedRoutineDepth(routes, 'a1')).toBe(3);
        const router = { dismiss: jest.fn(), replace: jest.fn() };
        leaveDeletedRoutine(router, routes, 'a1');
        expect(router.dismiss).toHaveBeenCalledWith(3);
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('stops at another routine', () => {
        expect(deletedRoutineDepth([r('automations/[id]', 'a0'), r('automations/[id]/settings', 'a1')], 'a1')).toBe(1);
    });

    it('falls back to the Automations list when nothing is underneath', () => {
        const router = { dismiss: jest.fn(), replace: jest.fn() };
        leaveDeletedRoutine(router, [r('automations/[id]', 'a1'), r('automations/[id]/settings', 'a1')], 'a1');
        expect(router.dismiss).toHaveBeenCalledWith(1);
        expect(router.replace).toHaveBeenCalledWith('/automations');
    });
});
