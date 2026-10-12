// Section registry + gating for the super-admin integrations panel.
// Moved verbatim from IntegrationsAdminPanel.jsx.
import { Cloud, ExternalLink, Layers, Mail, Search as SearchIcon, Settings } from 'lucide-react';
import { INTEGRATION_CATALOG } from '../../../config/integrationCatalog';

export const SECTIONS = [
    { id: 'features', labelKey: 'admin.integ_features', icon: Layers, color: '#10b981' },
    { id: 'integrations', labelKey: 'admin.integ_integrations', icon: Settings, color: '#3b82f6' },
    { id: 'email', labelKey: 'admin.integ_email', icon: Mail, color: '#ea4335' },
    { id: 'search', labelKey: 'admin.integ_search', icon: SearchIcon, color: '#10b981' },
    { id: 'transcription', labelKey: 'admin.integ_transcription', icon: Cloud, color: '#0ea5e9' },
    { id: 'services', labelKey: 'admin.integ_services', icon: ExternalLink, color: '#0A66C2' },
];

// Sidebar sections gated by an Enterprise licence feature — hidden on Community
// (resolved tier is the real tier, so the operator's own UI hides them).
// Meeting Transcription config backs the Enterprise `meeting_notes` feature.
// MCP servers are no longer a section here: installing and managing them moved
// to Settings → Organisation → MCP library (components/mcpLibrary), where a
// server administrator also gets the "Server-wide" tab and the org policy.
export const SECTION_FEATURE_GATE = {
    transcription: 'meeting_notes',
};

// Sections hidden on Community by raw tier rather than a single feature flag:
// the Service Email (Gmail SMTP) config and the external Services panel
// (LinkedIn API + Azure Document Processing) are Enterprise admin surfaces with
// no dedicated licence feature of their own.
export const ENTERPRISE_ONLY_SECTIONS = new Set(['email', 'services']);

// All known integration IDs + labels live in src/config/integrationCatalog.js
// so the super-admin panel and the org-admin OrgFeatureTogglesPanel use the
// same source. Categories (incl. Nextcloud) are rendered as-is; section order
// is controlled by orderCategories().
export const ALL_INTEGRATIONS = INTEGRATION_CATALOG;
