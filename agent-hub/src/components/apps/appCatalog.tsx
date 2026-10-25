/**
 * The apps catalogue behind the composer's Apps picker.
 *
 * Which apps exist, which of them this user can actually reach, and what
 * typing one into the box should seed. Pure — no state, no fetches — so the
 * chat composer and the Cowork composer can both build the same list from
 * whatever integration status they happen to hold.
 *
 * It used to live as an IIFE inside InputArea's JSX, which is why the Cowork
 * page simply didn't have an Apps picker: there was nothing to reuse.
 */
import React from 'react';
import type { ReactNode } from 'react';
import { Box as BoxIcon } from 'lucide-react';
import { getIntegrationGlyph, renderIntegrationGlyph } from '../../utils/integrationGlyphs';
import { getIntegrationLogo } from '../../utils/integrationLogos';
import { StepIcon } from '../automation/Builder/flow/stepIcons';
import type { IntegrationStatus } from '../../api/queries/integrationStatus';

/** One entry of the catalogue, from APP_DEFS or built from a workspace source. */
export interface AppDef {
    id: string;
    label: string;
    description: string;
    iconSvg: (s?: string) => ReactNode;
    requiresGoogle?: boolean;
    requiresMicrosoft?: boolean;
    requiresFireflies?: boolean;
    requiresYouTrack?: boolean;
    requiresGamma?: boolean;
    requiresAfas?: boolean;
    requiresNmbrs?: boolean;
    requiresNone?: boolean;
    isN8n?: boolean;
    isMcp?: boolean;
    isStep?: boolean;
    mcpConfigured?: boolean;
    stepId?: string;
    stepCategory?: string;
}

export type { McpServerSource } from '../../api/queries/coreAppsCatalog';
import type { ExposedStepSource, McpServerSource, N8nWorkflowSource } from '../../api/queries/coreAppsCatalog';

export interface AppCatalogSources {
    n8nWorkflows?: N8nWorkflowSource[];
    mcpServers?: McpServerSource[];
    exposedSteps?: ExposedStepSource[];
}

export interface AppAvailabilityGates {
    integrationStatus?: IntegrationStatus;
    orgEnabledIntegrations?: string[] | null;
    agentIntegrations?: string[] | null;
}

// Tailwind w-N h-N → pixel dimensions for the iconSvg callers
// (Tailwind defaults: w-4=16, w-5=20, w-6=24).
const TW_SIZE_TO_PX: Record<string, number> = { 'w-4 h-4': 16, 'w-5 h-5': 20, 'w-6 h-6': 24 };

function renderAppLogo(id: string, sizeClass = 'w-5 h-5'): React.ReactElement {
    const px = TW_SIZE_TO_PX[sizeClass] || 20;
    // Same order as the builder's <IntegrationLogo>: an app's own glyph
    // (a Nextcloud app) before the shared brand SVG.
    const glyph = getIntegrationGlyph(id);
    if (glyph) return renderIntegrationGlyph(glyph, px, { className: sizeClass });
    const Logo = getIntegrationLogo(id);
    if (Logo) return <Logo size={px} className={sizeClass} />;
    // Fallback: a brand-coloured letter mark would also work but the
    // shared logos cover every catalog id today, so this branch is only
    // hit if an entry below references an id we haven't authored yet.
    return <span className={`${sizeClass} flex items-center justify-center text-base`}>•</span>;
}

// Each entry's iconSvg is a thin wrapper around the shared INTEGRATION_LOGOS
// map so the composer and the automation palette always render the same
// brand mark.
export const APP_DEFS: AppDef[] = [
    { id: 'google-drive',    label: 'Google Drive',    description: 'Attach files from Drive',                requiresGoogle: true,    iconSvg: (s = 'w-5 h-5') => renderAppLogo('google-drive', s) },
    { id: 'gmail',           label: 'Gmail',           description: 'Attach emails',                          requiresGoogle: true,    iconSvg: (s = 'w-5 h-5') => renderAppLogo('gmail', s) },
    { id: 'google-calendar', label: 'Google Calendar', description: 'Ask about your schedule',                requiresGoogle: true,    iconSvg: (s = 'w-5 h-5') => renderAppLogo('google-calendar', s) },
    { id: 'google-slides',   label: 'Google Slides',   description: 'Ask about presentations',                requiresGoogle: true,    iconSvg: (s = 'w-5 h-5') => renderAppLogo('google-slides', s) },
    { id: 'google-sheets',   label: 'Google Sheets',   description: 'Create & edit spreadsheets',             requiresGoogle: true,    iconSvg: (s = 'w-5 h-5') => renderAppLogo('google-sheets', s) },
    { id: 'google-docs',     label: 'Google Docs',     description: 'Create & read documents',                requiresGoogle: true,    iconSvg: (s = 'w-5 h-5') => renderAppLogo('google-docs', s) },
    { id: 'google-contacts', label: 'Google Contacts', description: 'Search, create & update contacts',       requiresGoogle: true,    iconSvg: (s = 'w-5 h-5') => renderAppLogo('google-contacts', s) },
    { id: 'google-keep',     label: 'Google Keep',     description: 'List, create & delete notes',            requiresGoogle: true,    iconSvg: (s = 'w-5 h-5') => renderAppLogo('google-keep', s) },
    { id: 'outlook',         label: 'Outlook',         description: 'Send & read emails',                     requiresMicrosoft: true, iconSvg: (s = 'w-5 h-5') => renderAppLogo('outlook', s) },
    { id: 'outlook-readonly', label: 'Outlook Read-Only', description: 'Search and read emails',              requiresMicrosoft: true, iconSvg: (s = 'w-5 h-5') => renderAppLogo('outlook-readonly', s) },
    { id: 'ms-calendar',     label: 'MS Calendar',     description: 'Manage your schedule',                   requiresMicrosoft: true, iconSvg: (s = 'w-5 h-5') => renderAppLogo('ms-calendar', s) },
    { id: 'onedrive',        label: 'OneDrive',        description: 'Access files & folders',                 requiresMicrosoft: true, iconSvg: (s = 'w-5 h-5') => renderAppLogo('onedrive', s) },
    { id: 'ms-contacts',     label: 'MS Contacts',     description: 'Search & manage contacts',               requiresMicrosoft: true, iconSvg: (s = 'w-5 h-5') => renderAppLogo('ms-contacts', s) },
    { id: 'fireflies',       label: 'Fireflies.ai',    description: 'Meeting transcripts',                    requiresFireflies: true, iconSvg: (s = 'w-5 h-5') => renderAppLogo('fireflies', s) },
    { id: 'youtrack',        label: 'YouTrack',        description: 'Issues and projects',                    requiresYouTrack: true,  iconSvg: (s = 'w-5 h-5') => renderAppLogo('youtrack', s) },
    { id: 'gamma',           label: 'Gamma',           description: 'AI presentations',                       requiresGamma: true,     iconSvg: (s = 'w-5 h-5') => renderAppLogo('gamma', s) },
    { id: 'afas-profit',     label: 'AFAS Profit',     description: 'Query AFAS data (read-only)',            requiresAfas: true,      iconSvg: (s = 'w-5 h-5') => renderAppLogo('afas-profit', s) },
    { id: 'nmbrs',           label: 'NMBRS',           description: 'Read payroll & HR data (read-only)',     requiresNmbrs: true,     iconSvg: (s = 'w-5 h-5') => renderAppLogo('nmbrs', s) },
    { id: 'web-search',      label: 'Web Search',      description: 'Search the web',                         requiresNone: true,      iconSvg: (s = 'w-5 h-5') => renderAppLogo('web-search', s) },
    { id: 'google-maps',     label: 'Google Maps',     description: 'Directions, routes & places',            requiresNone: true,      iconSvg: (s = 'w-5 h-5') => renderAppLogo('google-maps', s) },
    { id: 'image-gen',       label: 'Image Generation', description: 'AI image creation settings',            requiresNone: true,      iconSvg: (s = 'w-5 h-5') => renderAppLogo('image-gen', s) },
    { id: 'elevenlabs',      label: 'ElevenLabs',      description: 'Music with vocals, TTS & sound effects', requiresNone: true,      iconSvg: (s = 'w-5 h-5') => renderAppLogo('elevenlabs', s) },
];

/**
 * The static catalogue plus everything this workspace added itself: n8n
 * workflows, connected MCP servers and Reusable Steps the user exposed to
 * chat. Each is normalised into the same shape as an APP_DEFS entry.
 */
export function buildAppCatalog({ n8nWorkflows = [], mcpServers = [], exposedSteps = [] }: AppCatalogSources = {}): AppDef[] {
    const n8nAppDefs: AppDef[] = n8nWorkflows.map(wf => ({
        id: `n8n_run_${wf.slug}`,
        label: wf.name,
        description: wf.description || 'n8n workflow',
        iconSvg: (s = 'w-5 h-5') => <img src="/n8n-color.png" alt="n8n" className={`${s} object-contain`} />,
        isN8n: true,
    }));
    const mcpAppDefs: AppDef[] = mcpServers.map(srv => ({
        id: `mcp_${srv.id}`,
        label: srv.name,
        description: `${srv.toolCount} tools available${srv.allConfigured ? '' : ' — credentials needed'}`,
        iconSvg: (s = 'w-5 h-5') => <span className={`${s} flex items-center justify-center text-base`}>{srv.icon || '🔌'}</span>,
        isMcp: true,
        mcpConfigured: srv.allConfigured,
        requiresNone: false,
    }));
    const stepAppDefs: AppDef[] = exposedSteps.map(s => ({
        id: `step_${s.id}`,
        stepId: s.id,
        label: s.title || 'Step',
        description: s.description || 'Reusable Step',
        stepCategory: (s.category && s.category.trim()) || 'Steps',
        iconSvg: (sz = 'w-5 h-5') => (
            <span className={`${sz} flex items-center justify-center text-[var(--text-secondary)]`}>
                <StepIcon name={s.icon} size={18} fallback={<BoxIcon size={18} />} />
            </span>
        ),
        isStep: true,
        requiresNone: false,
    }));
    return [...APP_DEFS, ...n8nAppDefs, ...mcpAppDefs, ...stepAppDefs];
}

/**
 * Narrow the catalogue to what this user can actually reach: their own
 * connected accounts, then the org's allow-list, then — in agent chat only —
 * the agent's own integration list.
 *
 * `agentIntegrations` is undefined outside agent chat (the Cowork page never
 * has one), which correctly means "no agent-level filter".
 */
export function filterAvailableApps(apps: AppDef[], {
    integrationStatus = {},
    orgEnabledIntegrations = null,
    agentIntegrations = null,
}: AppAvailabilityGates = {}): AppDef[] {
    const {
        isGoogleUser, isMicrosoftUser, hasMicrosoftConnection, hasFirefliesKey, hasYouTrackConfig,
        hasGammaKey, hasAfasConfig, hasNmbrsConfig,
    } = integrationStatus;

    return apps.filter(app => {
        // Reusable Steps are gated by the Step's own "In chat" toggle
        // (server-side); always show the ones the user exposed.
        if (app.isStep) return true;
        // Base availability checks
        if (app.requiresGoogle && !isGoogleUser) return false;
        // Outlook also works off a Microsoft 365 connection next to another
        // login (server lifts only the Outlook tools off that credential).
        if (app.requiresMicrosoft && !isMicrosoftUser
            && !(hasMicrosoftConnection && (app.id === 'outlook' || app.id === 'outlook-readonly'))) return false;
        if (app.requiresFireflies && !hasFirefliesKey) return false;
        if (app.requiresYouTrack && !hasYouTrackConfig) return false;
        if (app.requiresGamma && !hasGammaKey) return false;
        if (app.requiresAfas && !hasAfasConfig) return false;
        if (app.requiresNmbrs && !hasNmbrsConfig) return false;
        // Org-level gating — gate ALL apps (matching backend ORG_EXEMPT_APPS logic)
        if (orgEnabledIntegrations) {
            if (app.isMcp) {
                // MCP servers use mcp:{serverId} format in enabledIntegrations
                const mcpId = `mcp:${app.id.replace(/^mcp_/, '')}`;
                if (!orgEnabledIntegrations.includes(mcpId)) return false;
            } else if (app.isN8n) {
                if (!orgEnabledIntegrations.includes('n8n')) return false;
            } else if (!app.requiresNone) {
                // All standard apps (Google, Microsoft, AI, third-party)
                if (!orgEnabledIntegrations.includes(app.id)) return false;
            }
        }
        if (app.requiresNone) return false;
        // Agent-level integration filtering (MCP apps bypass — they're globally available)
        if (agentIntegrations && !app.isMcp) {
            if (app.isN8n) return agentIntegrations.includes('n8n');
            return agentIntegrations.includes(app.id);
        }
        return true;
    });
}

// Which section of the overlay an app lands in.
function appCategory(app: AppDef): string {
    if (app.isStep) return app.stepCategory || 'Steps';
    if (app.isMcp) return 'MCP servers';
    if (app.isN8n) return 'n8n';
    if (app.requiresGoogle) return 'Google';
    if (app.requiresMicrosoft) return 'Microsoft';
    return 'Other';
}

// Fixed priority for the integration buckets; step categories (priority 50)
// sort alphabetically between them and MCP/n8n.
const CAT_PRIORITY: Record<string, number> = { Google: 0, Microsoft: 1, Other: 2, 'MCP servers': 100, n8n: 101 };

export function groupAppsByCategory(apps: AppDef[]): { byCat: Record<string, AppDef[]>; orderedCats: string[] } {
    const byCat: Record<string, AppDef[]> = {};
    for (const app of apps) {
        const c = appCategory(app);
        (byCat[c] = byCat[c] || []).push(app);
    }
    const orderedCats = Object.keys(byCat).sort((a, b) => {
        const pa = CAT_PRIORITY[a] ?? 50;
        const pb = CAT_PRIORITY[b] ?? 50;
        return pa !== pb ? pa - pb : a.localeCompare(b);
    });
    return { byCat, orderedCats };
}

const SEED_TEXT: Record<string, string> = {
    // Drive and Gmail open an attachment picker in chat — the host intercepts
    // those two before asking for seed text. Here they get the wording a
    // Cowork brief needs, where attaching a file means nothing.
    'google-drive': 'List my recent Drive files',
    gmail: 'Show my recent emails',
    'google-calendar': "What's on my calendar this week?",
    'google-slides': 'List my recent presentations',
    'google-sheets': 'List my Google Sheets spreadsheets',
    'google-docs': 'List my recent Google Docs documents',
    'google-contacts': 'Search my contacts for ',
    'google-keep': 'List my Google Keep notes',
    fireflies: 'List my recent meeting transcripts',
    youtrack: 'Search my YouTrack issues',
    gamma: 'Create a presentation about ',
    'afas-profit': 'Which AFAS data can you access?',
    nmbrs: 'List my NMBRS companies',
    outlook: 'Show my recent Outlook emails',
    'outlook-readonly': 'Show my recent Outlook emails',
    'ms-calendar': "What's on my calendar this week?",
    onedrive: 'List my OneDrive files',
    'ms-contacts': 'Search my contacts for ',
};

/**
 * What picking an app should put in the box. Returns null when there is
 * nothing sensible to type, so the caller can leave the input alone.
 */
export function seedTextForApp(app?: AppDef | null): string | null {
    if (!app) return null;
    if (SEED_TEXT[app.id]) return SEED_TEXT[app.id];
    if (app.isN8n) return `Run the ${app.label} workflow `;
    if (app.isMcp) return `Use ${app.label} to `;
    if (app.isStep) return `Use the "${app.label}" step to `;
    return null;
}
