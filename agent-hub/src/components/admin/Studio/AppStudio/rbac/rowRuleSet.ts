import { buildRowRule, parseRowRule } from './rowRuleModel';
import type { RuleDraft } from './RowRuleEditor.types';
import type { RuleTable } from './rowRuleModel.types';

/**
 * App Studio RBAC: what `access.rowFilters[role]` holds, as the editor works on it.
 *
 * The server stores ONE rule (a string) that narrows seeing, changing and
 * deleting alike, or an object `{ read?, update?, delete? }` with a rule per
 * action; an action it leaves out has no row rule. This module is the bridge
 * between that stored value and the editor's drafts:
 *
 *   seedRuleSet(stored, table) → the drafts (one, or one per action)
 *   storedRule(set)            → what to write back (a string, an object, or null for "no rule")
 *
 * A stored value this editor cannot show (an expression tree instead of text,
 * an object with other keys) is never rewritten: `kept` is true and storedRule
 * answers undefined, which means "leave the stored rule alone".
 */

export const RULE_ACTIONS = ['read', 'update', 'delete'] as const;
export type RuleAction = typeof RULE_ACTIONS[number];
/** The draft being edited: the one rule, or the rule of one action. */
export type RuleSlot = 'all' | RuleAction;
export type PerActionRules = Partial<Record<RuleAction, string>>;

export interface RuleSet {
    /** A rule per action instead of one rule for all three. */
    perAction: boolean;
    /** The stored value could not be read; it stays as it is. */
    kept: boolean;
    all: RuleDraft;
    read: RuleDraft;
    update: RuleDraft;
    delete: RuleDraft;
}

export function seedDraft(rule: string, table: RuleTable | null): RuleDraft {
    const parsed = parseRowRule(rule, table);
    return parsed.ok
        ? { mode: 'build', join: parsed.join, conditions: parsed.conditions, raw: rule }
        : { mode: 'raw', join: 'and', conditions: [], raw: rule };
}

export function draftToRule(draft: RuleDraft): string {
    return draft.mode === 'raw' ? draft.raw : buildRowRule(draft);
}

const isRuleAction = (key: string): key is RuleAction => (RULE_ACTIONS as readonly string[]).includes(key);

/** A stored per-action object the editor can show: only action keys, only text. */
function readPerAction(stored: unknown): PerActionRules | null {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
    const out: PerActionRules = {};
    for (const [key, value] of Object.entries(stored)) {
        if (!isRuleAction(key) || typeof value !== 'string') return null;
        out[key] = value;
    }
    return out;
}

/** The editor's drafts for one stored `rowFilters[role]` value. */
export function seedRuleSet(stored: unknown, table: RuleTable | null): RuleSet {
    const empty = () => seedDraft('', table);
    if (typeof stored === 'string' || stored == null) {
        return { perAction: false, kept: false, all: seedDraft(typeof stored === 'string' ? stored : '', table), read: empty(), update: empty(), delete: empty() };
    }
    const rules = readPerAction(stored);
    if (!rules) return { perAction: false, kept: true, all: empty(), read: empty(), update: empty(), delete: empty() };
    return {
        perAction: true,
        kept: false,
        all: empty(),
        read: seedDraft(rules.read ?? '', table),
        update: seedDraft(rules.update ?? '', table),
        delete: seedDraft(rules.delete ?? '', table),
    };
}

/** The drafts that count for what gets saved. */
export function activeSlots(set: RuleSet): RuleSlot[] {
    return set.perAction ? [...RULE_ACTIONS] : ['all'];
}

/**
 * What to write to `rowFilters[role]`: the one rule, the rules per action that
 * are not empty, or null when there is none. undefined: leave the stored rule
 * alone (see `kept`).
 */
export function storedRule(set: RuleSet): string | PerActionRules | null | undefined {
    if (set.kept) return undefined;
    if (!set.perAction) return draftToRule(set.all).trim() || null;
    const out: PerActionRules = {};
    for (const action of RULE_ACTIONS) {
        const rule = draftToRule(set[action]).trim();
        if (rule) out[action] = rule;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Switch between one rule and a rule per action without changing what the
 * rule does at that moment. One rule becomes the same rule for each action
 * (that is what one rule means). Going back keeps the rule of `from`, the
 * action on screen: the other two are dropped, and the editor says which
 * rule it kept by showing it.
 */
export function withPerAction(set: RuleSet, perAction: boolean, table: RuleTable | null, from: RuleAction = 'read'): RuleSet {
    if (perAction === set.perAction) return set;
    if (perAction) {
        const rule = draftToRule(set.all);
        return { ...set, perAction: true, kept: false, read: seedDraft(rule, table), update: seedDraft(rule, table), delete: seedDraft(rule, table) };
    }
    return { ...set, perAction: false, kept: false, all: seedDraft(draftToRule(set[from]), table) };
}
