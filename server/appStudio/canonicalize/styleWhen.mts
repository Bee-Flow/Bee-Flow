/**
 * App Studio canonicalizer: node.styleWhen, a component's conditional style (package LK15).
 *
 * The list shape is componentSpecs/styleRuleShape.js. The knobs a rule may set are the look knobs
 * of STYLE_WHEN_KNOBS that the node's type has (its own list plus the groups it is granted), each
 * cleaned exactly as cleanStyle cleans the node's own style. canonicalize/nodes.js writes the key
 * only when a usable rule is left, so a node without it keeps its bytes.
 */

import { createRequire } from 'node:module';

type Push = (code: string, path: string, message: string) => void;
type RuleStyleCleaner = (style: unknown, path: string) => Record<string, unknown> | undefined;
type StyleRule = { when: { kind: 'formula'; expr: unknown }; style: Record<string, unknown> };
type Spec = { styleKnobs?: string[] };

const nodeRequire = createRequire(import.meta.url);
const { COMPONENT_SPECS, expandStyleKnobs, LIMITS } = nodeRequire('../componentSpecs.js') as {
    COMPONENT_SPECS: Record<string, Spec | undefined>;
    expandStyleKnobs: (knobs: unknown, groups?: unknown, type?: string) => string[];
    LIMITS: Record<string, number>;
};
const { cleanStyle } = nodeRequire('./style.js') as {
    cleanStyle: (raw: unknown, allowed: string[], defaults: Record<string, unknown>, path: string, push: Push) => Record<string, unknown>;
};
const { STYLE_WHEN_KNOBS, cleanRuleList } = nodeRequire('../componentSpecs/styleRuleShape.js') as {
    STYLE_WHEN_KNOBS: readonly string[];
    cleanRuleList: (raw: unknown, path: string, push: Push, opts: { max: number; label: string; cleanStyle: RuleStyleCleaner }) => StyleRule[] | undefined;
};

/** The knobs a styleWhen rule on a node of `type` may set (empty for an unknown type). */
export function styleWhenKnobs(type: unknown): string[] {
    const spec = typeof type === 'string' ? COMPONENT_SPECS[type] : undefined;
    if (!spec) return [];
    const own = expandStyleKnobs(spec.styleKnobs, undefined, type as string);
    return STYLE_WHEN_KNOBS.filter((knob) => own.includes(knob));
}

/** node.styleWhen as stored, or undefined to leave the key out. */
export function cleanStyleWhen(raw: unknown, type: unknown, path: string, push: Push): StyleRule[] | undefined {
    const allowed = styleWhenKnobs(type);
    if (!allowed.length) {
        push('style_rules.invalid', path, `A ${String(type)} has no look knob a styleWhen rule may set — dropped.`);
        return undefined;
    }
    const cleanRuleStyle: RuleStyleCleaner = (style, at) => {
        if (style === null || typeof style !== 'object' || Array.isArray(style)) return undefined;
        return cleanStyle(style, allowed, {}, at, push);
    };
    return cleanRuleList(raw, path, push, { max: LIMITS.MAX_STYLE_WHEN_RULES, label: 'styleWhen', cleanStyle: cleanRuleStyle });
}
