/**
 * The organisation's settings sections (features/org model/sections.ts, the
 * web's order), and the screens under them. Gated like the org index: the
 * org-admin sections for org admins, Compliance for `admin_compliance`.
 * Invitations is org-admin only: the invitation routes check the org-admin
 * predicate, which `manage_users` alone does not pass. Access & features is
 * listed here though the index no longer has a row for it: it opens from
 * Users & Groups.
 */

import type { Gate } from '@/core/access';

import type { Destination } from '../types';

const ADMIN: Gate = { orgAdmin: true };

/** A row; `text` is [label, hint], the label being the web's English where there is a key. */
function row({ text, ...rest }: Omit<Destination, 'label' | 'hint' | 'group'> & { text: [string, string] }): Destination {
    return { ...rest, label: text[0], hint: text[1], group: 'Organisation' };
}

export const ORG_SETTINGS: Destination[] = [
    row({ id: 'org-billing', i18nKey: 'settings.license_usage', text: ['License & Usage', 'Your plan, seats, invoices and payment'], icon: 'CreditCard', href: '/org/billing', gate: ADMIN, keywords: ['subscription', 'stripe', 'plan', 'billing', 'upgrade'] }),
    row({ id: 'org-billing-plans', text: ['Plans', 'Compare plans and change yours'], icon: 'Wallet', href: '/org/billing/plans', gate: ADMIN, keywords: ['upgrade', 'downgrade', 'pricing'] }),
    row({ id: 'org-billing-invoices', text: ['Invoices', 'Past invoices, as PDF'], icon: 'Receipt', href: '/org/billing/invoices', gate: ADMIN, keywords: ['receipt', 'pdf', 'payment'] }),
    row({ id: 'org-sign-in', i18nKey: 'settings.signin_method', text: ['Sign-in Method', 'How your members sign in, and which domains join'], icon: 'KeyRound', href: '/org/sign-in', gate: ADMIN, keywords: ['sso', 'google', 'microsoft', 'password', 'domain'] }),
    row({ id: 'org-shield', i18nKey: 'settings.privacy_shield', text: ['Privacy Shield', 'What the organisation detects, redacts and blocks'], icon: 'Shield', href: '/org/shield', gate: ADMIN, keywords: ['pii', 'dlp', 'gdpr', 'redaction', 'guardrails'] }),
    row({ id: 'org-encryption', i18nKey: 'settings.encryption', text: ['Encryption', 'How your organisation’s content is encrypted'], icon: 'Lock', href: '/org/encryption', gate: ADMIN, keywords: ['zero knowledge', 'managed', 'keys'] }),
    row({ id: 'org-ai-context', i18nKey: 'settings.ai_context', text: ['Conversation Memory', 'Conversation memory and compaction'], icon: 'Brain', href: '/org/ai-context', gate: ADMIN, keywords: ['compaction', 'memory', 'context window'] }),
    row({ id: 'org-integration-cache', i18nKey: 'settings.integration_cache', text: ['Answer Reuse', 'Cache integration answers, and purge them'], icon: 'DatabaseZap', href: '/org/integration-cache', gate: ADMIN, keywords: ['ttl', 'purge', 'cache'] }),
    row({ id: 'org-info', i18nKey: 'settings.org_info', text: ['Organisation Info', 'Name, logo, contact and billing details, language'], icon: 'Info', href: '/org/info', gate: ADMIN, keywords: ['logo', 'address', 'kvk', 'vat', 'language'] }),
    row({ id: 'org-usage', i18nKey: 'settings.usage_monitoring', text: ['Usage & Monitoring', 'Who used what, which models, feedback and terminations'], icon: 'BarChart3', href: '/org/usage', gate: ADMIN, keywords: ['reports', 'monitoring', 'tokens', 'cost', 'feedback'] }),
    row({ id: 'org-compliance', i18nKey: 'settings.compliance', text: ['Compliance', 'Frameworks, risks, incidents, DPIAs and data requests'], icon: 'Scale', href: '/org/compliance', gate: { perms: ['admin_compliance'], can: 'compliance_hub_gdpr' }, keywords: ['iso', 'ai act', 'dsr', 'ropa', 'dpia', 'audit', 'gdpr'] }),
    row({ id: 'org-people', i18nKey: 'settings.users_groups', text: ['Users & Groups', 'Members, invitations, groups, roles and model tiers'], icon: 'Users', href: '/org/people', gate: { anyPerms: ['org_admin', 'manage_users'] }, keywords: ['invite', 'approve', 'people'] }),
    row({ id: 'org-invitations', text: ['Invitations', 'Invite people and revoke open invitations'], icon: 'UserPlus', href: '/org/invitations', gate: ADMIN, keywords: ['invite', 'email'] }),
    row({ id: 'org-groups', text: ['Groups', 'Groups, their members, roles and model tiers'], icon: 'Users', href: '/org/groups', gate: ADMIN, keywords: ['team', 'department'] }),
    row({ id: 'org-roles', text: ['Roles & permissions', 'What each organisation role may do'], icon: 'BadgeCheck', href: '/org/roles', gate: ADMIN, keywords: ['permissions', 'rbac', 'dpo'] }),
    row({ id: 'org-model-tiers', text: ['Model tiers', 'The organisation’s own model tiers'], icon: 'Cpu', href: '/org/model-tiers', gate: ADMIN, keywords: ['models', 'llm', 'provider'] }),
    row({ id: 'org-academy', i18nKey: 'settings.academy', text: ['Academy', 'How your members are doing in the Learning Center'], icon: 'GraduationCap', href: '/org/academy', gate: { orgAdmin: true, can: 'learning_center' }, keywords: ['learning', 'training', 'courses'] }),
    row({ id: 'org-integrations', text: ['Organisation integrations', 'Which integrations the organisation offers, and their settings'], icon: 'Link2', href: '/org/integrations', gate: ADMIN, keywords: ['maps', 'nextcloud', 'n8n', 'beta'] }),
    row({ id: 'org-integrations-nextcloud', text: ['Nextcloud integrations', 'Which Nextcloud apps the organisation offers, and to which groups'], icon: 'Cloud', href: '/org/integrations/nextcloud', gate: ADMIN, keywords: ['files', 'calendar', 'deck', 'talk'] }),
    row({ id: 'org-n8n', text: ['n8n', 'The organisation’s n8n connection and workflows'], icon: 'Webhook', href: '/org/n8n', gate: ADMIN, keywords: ['workflows', 'automation'] }),
    row({ id: 'org-github-sync', i18nKey: 'settings.github_sync', text: ['GitHub Sync', 'Sync the organisation’s content to a repository'], icon: 'FolderGit2', href: '/org/github-sync', gate: ADMIN, keywords: ['git', 'repository', 'backup'] }),
    row({ id: 'org-nextcloud', i18nKey: 'settings.nextcloud_sync', text: ['Nextcloud Sync', 'Users and groups from Nextcloud, pairing and meeting notes'], icon: 'Cloud', href: '/org/nextcloud', gate: ADMIN, keywords: ['talk', 'pairing', 'sync'] }),
    row({ id: 'org-nextcloud-pairing', text: ['Pair a new Nextcloud', 'One-time codes that connect a Nextcloud instance'], icon: 'Link', href: '/org/nextcloud/pairing', gate: ADMIN, keywords: ['pairing code', 'occ', 'instance'] }),
    row({ id: 'org-nextcloud-talk', text: ['Talk Meeting Notes', 'Notes of Nextcloud Talk calls: bot, language and summary'], icon: 'MessageSquare', href: '/org/nextcloud/talk', gate: { orgAdmin: true, license: 'meeting_notes' }, keywords: ['talk', 'transcription', 'minutes'] }),
    row({ id: 'org-nextcloud-meet', text: ['Google Meet Meeting Notes', 'Notes of Google Meet calls: language and summary'], icon: 'Video', href: '/org/nextcloud/meet', gate: { orgAdmin: true, license: 'meeting_notes' }, keywords: ['google meet', 'transcription', 'minutes'] }),
    row({ id: 'org-meeting-templates', i18nKey: 'settings.meeting_templates', text: ['Meeting templates', 'Summary templates for the organisation and its groups'], icon: 'FileText', href: '/org/meeting-templates', gate: ADMIN, keywords: ['summary', 'notes', 'recording'] }),
    row({ id: 'org-azure', i18nKey: 'settings.azure_config', text: ['Azure Configuration', 'Azure OpenAI, document processing and sign-in'], icon: 'Cloud', href: '/org/azure', gate: ADMIN, keywords: ['microsoft', 'entra', 'openai'] }),
    row({ id: 'org-azure-openai', text: ['Azure OpenAI Service', 'Endpoint, API key, version and deployed models'], icon: 'Cloud', href: '/org/azure/openai', gate: ADMIN, keywords: ['azure', 'openai', 'deployment'] }),
    row({ id: 'org-azure-models', text: ['Chat Model Tiers', 'Which Azure deployment each chat tier uses'], icon: 'Cpu', href: '/org/azure/models', gate: ADMIN, keywords: ['azure', 'tiers', 'reasoning'] }),
    row({ id: 'org-azure-documents', text: ['Azure Document Processing', 'Document Intelligence and embeddings for knowledge bases'], icon: 'FileText', href: '/org/azure/documents', gate: ADMIN, keywords: ['azure', 'ocr', 'embeddings'] }),
    row({ id: 'org-azure-sso', text: ['Microsoft / Azure AD SSO', 'Microsoft sign-in and Azure AD group sync'], icon: 'KeyRound', href: '/org/azure/sso', gate: ADMIN, keywords: ['microsoft', 'entra', 'sso', 'group sync'] }),
    row({ id: 'org-theme', text: ['Organisation theme', 'Colours, corners and font for everyone in the organisation'], icon: 'Palette', href: '/org/theme', gate: ADMIN, keywords: ['branding', 'accent', 'colour', 'icons'] }),
    row({ id: 'org-access', text: ['Access & features', 'Which features and integrations each group may use'], icon: 'KeySquare', href: '/org/access', gate: ADMIN, keywords: ['grants', 'capabilities', 'ceiling', 'beta'] }),
    row({ id: 'org-knowledge-bases', text: ['System knowledge bases', 'The built-in knowledge bases, switched on for the organisation'], icon: 'Library', href: '/org/knowledge-bases', gate: ADMIN, keywords: ['kb', 'beta'] }),
];
