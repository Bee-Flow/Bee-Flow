// Cowork's home over GET /api/cowork/home (server/usecases/coworkHome.mts): how each item works, the owner's day, and
// what Cowork cost in AI this month. The day is the browser's: its start and end go along as ISO times.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from './typedRequest';
import type { Independence } from './coworkIndependence';

export interface HowItWorks {
    kind: 'plan' | 'agent' | 'prompt';
    fixed: number;
    ai: number;
    ask: number;
    deliver: number;
    level: Independence | null;
}

export interface TodayEntry { kind: 'ran' | 'next'; itemId: string; title: string; at: string | null; status: string | null; runId: string | null }

interface CoworkCost { byCurrency: Record<string, number>; calls: number }

export interface CoworkHome { how: Record<string, HowItWorks>; today: TodayEntry[]; cost: CoworkCost | null }

/** Today on the reader's clock, as the server wants it. */
function todayBounds(now: Date = new Date()): { from: string; to: string } {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { from: start.toISOString(), to: end.toISOString() };
}

export function useCoworkHome(reloadKey = 0) {
    return useQuery<CoworkHome, Error>({
        queryKey: ['cowork', 'home', reloadKey],
        queryFn: () => apiJson<'GET /api/cowork/home', CoworkHome>('GET /api/cowork/home', { query: todayBounds() }),
        staleTime: 15_000,
        refetchInterval: 60_000,
        retry: false,
    });
}
