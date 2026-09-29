// English GUI defaults — namespace "billing": every key whose part before the first "." is "billing".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    "billing.recurring_badge": "Recurring · automatische incasso",
    "billing.invoices": "Invoices",
    "billing.no_invoices": "No invoices yet.",
    "billing.invoices_load_failed": "Failed to load invoices",
    "billing.status_paid": "Paid",
    "billing.status_open": "Open",
    "billing.status_uncollectible": "Uncollectible",
    "billing.status_void": "Void",
    "billing.invoice": "Invoice",
    "billing.download": "Download",
    "billing.invoice_pdf_failed": "Failed to load the invoice PDF. Try again.",
    "billing.retry": "Retry",
    "billing.recurring_notice": "This is a recurring subscription. Your selected payment method is charged automatically at the start of each billing period (automatische incasso) until you cancel.",

    // ── Billing: shared plan card / plan grid (components/billing) ──
    "billing.free": "Free",
    "billing.per_month": "/month",
    "billing.per_year": "/year",
    "billing.per_seat": "per seat",
    "billing.current_plan": "Current plan",
    "billing.your_plan": "Your plan",
    "billing.choose_plan": "Choose plan",
    "billing.subscribe": "Subscribe",
    "billing.metered_note": "Billed on actual usage",
    "billing.seats_summary": "{seats} seats currently in use",
    "billing.trial_days": "{days}-day free trial",
    "billing.no_plans": "No plans are available right now.",
};
