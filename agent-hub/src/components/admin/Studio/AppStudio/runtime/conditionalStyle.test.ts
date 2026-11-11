import { describe, expect, it } from 'vitest';
import { applyStyleWhen, cellRuleStyle, matchedRuleStyle } from './conditionalStyle';
import type { AppNode } from '../inspector/appDefinition';

const rule = (expr: string, style: Record<string, unknown>) => ({ when: { kind: 'formula', expr }, style });
const BASE = Object.freeze({ borderColor: 'var(--border-default)' });

describe('conditional style', () => {
    it('lays the rules that hold over the style in order, a later match winning', () => {
        const node = { id: 'n', type: 'stat', style: { span: 6, color: 'neutral' }, styleWhen: [
            rule('vars.n > 1', { color: 'warning', shadow: 'sm' }),
            rule('vars.n > 5', { color: 'danger' }),
            rule('vars.n > 50', { opacity: 50 }),
        ] } as AppNode;
        const out = applyStyleWhen(node, { vars: { n: 9 } });
        expect(out.node.style).toEqual({ span: 6, color: 'danger', shadow: 'sm' });
        expect(out.error).toBeNull();
        expect(node.style).toEqual({ span: 6, color: 'neutral' });
    });

    it('returns the same node without rules or without a match, and reports a failing formula', () => {
        const plain = { id: 'n', type: 'stat', style: { span: 6 } } as AppNode;
        expect(applyStyleWhen(plain, {}).node).toBe(plain);
        const failing = { ...plain, styleWhen: [rule('vars.n >', { color: 'danger' }), rule('false', { color: 'info' })] } as AppNode;
        const out = applyStyleWhen(failing, { vars: {} });
        expect(out.node).toBe(failing);
        expect(out.error).toBeTruthy();
    });

    it('accepts a bare expression string and skips a rule without style', () => {
        expect(matchedRuleStyle([{ when: 'true', style: { color: 'info' } }, { when: 'true' }, null], {}).style).toEqual({ color: 'info' });
    });

    it('cellRuleStyle reads item and value, keeps the base without a match, and maps the three knobs', () => {
        const rules = [rule("item.status == 'late'", { color: 'danger', weight: 'bold' }), rule('value == 0', { backgroundColor: 'warning' })];
        expect(cellRuleStyle(rules, {}, { status: 'ok' }, 4, BASE)).toBe(BASE);
        expect(cellRuleStyle(undefined, {}, {}, 0, BASE)).toBe(BASE);
        const late = cellRuleStyle(rules, {}, { status: 'late' }, 0, BASE);
        expect(late.borderColor).toBe('var(--border-default)');
        expect(late.fontWeight).toBe(700);
        expect(String(late.color)).toContain('color-mix');
        expect(String(late.background)).toContain('color-mix');
        expect(cellRuleStyle([rule('true', { color: '#047857' })], {}, {}, 1, BASE).color).toBe('#047857');
    });
});
