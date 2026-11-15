// Section registry + gating for the super-admin Platform services panel (the
// old Integrations tab). Its sections are the child rows of the dashboard's
// Platform services row; the feature switches moved to Licence & features and
// the web search provider to AI configuration > Search & retrieval.
import { Cloud, ExternalLink, Mail, Search as SearchIcon, ToggleLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { INTEGRATION_CATALOG } from '@/config/integrationCatalog';

export interface PlatformSection {
    id: string;
    labelKey: string;
    fallback: string;
    icon: LucideIcon;
}

/** The sections of Platform services, in order. */
export const SECTIONS: readonly PlatformSection[] = [
    { id: 'defaults', labelKey: 'admin_platform.section_defaults', fallback: 'Defaults for new organisations', icon: ToggleLeft },
    { id: 'email', labelKey: 'admin_platform.section_email', fallback: 'Email', icon: Mail },
    { id: 'transcription', labelKey: 'admin_platform.section_transcription', fallback: 'Transcription', icon: Cloud },
    { id: 'connected-apps', labelKey: 'admin_platform.section_connected_apps', fallback: 'Connected apps', icon: ExternalLink },
];

/**
 * Sections a host may still mount by name although they are not Platform
 * services any more: the web search provider. AI configuration > Search &
 * retrieval renders its form itself (ai-config/RetrievalPage); the panel only
 * keeps the name mountable.
 */
export const MOUNT_ONLY_SECTIONS: readonly PlatformSection[] = [
    { id: 'search', labelKey: 'admin.integ_search', fallback: 'Search', icon: SearchIcon },
];

// Sections gated by an Enterprise licence feature — hidden without it (the
// resolved tier is the real tier, so the operator's own UI hides them).
// Meeting Transcription config backs the Enterprise `meeting_notes` feature.
export const SECTION_FEATURE_GATE: Record<string, string> = {
    transcription: 'meeting_notes',
};

// Sections hidden on Community by raw tier rather than a single feature flag:
// the service e-mail (Gmail SMTP) has no licence feature of its own. Connected
// apps is on every tier because the Google Maps key lives there; its OAuth
// apps and Document Intelligence are Enterprise inside the section
// (ServicesSection).
export const ENTERPRISE_ONLY_SECTIONS: ReadonlySet<string> = new Set(['email']);

// All known integration IDs + labels live in src/config/integrationCatalog.ts
// so the super-admin panel and the org Access screens use the same source.
// Categories (incl. Nextcloud) are rendered as-is; section order is
// controlled by orderCategories().
export const ALL_INTEGRATIONS = INTEGRATION_CATALOG;
