// Test support for the three document components: a fetch that answers by URL
// (the real authFetch → fetch path, no module mocks) and a runtime to mount in.

import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { DataProvider } from '../../DataContext';
import { DEFAULT_RUNTIME, RuntimeProvider } from '../../RuntimeContext';

interface Answer { status?: number; body: unknown }
export type Route = [match: string, answer: (init?: RequestInit) => Answer];

/** Stub fetch: the first route whose text the URL contains answers; calls are recorded. */
export function stubFetch(routes: Route[]) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const route = routes.find(([match]) => url.includes(match));
        const { status = 200, body } = route ? route[1](init) : { status: 404, body: { error: 'Not found', code: 'not_found' } };
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }));
    return calls;
}

/** One app runtime around `ui`: run mode, app_1, a query client. */
export function mountInApp(ui: ReactElement, { mode = 'run', runAction = vi.fn() }: { mode?: string; runAction?: unknown } = {}) {
    return render(withQueryClient(
        <DataProvider appId="app_1">
            <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode, runAction } as never}>{ui}</RuntimeProvider>
        </DataProvider>,
    ));
}
