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

export const INPUT = 'px-3 py-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-[13px] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--accent-primary)]';
export const SECONDARY_BUTTON = 'px-3 py-1.5 rounded-lg text-[12px] font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]';
export const PANEL = 'rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4';
export const PANEL_TITLE = 'text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3';
export const EMPTY_NOTE = 'text-center py-8 text-sm text-[var(--text-tertiary)] border border-dashed border-[var(--border-default)] rounded-lg';
