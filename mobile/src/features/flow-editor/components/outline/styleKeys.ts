/**
 * What the outline's and the canvas's style sheets share: the keys a
 * per-family or per-tone table is built over, the helper that builds one, and
 * the colours of a lane's tone. The outline card's recipe is the source; the
 * canvas wears it too, so the two may not drift.
 */

import type { Theme } from '@/core/theme/ThemeProvider';
import { NODE_FAMILIES, type NodeFamily } from '@/features/flow-editor/model';
import type { LaneTone } from '@/features/flow-editor/model/outline';

/** A step family, or 'none' for a step with no family colour. */
export type FamilyKey = NodeFamily | 'none';
export const FAMILY_KEYS: readonly FamilyKey[] = [...NODE_FAMILIES, 'none'];

export const LANE_TONES: readonly LaneTone[] = ['then', 'else', 'case', 'default', 'error', 'path'];

/** A table with one precomputed value per key. */
export function byKey<K extends string, V>(keys: readonly K[], value: (key: K) => V): Record<K, V> {
    return Object.fromEntries(keys.map((k) => [k, value(k)])) as Record<K, V>;
}

export const familyOf = (key: FamilyKey): NodeFamily | null => (key === 'none' ? null : key);

/**
 * A lane's (or a line chip's) fill and ink, from the theme's status pairs:
 * then is success, else a warning, a case the branch colour, an error path an
 * error, and anything else quiet. `unrouted` is the chip on a line nothing
 * routes to.
 */
export function toneColors(theme: Theme, tone: LaneTone | 'unrouted'): { raw: string; ink: string } {
    const c = theme.colors;
    switch (tone) {
        case 'then':
            return { raw: c.success, ink: c.successInk };
        case 'else':
            return { raw: c.warning, ink: c.warningInk };
        case 'error':
        case 'unrouted':
            return { raw: c.error, ink: c.errorInk };
        case 'case':
            return { raw: theme.stepType.branch, ink: theme.stepType.branch };
        default:
            return { raw: c.textTertiary, ink: c.textSecondary };
    }
}
