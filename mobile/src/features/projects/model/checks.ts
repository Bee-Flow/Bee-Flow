/**
 * The checks on one Solution, and the publish gate that reads them — ports of
 * isBlocking (projects/SolutionControlPanel.jsx), worstByEntity
 * (projects/SolutionContentTable.jsx), controlBadge and blueprintVersionFor
 * (admin/Studio/Solutions/SolutionDetail.jsx).
 *
 * THE GATE: publishing is offered only when the server said `blocked: false`.
 * Not `findings.length === 0` — a failed request, a network error and "not
 * loaded yet" all leave the answer missing, and every one of those keeps the
 * button shut.
 */

import type { BlueprintMeta } from './package';
import type { Completeness, Finding } from './solution';

/** Does this finding stop a release? An error, or one tagged `blockedAt: 'publish'`. */
export function isBlocking(finding: Pick<Finding, 'severity' | 'blockedAt'>): boolean {
    return finding.severity === 'error' || finding.blockedAt === 'publish';
}

/** The findings split where their meaning changes: fix first, then worth a look. */
export function splitFindings(findings: readonly Finding[]): { blocking: Finding[]; advice: Finding[] } {
    return {
        blocking: findings.filter(isBlocking),
        advice: findings.filter((f) => !isBlocking(f)),
    };
}

/** May the owner publish? Only on an answer that SAID it was not blocked. */
export function publishAllowed(completeness: Completeness | null | undefined): boolean {
    return completeness?.blocked === false;
}

/** The graph and the palette spell a knowledge base differently. One map. */
const FINDING_KIND: Readonly<Record<string, string>> = { knowledge_base: 'kb' };
export const findingKind = (kind: string): string => FINDING_KIND[kind] ?? kind;

/**
 * `kind:id` → the worst finding raised about it. Absent means "nothing said",
 * which the row renders as nothing — never as an all-clear tick.
 */
export function worstByEntity(findings: readonly Finding[] | null | undefined): Map<string, Finding> {
    const map = new Map<string, Finding>();
    for (const f of findings ?? []) {
        const id = f.targetRef?.id;
        if (!id || !f.targetRef) continue;
        const key = `${findingKind(f.targetRef.kind)}:${id}`;
        const seen = map.get(key);
        if (!seen || (seen.severity !== 'error' && f.severity === 'error')) map.set(key, f);
    }
    return map;
}

/** The Check tab's count, and whether any of it blocks. No count for none or for unknown. */
export function controlBadge(completeness: Completeness | null | undefined): {
    count: number | null;
    tone: 'error' | 'warning' | null;
} {
    const findings = completeness?.findings ?? [];
    if (findings.length === 0) return { count: null, tone: null };
    return { count: findings.length, tone: findings.some(isBlocking) ? 'error' : 'warning' };
}

/**
 * The Blueprint version chip, or null. Versions are counted per (Solution,
 * publisher), so the chip shows only when ONE person's series exists, and an
 * invented "v1.0" for a Solution nobody published is never shown.
 */
export function blueprintVersionFor(blueprints: readonly BlueprintMeta[] | null | undefined, projectId: string): number | null {
    if (!blueprints || !projectId) return null;
    const mine = blueprints.filter((b) => b.solutionKey === `sol_${projectId}`);
    if (mine.length === 0) return null;
    if (new Set(mine.map((b) => b.createdBy)).size > 1) return null;
    const highest = mine.reduce((max, b) => Math.max(max, Number(b.version) || 0), 0);
    return highest > 0 ? highest : null;
}
