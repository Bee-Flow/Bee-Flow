/**
 * Fields whose editor is the canvas itself — a container's CHILD steps. The
 * canvas draws those branches, and a second editor for them in a side panel
 * would be a disagreeing way to say the same thing.
 *
 * `switchCases` used to be in here too, which meant a switch's cases had no
 * editor at all: the canvas can draw a branch but has nowhere to say WHAT the
 * branch matches. So every hand-built switch had valueless cases and fell
 * through to "Otherwise". The panel now edits the case VALUES; the steps inside
 * each case stay on the canvas.
 */
export const CANVAS_TYPES = new Set(['steps']);

/**
 * Structured object types with no generic input — the default text field
 * would render "[object Object]" and write a string back over the config.
 * Authored by the AI builder (like ai_extract's schema); a dedicated editor
 * can land later without touching this filter.
 */
export const AI_AUTHORED_TYPES = new Set(['approvalQuestions', 'approvalOnDecided']);

/**
 * `<kind>.<field>` pairs the server still ACCEPTS but nothing reads. Rendering
 * an input for one is worse than rendering nothing: the builder fills it in,
 * the app ignores it, and there is no feedback anywhere. `refresh.actionId` is
 * the v2.0 field the runtime has always ignored (it reloads everything, or the
 * table/dataset named beside it).
 */
export const IGNORED_FIELDS = new Set(['refresh.actionId']);

/**
 * Field names the product says differently than the schema does. `humanize`
 * gets the rest right; these are the ones where the wire name is not the word
 * the builder knows the thing by.
 */
export const FIELD_LABELS: Record<string, string[]> = {
    automationId: ['studio_apps_edit.step_settings.field_automation', 'Automation'],
    modalId: ['studio_apps_edit.step_settings.field_dialog', 'Dialog'],
    connectorId: ['studio_apps_edit.step_settings.field_connection', 'Connection'],
    datasetId: ['studio_apps_edit.step_settings.field_saved_view', 'Saved view'],
    fileName: ['studio_apps_edit.step_settings.field_file_name', 'File name'],
    attachToRecordId: ['studio_apps_edit.step_settings.field_attach_record', 'Attach to record'],
    attachToFieldKey: ['studio_apps_edit.step_settings.field_attach_column', 'Attach to file column'],
    threadKey: ['studio_apps_edit.step_settings.field_conversation', 'Conversation'],
    poPattern: ['studio_apps_edit.step_settings.field_po_pattern', 'Purchase-order filename pattern'],
    documentMode: ['studio_apps_edit.step_settings.field_document_mode', 'Read documents as'],
};

export const HINTS: Record<string, string[]> = {
    resultVar: ['studio_apps_edit.step_settings.hint_result_var', 'The variable this step’s result lands in — formulas read it as vars.<name>.'],
    itemVar: ['studio_apps_edit.step_settings.hint_item_var', 'What each row is called inside the loop.'],
    indexVar: ['studio_apps_edit.step_settings.hint_index_var', 'What the position in the list is called (0, 1, 2…).'],
    maxIterations: ['studio_apps_edit.step_settings.hint_max_iterations', 'A ceiling, so a long list cannot run away.'],
    expr: ['studio_apps_edit.step_settings.hint_expr', 'Worked out each time the step runs.'],
    tableId: ['studio_apps_edit.step_settings.hint_table_id', 'Which of this app’s tables the step works on.'],
    datasetId: ['studio_apps_edit.step_settings.hint_dataset_id', 'Reload just this saved view instead of everything.'],
    rows: ['studio_apps_edit.step_settings.hint_rows', 'The rows that become the file — usually a table, filtered to what you want exported.'],
    slides: ['studio_apps_edit.step_settings.hint_slides', 'The outline a “Write with AI” step wrote (“# ” title, “## ” per slide, “- ” bullets), or rows with a title and content column — one slide per row.'],
    houseStyle: ['studio_apps_edit.step_settings.hint_house_style', 'Your organisation’s colours, font, logo and footer. Switch off only for a deck in someone else’s branding.'],
    columns: ['studio_apps_edit.step_settings.hint_columns', 'The column layout: rows of { name, from, value, order } — bind a table so admins edit the format as data.'],
    attachToRecordId: ['studio_apps_edit.step_settings.hint_attach_record', 'The record the file hangs off. Without it, only the app owner can download the result.'],
    attachToFieldKey: ['studio_apps_edit.step_settings.hint_attach_column', 'The file column on that record — set both or neither.'],
    threadKey: ['studio_apps_edit.step_settings.hint_thread_key', 'Which conversation’s mailed attachments to file.'],
    poPattern: ['studio_apps_edit.step_settings.hint_po_pattern', 'Filenames matching this (regex) count as the purchase order.'],
    documentMode: ['studio_apps_edit.step_settings.hint_document_mode', '“Images” forces page pictures — use it for technical drawings, whose text layer alone misleads.'],
    promptContext: ['studio_apps_edit.step_settings.hint_prompt_context', 'Live rows added to the prompt — the purchase-order lines, the open record, the vocabulary table.'],
};
