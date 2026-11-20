/**
 * Which library rows a Solution stage manages (`managed: true`), the same
 * meaning as the `managed` a single document GET carries
 * (document/solutionTemplates.managedOf): a template filed into a stage project
 * (UAT/PRD) changes only through a deploy, so the server refuses its archive.
 * The list says so up front and the library hides the actions it would refuse.
 *
 * One query for the whole page: the distinct Solution projects of the rows,
 * looked up in solution_stages. An install where that table does not exist yet
 * (42P01) has no stages, so nothing is managed.
 */

type Row = { solutionProjectId?: string | null } & Record<string, unknown>;
type GetAll = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

const UNDEFINED_TABLE = '42P01';

/** The stage projects among these project ids (an empty set when there are none, or no stages table). */
async function stageProjects(getAll: GetAll, projectIds: string[]): Promise<Set<string>> {
    if (!projectIds.length) return new Set();
    try {
        const rows = await getAll('SELECT project_id FROM solution_stages WHERE project_id = ANY($1)', [projectIds]);
        return new Set(rows.map((r) => String(r.project_id)));
    } catch (err) {
        if ((err as { code?: string })?.code === UNDEFINED_TABLE) return new Set();
        throw err;
    }
}

/** The rows with `managed` set: true for a template a Solution stage manages, false for every other row. */
export async function withManagedFlag<T extends Row>(getAll: GetAll, rows: T[]): Promise<Array<T & { managed: boolean }>> {
    const ids = [...new Set(rows.map((r) => r.solutionProjectId).filter((id): id is string => typeof id === 'string' && id !== ''))];
    const stages = await stageProjects(getAll, ids);
    return rows.map((r) => ({ ...r, managed: !!r.solutionProjectId && stages.has(r.solutionProjectId) }));
}
