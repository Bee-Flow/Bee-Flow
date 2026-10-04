/**
 * What Bee Flow itself demands of each surface a lesson can send a learner to.
 *
 * A lesson's gate is a promise: "if you can see this lesson, you can do it".
 * The Learning Center filters the whole catalog on it (lessons.lessonVisible,
 * and server/learning/courseCatalog.gatePasses for the completion math), so an
 * under-gated lesson is shown to someone whose plan or role cannot open the
 * screen it walks them into. They meet a lock or an upgrade prompt halfway
 * through, and — worse — a verified-action step they can never satisfy sits
 * between them and the course badge forever.
 *
 * Checking a gate against itself proves nothing, so this table records the gate
 * the PRODUCT puts on each surface, read off the places that actually decide:
 *   • Studio rail gates      components/admin/Studio/studioApps.jsx  (`gate:`)
 *   • route mounts           server/index.js (requireCapability / requireLicenseFeature)
 *   • route guards           requirePermission(...) inside server/routes/**
 *   • org sub-tabs           pages/AdvancedSettings.jsx (orgSubItems filter)
 *   • role → permission      server/config/orgRoles.json
 * lessonGates.test.js unions these per lesson and fails when a gate does not
 * cover the surfaces its own steps use.
 *
 * Two distinctions earn their keep; both were false positives before they existed:
 *
 *   VISIT vs ACT. Studio sections are open to everyone — studioApps' `gate:`
 *   carries no permission at all — and the permission only bites on create or
 *   change. So a tour step that merely opens a screen contributes `permView`,
 *   and an action step that tells the learner to build something there
 *   contributes `permWrite`. Org settings are the exception: the sub-tab itself
 *   is permission-gated, so the two are equal.
 *
 *   feat is ALL-of. Studio's own Playbooks gate is
 *   `hasLicenseFeature('automations') && canUse('app_studio')` — both, not
 *   either — which is why a lesson gate's `feature` may be a list.
 *
 * WHEN THE PRODUCT MOVES, THIS MOVES. A capability added to a screen here
 * without its entry updated turns the test green on a stale promise.
 */

/** navigateTo target → the gate the product puts on that screen. */
export const NAV_SURFACE_GATES = {
    'agentWizard':                             { feat: [], permView: [], permWrite: ['manage_agents'] },
    'agents':                                  { feat: [], permView: [], permWrite: [] },
    'apps':                                    { feat: ['app_studio'], permView: [], permWrite: [] },
    'cowork':                                  { feat: [], permView: [], permWrite: [] },
    'forms':                                   { feat: [], permView: [], permWrite: [] },
    'settings/appearance':                     { feat: [], permView: [], permWrite: [] },
    'settings/integrations':                   { feat: [], permView: [], permWrite: [] },
    'settings/memory':                         { feat: [], permView: [], permWrite: [] },
    'settings/organisation/academy':           { feat: ['learning_center'], permView: ['org_admin'], permWrite: ['org_admin'] },
    'settings/organisation/auth':              { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    'settings/organisation/azure':             { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    'settings/organisation/compliance':        { feat: ['compliance_hub_gdpr'], permView: ['admin_compliance'], permWrite: ['admin_compliance'] },
    'settings/organisation/encryption':        { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    'settings/organisation/info':              { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    'settings/organisation/integrations':      { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    'settings/organisation/license':           { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    'settings/organisation/meeting-templates': { feat: ['meeting_notes'], permView: ['org_admin'], permWrite: ['org_admin'] },
    'settings/organisation/privacy':           { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    'settings/organisation/usage':             { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    'settings/organisation/users':             { feat: [], permView: ['manage_users'], permWrite: ['manage_users'] },
    'settings/preferences':                    { feat: [], permView: [], permWrite: [] },
    'settings/security':                       { feat: [], permView: [], permWrite: [] },
    'studio/agents':                           { feat: [], permView: [], permWrite: ['manage_agents'] },
    'studio/approvals':                        { feat: ['approvals'], permView: [], permWrite: [] },
    'studio/apps':                             { feat: ['app_studio'], permView: [], permWrite: ['manage_apps'] },
    'studio/datatables':                       { feat: ['automations'], permView: [], permWrite: ['manage_datatables'] },
    'studio/forms':                            { feat: ['automations'], permView: [], permWrite: [] },
    'studio/knowledge':                        { feat: [], permView: [], permWrite: ['manage_knowledge'] },
    'studio/meetingNotes':                     { feat: ['meeting_notes'], permView: [], permWrite: [] },
    'studio/playbooks':                        { feat: ['automations',  'app_studio'], permView: [], permWrite: ['manage_apps'] },
    'studio/automations':                         { feat: ['automations'], permView: [], permWrite: [] },
    'studio/runs':                             { feat: ['automations'], permView: [], permWrite: [] },
    'studio/skills':                           { feat: ['skills'], permView: [], permWrite: ['manage_skills'] },
    'studio/solutions':                        { feat: ['projects'], permView: [], permWrite: [] },
    'studio/webpages':                         { feat: ['webpages'], permView: [], permWrite: [] },
};

/** API path prefix → the gate the product puts on that route (longest prefix wins). */
export const ENDPOINT_SURFACE_GATES = {
    '/agents':                                 { feat: [], permView: [], permWrite: [] },
    '/ai/config/chat-models':                  { feat: [], permView: [], permWrite: [] },
    '/ai/direct/conversations':                { feat: [], permView: [], permWrite: [] },
    '/ai/labels':                              { feat: [], permView: [], permWrite: [] },
    '/ai/providers':                           { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    '/ai/swarms':                              { feat: ['swarm'], permView: [], permWrite: [] },
    '/api/automation':                         { feat: ['automations'], permView: [], permWrite: [] },
    '/api/branding/effective':                 { feat: [], permView: [], permWrite: [] },
    '/api/compliance':                         { feat: ['compliance_hub_gdpr'], permView: ['admin_compliance'], permWrite: ['admin_compliance'] },
    '/api/compliance/iso':                     { feat: ['compliance_hub_gdpr'], permView: ['admin_compliance'], permWrite: ['admin_compliance'] },
    '/api/cowork':                             { feat: [], permView: [], permWrite: [] },
    '/api/datatables':                         { feat: ['automations'], permView: ['use_datatables'], permWrite: ['use_datatables'] },
    '/api/integrations/connections':           { feat: [], permView: [], permWrite: [] },
    '/api/kb':                                 { feat: [], permView: [], permWrite: ['manage_knowledge'] },
    '/api/license/status':                     { feat: [], permView: [], permWrite: [] },
    '/api/notebooks':                          { feat: ['notebooks'], permView: ['use_notebooks'], permWrite: ['use_notebooks'] },
    '/api/org-ai-context':                      { feat: [], permView: [], permWrite: ['org_admin'] },
    '/api/org-privacy-shield':                 { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    '/api/playbooks':                          { feat: ['automations',  'app_studio'], permView: [], permWrite: [] },
    '/api/projects':                           { feat: ['projects'], permView: [], permWrite: [] },
    '/api/skills':                             { feat: ['skills'], permView: [], permWrite: [] },
    '/api/step':                               { feat: ['automations'], permView: [], permWrite: [] },
    '/api/studio-apps':                        { feat: ['app_studio'], permView: [], permWrite: [] },
    '/api/summary-templates':                  { feat: ['meeting_notes'], permView: [], permWrite: [] },
    '/api/templates':                          { feat: [], permView: [], permWrite: [] },
    '/api/transcriptions':                     { feat: ['meeting_notes'], permView: [], permWrite: [] },
    '/api/webpages':                           { feat: ['webpages'], permView: [], permWrite: [] },
    '/auth/groups':                            { feat: [], permView: ['manage_users'], permWrite: ['manage_users'] },
    '/auth/invitations':                       { feat: [], permView: ['manage_users'], permWrite: ['manage_users'] },
    '/auth/me/group-access':                   { feat: [], permView: [], permWrite: [] },
    '/auth/mfa/status':                        { feat: [], permView: [], permWrite: [] },
    '/auth/organizations':                     { feat: [], permView: ['org_admin'], permWrite: ['org_admin'] },
    '/auth/organizations/:id/encryption':      { feat: ['encryption'], permView: ['org_admin'], permWrite: ['org_admin'] },
    '/auth/users':                             { feat: [], permView: ['manage_users'], permWrite: ['manage_users'] },
};

/**
 * Stronger ⇒ implies weaker. Only real containments: every role in
 * server/config/orgRoles.json that grants the key also grants each value, so a
 * gate demanding the stronger one is not missing the weaker one.
 */
export const PERMISSION_IMPLIES = {
    org_admin: ['manage_users', 'manage_agents', 'manage_skills', 'manage_knowledge', 'manage_apps',
        'manage_automations', 'manage_datatables', 'use_datatables', 'use_notebooks', 'admin_compliance'],
    manage_datatables: ['use_datatables'],
};

/** Longest-prefix lookup for an API path. */
export function endpointGate(path) {
    let best = null, bestLen = -1;
    const p = String(path || '').replace(/\/$/, '');
    for (const [prefix, gate] of Object.entries(ENDPOINT_SURFACE_GATES)) {
        const k = prefix.replace(/\/$/, '');
        if ((p === k || p.startsWith(k + '/')) && k.length > bestLen) { best = gate; bestLen = k.length; }
    }
    return best;
}
