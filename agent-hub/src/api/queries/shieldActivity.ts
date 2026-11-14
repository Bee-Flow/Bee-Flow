// The Privacy Shield activity reads: the two server-side aggregates of a window and,
// when asked, the two capped detail ledgers, as one read so the pane changes at once.

import { useQuery } from '@tanstack/react-query';
import { settled } from '../settled';
import { apiUrl } from '../typedRequest';

/** One endpoint's answer: its JSON body, or `notFound` on a 404 (a server without the endpoint). */
export interface ShieldFetched<T = unknown> { notFound?: boolean; data?: T }

/** The four answers of one window, in the order they are asked. */
export interface ShieldActivityRead<Guard, Integ, Row> {
    guard: ShieldFetched<Guard>;
    integ: ShieldFetched<Integ>;
    guardRows: ShieldFetched<Row[]>;
    egressRows: ShieldFetched<Row[]>;
}

async function fetchJson<T>(url: string): Promise<ShieldFetched<T>> {
    const res = await settled(url, undefined, 'empty');
    if (!res.ok) {
        if (res.status === 404) return { notFound: true };
        throw new Error(`HTTP ${res.status}`);
    }
    return { data: (await res.res.json()) as T };
}

const REFRESH_MS = 30_000;

interface ShieldActivityQueryOptions {
    enabled: boolean;
    /** The query string of the two aggregates (`?days=30&orgId=…`, or empty). */
    overviewQuery: string;
    /** The query string of the two ledgers (the same window plus the row cap). */
    detailQuery: string;
    /** Also ask the two ledgers; without it they answer as not found. */
    detail: boolean;
    /** Ask again every 30 seconds while the browser tab is visible, and once when it becomes visible again. */
    poll: boolean;
}

/**
 * GET /api/usage/guardrails/overview, /integrations/overview and (with `detail`)
 * /guardrails/recent and /integrations/egress for one window. A window is asked
 * again from the server every time it is chosen, and a refusal is not retried.
 */
export function useShieldActivityQuery<Guard, Integ, Row>({ enabled, overviewQuery, detailQuery, detail, poll }: ShieldActivityQueryOptions) {
    return useQuery<ShieldActivityRead<Guard, Integ, Row>, Error>({
        queryKey: ['shield', 'activity', overviewQuery, detail ? detailQuery : null],
        queryFn: async () => {
            const none: Promise<ShieldFetched<Row[]>> = Promise.resolve({ notFound: true });
            const [guard, integ, guardRows, egressRows] = await Promise.all([
                fetchJson<Guard>(`${apiUrl('GET /api/usage/guardrails/overview')}${overviewQuery}`),
                fetchJson<Integ>(`${apiUrl('GET /api/usage/integrations/overview')}${overviewQuery}`),
                detail ? fetchJson<Row[]>(`${apiUrl('GET /api/usage/guardrails/recent')}${detailQuery}`) : none,
                detail ? fetchJson<Row[]>(`${apiUrl('GET /api/usage/integrations/egress')}${detailQuery}`) : none,
            ]);
            return { guard, integ, guardRows, egressRows };
        },
        enabled,
        staleTime: 0,
        gcTime: 0,
        retry: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: poll,
        refetchInterval: poll ? REFRESH_MS : false,
    });
}
