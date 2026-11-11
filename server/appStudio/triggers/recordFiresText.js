// @typecheck strict
'use strict';
/**
 * WHICH WRITES START A RECORD TRIGGER, as the AI builder reads it: one text, used by the kind's
 * description (kinds/record.mts), the triggers key (definitionKeys/triggers.js) and the tool
 * (builderTools/tools/app_set_record_trigger.js), so the three cannot say different things.
 *
 * The rule itself is recordTriggerRule.mts rule 1 (with the reasons); the panel's help text
 * (i18n studio_apps_h4.panel.fires_on) and docs/docs/studio/apps-server-runs.md say the same to
 * people. Change the rule and all of these change with it (recordTriggers.test.js checks the three
 * that use this text).
 */

const RECORD_TRIGGER_WRITES = 'A record trigger fires on every row a person changes in the app, one change per row: a grid or form edit; a create_record, update_record or delete_record step, by id or with a filter; '
    + 'such a step by id inside a transaction step, once the transaction commits; the rows ai_extract and dataset_query write through writeTo (plain, upsertKey and replaceWhere, the replaced rows included); '
    + 'and a delete that follows a delete rule onto linked records (each deleted child is a "delete" of its table, each emptied one an "update"). The same writes in the run of another trigger fire it too. '
    + 'It does NOT fire on rows written by the builder tools (app_seed_records, app_update_records, app_run_action, app_run_tests), imports, template installs, connector sync, '
    + 'the mailbox hook, file_intake, or an update_record / delete_record with a filter inside a transaction step. '
    + 'Many rows are many changes, not many runs at once: one write of more than 1000 rows starts nothing, and one writer starts at most 30 runs a minute; what was skipped shows on the trigger. ';

module.exports = { RECORD_TRIGGER_WRITES };
