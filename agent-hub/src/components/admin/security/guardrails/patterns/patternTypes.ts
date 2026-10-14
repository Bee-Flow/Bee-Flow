/** One regex rule of the server-wide pattern library. */
export interface RegexRule {
    id: string;
    name: string;
    pattern: string;
}

/** A named group of rules that an organisation can bind. */
export interface RuleCollection {
    id: string;
    name: string;
    ruleIds: string[];
}

/** The library as the hub holds it; every edit here only stages, Save persists. */
export interface PatternLibraryProps {
    rules: RegexRule[];
    setRules: (rules: RegexRule[]) => void;
    collections: RuleCollection[];
    setCollections: (collections: RuleCollection[]) => void;
}

export const INPUT = 'px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm';
export const SECONDARY_BUTTON = 'px-4 py-2 rounded-lg text-sm font-medium border border-[var(--border-default)] text-[var(--accent-primary)] hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]';
export const PANEL = 'rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5';
export const PANEL_TITLE = 'text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3';
export const EMPTY_NOTE = 'text-center py-8 text-sm text-[var(--text-tertiary)] border-2 border-dashed border-white/5 rounded-lg';
