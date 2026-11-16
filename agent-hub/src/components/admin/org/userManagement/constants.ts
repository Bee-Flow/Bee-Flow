// BFSF-286: registration provenance labels. Literal keys (no template
// interpolation) so the i18nGuard static scan sees them.
export const ORG_SOURCE_KEY: Record<string, string> = {
    direct: 'admin.org_source_direct',
    admin: 'admin.org_source_admin',
    nextcloud_connector: 'admin.org_source_nextcloud_connector',
};
