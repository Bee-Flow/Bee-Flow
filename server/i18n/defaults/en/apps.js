// English GUI defaults — namespace "apps": every key whose part before the first "." is "apps".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // Track APPS (Fase 2) — het /app/apps directory-scherm. Vóór deze stage
    // stond er geen enkele t()-aanroep in pages/apps/**; dit is de hele
    // woordenschat van dat scherm in één keer.
    // apps.published_count + _plural volgen de tellerconventie: dezelfde
    // Engelse tekst omdat "published" in het Engels niet verbuigt, maar wél
    // twee sleutels, want andere talen doen dat wel.
    'apps.title': 'Apps',
    'apps.untitled': 'Untitled app',
    'apps.open': 'Open',
    'apps.retry': 'Retry',
    'apps.load_failed': 'Could not load your apps.',
    'apps.loading': 'Loading apps',
    'apps.loading_short': 'Loading…',
    'apps.empty_title': 'No apps yet',
    'apps.empty_description': 'No apps have been shared with you yet. When someone in your organization publishes an internal tool to you, it will appear here.',
    'apps.filter_by_category': 'Filter apps by category',
    'apps.category.all': 'All',
    'apps.category.sales': 'Sales',
    'apps.category.service': 'Service',
    'apps.category.finance': 'Finance',
    'apps.category.hr': 'HR',
    'apps.category.internal': 'Internal',
    'apps.recently_used': 'Recently used',
    'apps.all_apps': 'All apps',
    'apps.search_placeholder': 'Search apps…',
    'apps.no_matches': 'No apps match your search.',
    'apps.build_in_studio': 'Build in Studio',
    'apps.sorted_by_name': 'Sorted by name',
    'apps.new_badge': 'new',
    'apps.access_hint': 'Only what you are allowed to use appears here',
    'apps.footnote': 'An app is a small tool someone in your organization built in App Studio — a form to fill in, a lookup, a job you would otherwise do by hand. You only see the apps that have been released to your group.',
    'apps.published_count': '{count} published',
    'apps.published_count_plural': '{count} published',
    // The standalone app-run page (pages/apps/AppRunPage.jsx): what a reader
    // sees when the app cannot be opened.
    'apps.run.restricted_title': 'This app is shared with specific groups',
    'apps.run.restricted_body': 'It is published to specific groups in your organization and you are not in one of them. Ask the app’s owner or your administrator to share it with your group.',
    'apps.run.not_available_title': 'This app is not available to you',
    'apps.run.not_available_body': 'It may be unpublished, or you may not have access. Ask the app’s owner to publish it or share it with your group.',
    'apps.run.load_failed_title': 'Could not load this app',
    'apps.run.load_failed_body': 'Something went wrong while loading the app.',
    'apps.run.try_again': 'Try again',
    // Hardcoded literals converted (2026-10)
    'apps.run.loading_label': 'Loading app',
    'apps.public_loading_label': 'Loading',
    'apps.picker_active': '{active}/{total} active',
    'apps.picker_hint': 'Click to use · Toggle to enable/disable',
    'apps.picker_search_placeholder': 'Search apps...',
    'apps.picker_search_label': 'Search apps',
    'apps.picker_none': 'No apps found',
    'apps.picker_step': 'Step',
};
