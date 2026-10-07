// English GUI defaults — namespace "dsr_public": every key whose part before the first "." is "dsr_public".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // ── Public DSR form (/privacy/requests — reachable without an account) ──
    'dsr_public.title': 'Privacy request',
    // GDPR Art. 12(3): one month from receipt, extendable by two further months where necessary.
    'dsr_public.subtitle': 'Under the GDPR you can ask what personal data we process about you, and have it corrected, exported or deleted. Submit your request below — it will be answered within one month of receipt, a period that can be extended by two further months where necessary.',
    'dsr_public.email': 'Your email address',
    'dsr_public.type': 'What would you like us to do?',
    'dsr_public.type_access': 'Access my data (Art. 15)',
    'dsr_public.type_rectification': 'Correct my data (Art. 16)',
    'dsr_public.type_deletion': 'Delete my data (Art. 17)',
    'dsr_public.type_portability': 'Export my data (Art. 20)',
    'dsr_public.type_restriction': 'Restrict processing (Art. 18)',
    'dsr_public.type_objection': 'Object to processing (Art. 21)',
    'dsr_public.notes': 'Anything we should know? (optional)',
    'dsr_public.error': 'Could not submit the request:',
    'dsr_public.submitting': 'Submitting…',
    'dsr_public.submit': 'Submit request',
    'dsr_public.submitted_title': 'Request received',
    'dsr_public.submitted_body': 'Keep this reference number to check the status of your request later:',
    'dsr_public.check_title': 'Check an existing request',
    'dsr_public.check_id': 'Reference #',
    'dsr_public.check_email': 'Your email',
    'dsr_public.check_btn': 'Check',
    'dsr_public.check_not_found': 'No request found for that reference number and email.',
    'dsr_public.check_status': 'Status of request #{id}: {status}',
    'dsr_public.verify_pending': 'Confirming your identity…',
    'dsr_public.verify_ok_title': 'Identity confirmed',
    'dsr_public.verify_ok_body': 'Thank you. Your request will be handled within the legal deadline; you will hear from us by e-mail.',
    'dsr_public.verify_failed_title': 'This link could not be used',
    'dsr_public.verify_failed_body': 'The link may have expired or already been used. Your request itself is unaffected — check its status below, or submit a new request if you did not receive an acknowledgement.',
    'dsr_public.due_by': 'Answer expected by {date}',
    'dsr_public.check_extended': 'deadline extended (Art. 12(3))',
};
