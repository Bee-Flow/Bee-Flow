/** TEST FIXTURE, never shipped: the executor of the zz_probe fixture kind. */
export async function runStep(app: { id: string }, _model: unknown, step: { tableId?: string }, ctx: { marker?: string }): Promise<{ ok: true; result: unknown }> {
    return { ok: true, result: { appId: app.id, tableId: step.tableId ?? null, marker: ctx.marker ?? null } };
}
