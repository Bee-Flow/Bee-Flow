import { Package, Building2, KeyRound, ShieldCheck, Tag, CreditCard, ScrollText } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { FEATURE_CATALOG } from '../../../shared/featureCatalog';

/** One section of the subscriptions console. */
export interface SubscriptionSection {
    id: string;
    label: string;
    icon: LucideIcon;
    accent: string;
}

/** The numeric plan limits. */
export type LimitKey = 'max_cost_per_month' | 'max_users' | 'max_agents' | 'max_knowledge_sources';

/** One numeric limit on a plan. */
export interface LimitFieldDef {
    key: LimitKey;
    label: string;
    type: 'currency' | 'number';
}

export const SECTIONS: SubscriptionSection[] = [
    { id: 'plans',         label: 'Plans',  icon: Package,     accent: 'blue' },
    { id: 'organizations', label: 'Orgs',   icon: Building2,   accent: 'sky' },
    { id: 'grants',        label: 'Grants', icon: KeyRound,    accent: 'cyan' },
    { id: 'access',        label: 'Access', icon: ShieldCheck, accent: 'amber' },
    { id: 'promos',        label: 'Promos', icon: Tag,         accent: 'emerald' },
    { id: 'settings',      label: 'Stripe', icon: CreditCard,  accent: 'blue' },
    { id: 'audit',         label: 'Audit',  icon: ScrollText,  accent: 'rose' },
];

// Re-exported from the shared, framework-free catalog so the admin plan
// editor and the marketing pricing block share one id→label source.
export const FEATURE_OPTIONS = FEATURE_CATALOG;

export const LIMIT_FIELDS: LimitFieldDef[] = [
    { key: 'max_cost_per_month',      label: 'Cost cap / month (€)',  type: 'currency' },
    { key: 'max_users',               label: 'Max users',             type: 'number' },
    { key: 'max_agents',              label: 'Max agents',            type: 'number' },
    { key: 'max_knowledge_sources',   label: 'Max knowledge sources', type: 'number' },
];

export const TIER_PRESETS: string[] = ['community', 'enterprise', 'full'];
export const EXPIRY_PRESETS: { label: string; days: number }[] = [
    { label: '30 days', days: 30 },
    { label: '90 days', days: 90 },
    { label: '1 year',  days: 365 },
    { label: '2 years', days: 730 },
];

export const CURRENCY_SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };
