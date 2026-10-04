/**
 * The template gallery of the Automations demo (Studio → Automations →
 * Templates): the organisation's own templates first (`source: 'org'`), then
 * the built-in ones, as GET /api/automation/templates answers.
 *
 * The built-in cards mirror the product's catalogue
 * (server/automation/templates.js): same ids, titles, categories and apps.
 * Their definitions here are a short sketch of the real ones, enough for
 * "Use template" to open a canvas with the right start and steps.
 */

import { daysAgo } from './common';
import { LOTTE, ME, SANNE } from './automationsPeople';

type Obj = Record<string, unknown>;
type StepSketch = [type: string, label: string];

interface Seed {
    id: string; title: string; description: string; category: string | null; icon: string;
    tags: string[]; requiredIntegrations: string[]; triggerReadiness: string;
    triggerKind: string; triggerApp: string | null; steps: StepSketch[];
}

const AI = 'ai_step';
const APP = 'integration_action';
const SEND = 'notification';

const BUILT_IN: Seed[] = [
    { id: 'nc-invoice-inbox', title: 'Invoice inbox', description: 'Email arrives with PDF attachment → extract metadata → upload to Nextcloud /Invoices folder.', category: 'Files', icon: 'FileText', tags: ['gmail', 'nextcloud', 'ai'], requiredIntegrations: ['gmail', 'nextcloud'], triggerReadiness: 'ready', triggerKind: 'app_event', triggerApp: 'gmail', steps: [[AI, 'Extract invoice details'], [APP, 'Upload to /Invoices']] },
    { id: 'nc-pdf-summarise', title: 'PDF summary', description: 'When a PDF lands anywhere under /Documents, summarise it and post a Talk message.', category: 'Files', icon: 'FileSearch', tags: ['nextcloud', 'ai', 'talk'], requiredIntegrations: ['nextcloud'], triggerReadiness: 'ready', triggerKind: 'app_event', triggerApp: 'nextcloud', steps: [[APP, 'Read the PDF'], [AI, 'Summarise it'], [SEND, 'Post in Talk']] },
    { id: 'nc-deck-to-nextcloud', title: 'Deck from a document', description: 'When a document lands under /Briefings, write a slide outline, build a PowerPoint in the house style and save it next to it in Nextcloud.', category: 'Files', icon: 'Presentation', tags: ['nextcloud', 'ai', 'presentation'], requiredIntegrations: ['nextcloud'], triggerReadiness: 'ready', triggerKind: 'app_event', triggerApp: 'nextcloud', steps: [[APP, 'Read the document'], [AI, 'Write a slide outline'], ['generate_document', 'Build the deck'], [APP, 'Save next to the document']] },
    { id: 'nc-form-intake', title: 'Form intake to table + PDF', description: 'Someone submits a Nextcloud Form → log the answers in a Table, generate a PDF summary, email it back and open a follow-up card.', category: 'Files', icon: 'ClipboardList', tags: ['nextcloud', 'forms', 'tables', 'ai', 'pdf'], requiredIntegrations: ['nextcloud'], triggerReadiness: 'ready', triggerKind: 'app_event', triggerApp: 'nextcloud', steps: [[APP, 'Add a row to the table'], [AI, 'Summarise the answers'], ['generate_document', 'Make the PDF'], [SEND, 'Email it back'], [APP, 'Open a follow-up card'], [SEND, 'Tell the team']] },
    { id: 'nc-meeting-prep', title: 'Meeting prep', description: '15 minutes before each calendar event → AI writes a short briefing referencing recent emails with attendees.', category: 'Calendar', icon: 'CalendarClock', tags: ['nextcloud', 'calendar', 'ai'], requiredIntegrations: ['nextcloud'], triggerReadiness: 'ready', triggerKind: 'app_event', triggerApp: 'nextcloud', steps: [[AI, 'Write the briefing'], [SEND, 'Send it to me']] },
    { id: 'nc-share-approval', title: 'External share approval', description: 'Someone shares a folder externally → AI judges sensitivity → ask owner to approve before the share goes live.', category: 'Governance', icon: 'ShieldCheck', tags: ['nextcloud', 'approval', 'ai'], requiredIntegrations: ['nextcloud'], triggerReadiness: 'push-pending', triggerKind: 'app_event', triggerApp: 'nextcloud', steps: [[AI, 'Judge the sensitivity'], ['approval', 'Ask the owner'], [APP, 'Keep or remove the share']] },
    { id: 'nc-mention-tracker', title: 'Mention digest', description: 'When @-mentioned in any Talk room, capture context and email a daily digest.', category: 'Talk', icon: 'MessageSquare', tags: ['nextcloud', 'talk', 'ai'], requiredIntegrations: ['nextcloud'], triggerReadiness: 'unsupported', triggerKind: 'app_event', triggerApp: 'nextcloud', steps: [[AI, 'Capture the context']] },
    { id: 'nc-deck-done-celebrate', title: 'Card moved to Done', description: 'When a Deck card moves into a Done stack → post a celebration in the linked Talk room.', category: 'Deck', icon: 'Trophy', tags: ['nextcloud', 'deck', 'talk'], requiredIntegrations: ['nextcloud'], triggerReadiness: 'ready', triggerKind: 'app_event', triggerApp: 'nextcloud', steps: [[SEND, 'Post in Talk']] },
    { id: 'nc-onboarding', title: 'New employee onboarding', description: 'When a user is added to a group → in parallel: create welcome folder, send Talk welcome, schedule intro meeting.', category: 'Cross-app', icon: 'UserPlus', tags: ['nextcloud', 'parallel'], requiredIntegrations: ['nextcloud'], triggerReadiness: 'ready', triggerKind: 'app_event', triggerApp: 'nextcloud', steps: [['parallel', 'Welcome the new colleague']] },
    { id: 'webpage-invoice-sync', title: 'Sync invoices to a webapp', description: 'New invoice email arrives → extract fields → append a row to your invoice webapp\'s data.db. Pick the webpage in Quick mode before activating.', category: 'Webpages', icon: 'Database', tags: ['gmail', 'webpages', 'ai'], requiredIntegrations: ['gmail', 'webpages'], triggerReadiness: 'ready', triggerKind: 'app_event', triggerApp: 'gmail', steps: [[AI, 'Extract the fields'], [APP, 'Append a row'], [SEND, 'Tell me']] },
    { id: 'nc-weekly-digest', title: 'Weekly Nextcloud digest', description: 'Every Monday 9am → AI summarises last week\'s file activity and posts to your default Talk room.', category: 'Cross-app', icon: 'Sparkles', tags: ['nextcloud', 'schedule', 'ai'], requiredIntegrations: ['nextcloud'], triggerReadiness: 'ready', triggerKind: 'schedule', triggerApp: null, steps: [[APP, 'Read last week\'s activity'], [AI, 'Summarise it'], [SEND, 'Post in Talk']] },
    { id: 'support-ticket-to-kb', title: 'Resolved tickets → knowledge base', description: 'When a support ticket is resolved (genuine customer conversations only) → AI distils a concise "problem + solution" article → saved to the chosen knowledge base with a source link back to the ticket.', category: 'Support', icon: 'BookOpen', tags: ['support', 'ai', 'knowledge-base'], requiredIntegrations: ['support'], triggerReadiness: 'ready', triggerKind: 'app_event', triggerApp: 'support', steps: [[AI, 'Distil the article'], [APP, 'Save to the knowledge base']] },
];

// The organisation's own: saved from automations with "Save as template".
const ORG: Array<Seed & { createdBy: string; createdByName: string; createdAt: string }> = [
    { id: 'org-demo-spend', title: 'Invoice spend summary', description: 'Totals a week of vendor invoices from the mailbox and sends finance one summary.', category: null, icon: 'Receipt', tags: [], requiredIntegrations: ['gmail'], triggerReadiness: 'ready', triggerKind: 'manual', triggerApp: null, createdBy: SANNE.id, createdByName: SANNE.name, createdAt: daysAgo(50), steps: [[APP, 'Search billing emails'], ['loop', 'Read each invoice'], ['aggregate', 'Sum totals per vendor'], ['summarize', 'Write the summary'], [SEND, 'Post to finance']] },
    { id: 'org-demo-intake', title: 'Client document intake', description: 'Sorts documents dropped in a client folder and asks the account manager before filing them.', category: null, icon: 'FolderInput', tags: [], requiredIntegrations: ['nextcloud'], triggerReadiness: 'ready', triggerKind: 'app_event', triggerApp: 'nextcloud', createdBy: LOTTE.id, createdByName: LOTTE.name, createdAt: daysAgo(9), steps: [[AI, 'Classify the document'], ['switch', 'Route by type'], ['approval', 'Ask the account manager']] },
    { id: 'org-demo-digest', title: 'Monday team digest', description: 'Every Monday morning: open actions, renewals coming up and last week\'s decisions in one email.', category: null, icon: 'Newspaper', tags: [], requiredIntegrations: [], triggerReadiness: 'ready', triggerKind: 'schedule', triggerApp: null, createdBy: ME.id, createdByName: ME.name, createdAt: daysAgo(2), steps: [[AI, 'Gather open actions'], [SEND, 'Email the team']] },
];

const CATEGORIES = ['Files', 'Calendar', 'Governance', 'Talk', 'Deck', 'Cross-app', 'Webpages', 'Support'];

function card(s: Seed & { createdBy?: string; createdByName?: string; createdAt?: string }, source: 'org' | 'builtin') {
    const { steps, ...rest } = s;
    return {
        ...rest,
        source,
        stepCount: steps.length,
        ...(source === 'org' ? { mine: s.createdBy === ME.id } : {}),
    };
}

/** A small, runnable-looking definition: the start, then the sketched steps in a line. */
function definitionOf(s: Seed): Obj {
    const trigger: Obj = { id: 'trg', kind: s.triggerKind, label: 'Start' };
    if (s.triggerKind === 'schedule') Object.assign(trigger, { cron: '0 9 * * 1', label: 'Mondays at 09:00' });
    if (s.triggerKind === 'app_event') Object.assign(trigger, { appEvent: { provider: s.triggerApp || 'nextcloud' } });
    const steps = s.steps.map(([type, label], i) => ({ id: `s${i + 1}`, type, label }));
    const ids = ['trg', ...steps.map(x => x.id)];
    return { trigger, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })) };
}

const all = () => [...ORG.map(s => card(s, 'org')), ...BUILT_IN.map(s => card(s, 'builtin'))];

type Ctx = { state: { orgTemplates?: Obj[] }; params: Record<string, string>; body: Obj | null };

export const TEMPLATE_ROUTES = {
    'GET /api/automation/templates': ({ state }: Ctx) => ({ templates: [...(state.orgTemplates || []), ...all()], categories: CATEGORIES }),
    'GET /api/automation/templates/:templateId': ({ state, params }: Ctx) => {
        const saved = (state.orgTemplates || []).find(t => t.id === params.templateId);
        if (saved) return { template: saved };
        const seed = [...ORG, ...BUILT_IN].find(t => t.id === params.templateId);
        if (!seed) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        return { template: { ...card(seed, ORG.includes(seed as typeof ORG[number]) ? 'org' : 'builtin'), definition: definitionOf(seed) } };
    },
};
