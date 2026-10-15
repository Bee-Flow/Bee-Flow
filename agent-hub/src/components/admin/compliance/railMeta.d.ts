// Types for the rail's meta and hint helpers (railMeta.js).
import type { Translate } from './header/registerSpecs';
import type { RailMeta, RailSection } from './ComplianceRail';

export const DAY_MS: number;
export function formatClock(iso: unknown, locale?: string): string | null;
export function formatDay(iso: unknown, locale?: string, now?: number): string;
export function railScore(counts: unknown, frameworkId: string): number | undefined;
export function railRowTitle(label: string, hint: string | null | undefined): string;
export default function railMeta(
    section: RailSection,
    counts: unknown,
    t: Translate,
    options?: { now?: number; failing?: number; locale?: string },
): RailMeta | null;
export function railHint(
    section: RailSection,
    counts: unknown,
    t: Translate,
    options?: { locale?: string },
): string | null;
