import type { XYRow } from '../ui.types';
import type { Listish, FunnelRow, Step, JourneyRow, RetentionRow } from './BehaviorSection.types';

export function readFunnel(payload: Listish<FunnelRow>) {
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
    return rows.map(r => ({
        label: r.value ?? r.x ?? r.type ?? '',
        visitors: Number(r.visitors ?? r.y ?? r.count ?? 0),
        dropoff: r.dropoff != null ? Number(r.dropoff) : null,
    }));
}

/**
 * A funnel worth showing before the user has built one.
 *
 * The tab used to open on an empty box with a single "Add a step…" dropdown,
 * so it read as broken on arrival and demanded data modelling before it showed
 * anything. The busiest landing page → the next busiest page → a conversion
 * event is the funnel almost everyone would have drawn anyway.
 */
export function defaultSteps(pageRows: XYRow[], eventRows: XYRow[]): Step[] {
    const pages = pageRows.filter(p => p.x).slice(0, 3);
    if (pages.length < 2) return [];
    const home = pages.find(p => p.x === '/') || pages[0];
    const next = pages.find(p => p.x !== home.x);
    if (!next) return [];
    const steps = [{ type: 'path', value: home.x }, { type: 'path', value: next.x }];
    const conversion = eventRows.find((e: XYRow): boolean => e.x === 'form_submit') || eventRows.find((e: XYRow): boolean => e.x === 'cta_click');
    if (conversion) steps.push({ type: 'event', value: conversion.x });
    return steps;
}

export function readJourneys(payload: Listish<JourneyRow>) {
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
    return rows.map(r => ({
        path: Array.isArray(r.items) ? r.items : (Array.isArray(r.path) ? r.path : []),
        count: Number(r.count ?? r.y ?? r.visitors ?? 0),
    })).filter(r => r.path.length > 0);
}

export function readRetention(payload: Listish<RetentionRow>) {
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
    const byCohort = new Map();
    for (const r of rows) {
        const cohort = r.date ?? r.cohort ?? '';
        const day = Number(r.day ?? r.offset ?? 0);
        const pct = r.percentage != null ? Number(r.percentage)
            : (r.visitors && r.returnVisitors != null ? (Number(r.returnVisitors) / Number(r.visitors)) * 100 : null);
        if (!cohort) continue;
        if (!byCohort.has(cohort)) byCohort.set(cohort, { cohort, visitors: Number(r.visitors ?? 0), days: new Map() });
        byCohort.get(cohort).days.set(day, pct);
    }
    return [...byCohort.values()];
}
