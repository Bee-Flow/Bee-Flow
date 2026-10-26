// @typecheck strict
/**
 * Derive the `automations` row columns that mirror the definition's trigger.
 *
 * `trigger_type` / `schedule_cron` / `schedule_tz` are denormalised copies of
 * `definition.trigger` — the scheduler claims rows by querying those columns
 * (`stores/automationStore/automations.js`: `AND trigger_type = 'schedule'`),
 * never by reading the JSON definition.
 *
 * The AI builder has always kept them in step (`builderTools.persistDraft`),
 * but the visual editor writes only `definition`, so a schedule configured in
 * the node panel produced an automation whose `trigger_type` stayed 'manual' and
 * whose `next_run_at` was never computed — it simply never fired (BFSF-318).
 * `PUT /api/automations/:id` now derives the columns through this helper.
 *
 * Pure; safe on partial/malformed definitions.
 */

const DEFAULT_SCHEDULE_TZ = 'Europe/Amsterdam';

/**
 * @param {unknown} def  an automation definition (anything: a malformed one yields the manual defaults)
 * @returns {{triggerType: string, scheduleCron: string|null, scheduleTz: string}}
 */
function triggerColumnsFromDefinition(def) {
    const trigger = (def && typeof def === 'object') ? /** @type {{ trigger?: { kind?: string, schedule?: { cron?: string, tz?: string } } | null }} */ (def).trigger : null;
    return {
        triggerType: trigger?.kind || 'manual',
        scheduleCron: trigger?.schedule?.cron || null,
        scheduleTz: trigger?.schedule?.tz || DEFAULT_SCHEDULE_TZ,
    };
}

module.exports = { triggerColumnsFromDefinition, DEFAULT_SCHEDULE_TZ };
