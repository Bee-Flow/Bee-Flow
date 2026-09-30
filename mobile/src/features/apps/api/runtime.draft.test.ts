import { api } from '@/core/api/client';

import { getAppRuntime, runAppAction } from './endpoints';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

describe('getAppRuntime', () => {
    it('asks for the owner’s draft only when told to', async () => {
        const get = api.get as jest.Mock;
        get.mockResolvedValue(null);
        await getAppRuntime('a1');
        expect(get).toHaveBeenLastCalledWith('/api/studio-apps/a1/runtime', { signal: undefined, query: undefined });
        await getAppRuntime('a1', undefined, true);
        expect(get).toHaveBeenLastCalledWith('/api/studio-apps/a1/runtime', { signal: undefined, query: { draft: '1' } });
    });
});

describe('runAppAction', () => {
    it('runs the draft’s action only when the runtime was the draft', async () => {
        const post = api.post as jest.Mock;
        post.mockResolvedValue(null);
        await runAppAction('a1', 'go', { x: 1 });
        expect(post).toHaveBeenLastCalledWith('/api/studio-apps/a1/actions/go/run', { formValues: { x: 1 } }, {
            timeoutMs: 70_000,
            retry: false,
            query: undefined,
        });
        await runAppAction('a1', 'go', { x: 1 }, true);
        expect(post).toHaveBeenLastCalledWith('/api/studio-apps/a1/actions/go/run', { formValues: { x: 1 } }, {
            timeoutMs: 70_000,
            retry: false,
            query: { draft: '1' },
        });
    });
});
