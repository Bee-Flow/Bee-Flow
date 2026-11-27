// Maps an integration id (as stored on agent.config.enabledIntegrations) to
// the OAuth provider whose tokens are required to call it. Anything not
// mapped here is assumed to use a per-user config-store API key (Fireflies,
// YouTrack, Gamma, etc) which doesn't need session auth at all.
const INTEGRATION_PROVIDER: Record<string, string> = {
    gmail:              'google',
    'google-calendar':  'google',
    'google-drive':     'google',
    'google-docs':      'google',
    'google-sheets':    'google',
    'google-slides':    'google',
    'google-contacts':  'google',
    'google-keep':      'google',
    'google-groups':    'google',
    outlook:            'microsoft',
    'outlook-readonly': 'microsoft',
    'ms-calendar':      'microsoft',
    'ms-contacts':      'microsoft',
    onedrive:           'microsoft',
    nextcloud:          'nextcloud',
    'nextcloud-calendar':      'nextcloud',
    'nextcloud-contacts':      'nextcloud',
    'nextcloud-deck':          'nextcloud',
    'nextcloud-notifications': 'nextcloud',
    'nextcloud-talk':          'nextcloud',
    'nextcloud-tasks':         'nextcloud',
    'nextcloud-notes':         'nextcloud',
    'nextcloud-mail':          'nextcloud',
    'nextcloud-activity':      'nextcloud',
    'nextcloud-status':        'nextcloud',
    withings:                  'withings',
};

export function providersForIntegrations(enabledIntegrations: unknown): string[] {
    if (!Array.isArray(enabledIntegrations)) return [];
    const set = new Set<string>();
    for (const id of enabledIntegrations) {
        const p = INTEGRATION_PROVIDER[id];
        if (p) set.add(p);
    }
    return Array.from(set);
}
