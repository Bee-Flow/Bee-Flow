import { describe, expect, it } from 'vitest';
import { projectsAvailable } from './useProjectsAvailable';

describe('projectsAvailable', () => {
    const plan = (has: boolean) => (name: string) => has && name === 'projects';

    it('needs the plan and the operator switch', () => {
        expect(projectsAvailable({ featureFlags: { projects: true } }, plan(true))).toBe(true);
        expect(projectsAvailable({}, plan(true))).toBe(true);
        expect(projectsAvailable({ featureFlags: { projects: false } }, plan(true))).toBe(false);
        expect(projectsAvailable({ featureFlags: { projects: true } }, plan(false))).toBe(false);
        expect(projectsAvailable(null, plan(false))).toBe(false);
    });
});
