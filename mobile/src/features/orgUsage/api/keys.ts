/**
 * Query keys for the organisation's usage reports. Keyed on the range PRESET,
 * not on its timestamps: a window that ends "now" would otherwise be a new key
 * on every render.
 */

import type { RangePreset } from '../model/range';
import type { BreakdownReport } from '../model/types';

export const orgUsageKeys = {
    overview: (range: RangePreset) => ['orgUsage', 'overview', range] as const,
    breakdown: (report: BreakdownReport, range: RangePreset) => ['orgUsage', 'breakdown', report, range] as const,
    feedback: (range: RangePreset) => ['orgUsage', 'feedback', range] as const,
    terminations: (range: RangePreset) => ['orgUsage', 'terminations', range] as const,
};
