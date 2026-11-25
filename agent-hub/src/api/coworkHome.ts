// Cowork's home over GET /api/cowork/home (server/usecases/coworkHome.mts): how each item works, the owner's day, what
// Cowork cost in AI this month, how much of the organisation's budget is used, and how each item's last run ended. The
// day is the browser's: its start and end go along as ISO times.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from './typedRequest';
import type { Independence } from './coworkIndependence';

interface HowItWorks {
    kind: 'plan' | 'agent' | 'prompt';
    fixed: number;
    ai: number;
    ask: number;
    deliver: number;
    level: Independence | null;
    /** The item's goal and its latest count; absent without a goal (met and total null before a first count). */
    goal?: GoalLine;
}

interface GoalLine { sentence: string; targetPercent: number; met: number | null; total: number | null; period: string | null; measuredAt: string | null }

interface TodayEntry { kind: 'ran' | 'next'; itemId: string; title: string; at: string | null; status: string | null; runId: string | null }

interface CoworkCost { byCurrency: Record<string, number>; calls: number }

export interface CoworkHome {
    how: Record<string, HowItWorks>;
    today: TodayEntry[];
    cost: CoworkCost | null;
    /** The organisation's monthly Cowork AI budget used, in whole percent; null without one (absent from an older server). */
    budget?: { percent: number } | null;
    /** Per item, the outcome code of its newest finished run (`nothing_to_do`, `done`, ...); absent from an older server. */
    outcomes?: Record<string, string>;
}

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
