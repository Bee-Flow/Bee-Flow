import { request, RefusedError } from '@/api/mutate';

export function rangeToFilter(rangeId: string, customStart: string, customEnd: string): Record<string, string> {
    if (rangeId === 'all') return {};
    if (rangeId === 'custom') {
        if (!customStart || !customEnd) return {};
        return { startDate: new Date(customStart).toISOString(), endDate: new Date(customEnd).toISOString() };
    }
    const now = new Date();
    let start: Date;
    if (rangeId === 'today') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (rangeId === '7d') {
        start = new Date(now.getTime() - 7 * 86400000);
    } else {
        start = new Date(now.getTime() - 30 * 86400000);
    }
    return { startDate: start.toISOString(), endDate: now.toISOString() };
}

// Previous period: same duration ending where current starts
export function prevPeriodFilter(rangeId: string, customStart: string, customEnd: string) {
    if (rangeId === 'all') return null;
    const now = new Date();
    let start: Date, end: Date;
    if (rangeId === 'custom') {
        if (!customStart || !customEnd) return null;
        const s = new Date(customStart), e = new Date(customEnd);
        const dur = e.getTime() - s.getTime();
        if (dur <= 0) return null;
        end = s;
        start = new Date(s.getTime() - dur);
    } else if (rangeId === 'today') {
        end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        start = new Date(end.getTime() - 86400000);
    } else if (rangeId === '7d') {
        end = new Date(now.getTime() - 7 * 86400000);
        start = new Date(end.getTime() - 7 * 86400000);
    } else {
        end = new Date(now.getTime() - 30 * 86400000);
        start = new Date(end.getTime() - 30 * 86400000);
    }
    return { startDate: start.toISOString(), endDate: end.toISOString() };
}

// Decide chart interval based on the date span
export function autoInterval(rangeId: string, customStart: string, customEnd: string) {
    if (rangeId === 'today') return 'hour';
    if (rangeId === 'custom' && customStart && customEnd) {
        const diffMs = new Date(customEnd).getTime() - new Date(customStart).getTime();
        if (diffMs <= 86400000) return 'hour'; // ≤ 1 day
        return 'day';
    }
    return 'day';
}

// Format a datetime-local string from a Date
export function toLocalInput(date: Date) {
    const d = new Date(date);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function fetchJson(url: string) {
    try {
        let r: Response;
        try {
            r = await request(url);
        } catch (err) {
            if (!(err instanceof RefusedError)) throw err;
            return null;
        }
        return await r.json();
    } catch { return null; }
}
