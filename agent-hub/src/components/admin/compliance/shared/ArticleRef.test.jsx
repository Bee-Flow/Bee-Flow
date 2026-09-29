import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ArticleRef, { REGULATION_LABEL, formatArticleRef, formatRef, regulationLabel } from './ArticleRef';

const t = (key, fallback) => fallback;

describe('ArticleRef.formatRef — a bare number gets "Art.", a self-labelling ref is left alone', () => {
    it('numeric refs are articles', () => {
        expect(formatRef('12')).toBe('Art. 12');
        expect(formatRef('50(2)')).toBe('Art. 50(2)');
        expect(formatRef(28)).toBe('Art. 28');
        expect(formatRef(' 33 ')).toBe('Art. 33');
    });

    it('ISO controls, clauses and already-prefixed refs are self-labelling', () => {
        expect(formatRef('A.5.20')).toBe('A.5.20');
        expect(formatRef('cl 6.1')).toBe('cl 6.1');
        expect(formatRef('Art. 21(2)')).toBe('Art. 21(2)');
        expect(formatRef('Annex I 2(1)')).toBe('Annex I 2(1)');
        expect(formatRef('Recital 27')).toBe('Recital 27');
        expect(formatRef('Q-3')).toBe('Q-3');
    });

    it('empty → empty', () => {
        expect(formatRef('')).toBe('');
        expect(formatRef(null)).toBe('');
        expect(formatRef(undefined)).toBe('');
    });
});

describe('ArticleRef.regulationLabel — the short name is a translation', () => {
    it('every §1.1 regulation code has a key compliance.reg_<code>; CUSTOM has no short name', () => {
        for (const code of ['GDPR', 'AIA', 'ISO27001', 'NIS2', 'CRA', 'DATA_ACT', 'PLD', 'EAA', 'DORA', 'MACHINERY', 'CUSTOM']) {
            expect(REGULATION_LABEL[code].key).toBe(`compliance.reg_${code.toLowerCase()}`);
        }
        expect(regulationLabel('GDPR', t)).toBe('GDPR');
        expect(regulationLabel('AIA', t)).toBe('AI Act');
        expect(regulationLabel('ISO27001', t)).toBe('ISO');
        expect(regulationLabel('DATA_ACT', t)).toBe('Data Act');
        expect(regulationLabel('CUSTOM', t)).toBe('');
        expect(regulationLabel('WHATEVER', t)).toBe('');
        expect(regulationLabel(undefined, t)).toBe('');
    });

    it('accepts lower case and the few framework-id aliases', () => {
        expect(regulationLabel('gdpr', t)).toBe('GDPR');
        expect(regulationLabel('ISO', t)).toBe('ISO');
        expect(regulationLabel('product_liability', t)).toBe('PLD');
    });

    it('reads the translation, so Dutch says AVG', () => {
        const nl = (key, fallback) => (key === 'compliance.reg_gdpr' ? 'AVG' : fallback);
        expect(formatArticleRef('GDPR', '12', nl)).toBe('AVG Art. 12');
        expect(formatArticleRef('GDPR', '12', t)).toBe('GDPR Art. 12');
        expect(formatArticleRef('CUSTOM', 'Q-3', t)).toBe('Q-3');
    });
});

describe('<ArticleRef> — mono 11px secondary', () => {
    it('joins several refs with " · ", home framework first', () => {
        render(<ArticleRef refs={[{ regulation: 'GDPR', ref: '28' }, { regulation: 'ISO27001', ref: 'A.5.20' }]} />);
        const el = screen.getByTestId('article-ref');
        expect(el).toHaveTextContent('GDPR Art. 28 · ISO A.5.20');
        expect(el.style.fontFamily).toMatch(/^ui-monospace/);
        expect(el.className).toContain('text-[11px]');
        expect(el.className).toContain('text-[var(--text-secondary)]');
    });

    it('children win over refs; malformed entries are skipped; nothing to say → renders nothing', () => {
        const { container, rerender } = render(<ArticleRef refs={[{ regulation: 'AIA', ref: '50(2)' }]}>Art. 12</ArticleRef>);
        expect(screen.getByTestId('article-ref')).toHaveTextContent('Art. 12');
        rerender(<ArticleRef refs={[null, { regulation: 'NIS2', ref: '' }, { regulation: 'CRA', ref: '14' }]} />);
        expect(screen.getByTestId('article-ref')).toHaveTextContent('NIS2 · CRA Art. 14');
        rerender(<ArticleRef refs={[]} />);
        expect(container).toBeEmptyDOMElement();
        rerender(<ArticleRef />);
        expect(container).toBeEmptyDOMElement();
    });
});
