import { formFrom, formProblem, repoUrl } from './github';

describe('GitHub sync form', () => {
    it('starts from the stored config, or empty on main', () => {
        expect(formFrom(null)).toEqual({ repoOwner: '', repoName: '', branch: 'main', autoSync: false });
        expect(formFrom({ repoOwner: 'bee-flow', repoName: 'agents', branch: 'dev', autoSync: true } as never)).toEqual({
            repoOwner: 'bee-flow',
            repoName: 'agents',
            branch: 'dev',
            autoSync: true,
        });
    });

    it('names the first field the server would refuse', () => {
        const ok = { repoOwner: 'bee-flow', repoName: 'agent-configs', branch: 'main', autoSync: false };
        expect(formProblem(ok)).toBeNull();
        expect(formProblem({ ...ok, repoOwner: '-bad' })).toBe('owner');
        expect(formProblem({ ...ok, repoName: 'a b' })).toBe('name');
        expect(formProblem({ ...ok, branch: 'feat..x~1' })).toBe('branch');
        expect(formProblem({ ...ok, branch: '' })).toBeNull();
        expect(formProblem({ ...ok, branch: '.hidden' })).toBe('branch');
    });

    it('links the repository', () => {
        expect(repoUrl({ repoOwner: 'bee-flow', repoName: 'x' })).toBe('https://github.com/bee-flow/x');
    });
});
