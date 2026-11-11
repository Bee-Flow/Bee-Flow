import { describe, expect, it } from 'vitest';
import { templateKeyPart, templateTexts } from './templateText';
import EN from '@/i18n/en-defaults';

const dutch: Record<string, string> = {
    'studio_apps_templates_builtin.app_sales_dashboard.title': 'Verkoopdashboard',
    'studio_apps_templates_builtin.app_sales_dashboard.description': 'Omzet en pijplijn.',
    'studio_apps_templates_builtin.category.dashboards': 'Dashboards',
};
const t = (key: string, fallback: string) => dutch[key] ?? fallback;

describe('templateTexts', () => {
    it('translates a built-in template by its id and its category by name', () => {
        const tpl = { id: 'app-sales-dashboard', title: 'Sales dashboard', description: 'Revenue and pipeline.', category: 'Dashboards', source: 'builtin' };
        expect(templateTexts(tpl, t)).toEqual({ title: 'Verkoopdashboard', description: 'Omzet en pijplijn.', category: 'Dashboards' });
    });

    it('shows a template made from an own app as its author wrote it, even under a built-in id', () => {
        const tpl = { id: 'app-sales-dashboard', title: 'Our sales', description: 'Ours.', category: 'Dashboards', source: 'captured' };
        expect(templateTexts(tpl, t)).toEqual({ title: 'Our sales', description: 'Ours.', category: 'Dashboards' });
    });

    it('falls back to the template text when there is no key', () => {
        const tpl = { id: 'app-new-one', title: 'New one', category: 'Data', source: 'builtin' };
        expect(templateTexts(tpl, t)).toEqual({ title: 'New one', description: '', category: 'Data' });
    });

    it('builds keys the English dictionary holds for the built-in templates', () => {
        expect(templateKeyPart('app-ai-act-register')).toBe('app_ai_act_register');
        expect(templateKeyPart('Dashboards')).toBe('dashboards');
        const en = EN as Record<string, string>;
        expect(en['studio_apps_templates_builtin.app_sales_dashboard.title']).toBe('Sales dashboard');
        expect(en['studio_apps_templates_builtin.category.compliance']).toBe('Compliance');
    });
});
