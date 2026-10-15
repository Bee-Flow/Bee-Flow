// Full mirror of each type's `events` array in COMPONENT_SPECS — the lockstep
// test pins this against the server spec. A type absent here carries no events.
export const TYPE_EVENT_LISTS: Record<string, string[]> = {
    button: ['onClick'],
    list: ['onRowClick'],
    form: ['onSubmit'],
    data_grid: ['onRowClick', 'onRowSelect'],
    timeline: ['onRowClick'],
    stepper: ['onRowClick'],
    file_gallery: ['onRowClick'],
    badge_list: ['onRowClick'],
    input_select: ['onChange'],
    input_checkbox: ['onChange'],
    input_date: ['onChange'],
    input_multiselect: ['onChange'],
    // Fires once per upload batch, after the descriptor lands — the hook a form
    // uses to check a file the moment it arrives instead of at submit time.
    input_file: ['onChange'],
    // Fires when a dataset becomes the value: on pick, or on upload AFTER the
    // background ingest reaches 'ready' (an indexing dataset is not queryable).
    input_dataset: ['onChange'],
    message_thread: ['onRowClick'],
    kanban: ['onRowClick', 'onCardMove'],
    calendar: ['onRowClick'],
    // Fires with the clicked point's row (the synthetic time column stripped),
    // so a trend chart can open the reading behind a spike.
    chart: ['onRowClick'],
    // Fires after a decision lands in the in-app approvals inbox, with
    // { approvalId, decision, reason, answers, context } in the form scope.
    approval_list: ['onDecided'],
};
