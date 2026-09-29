import { describe, expect, it } from 'vitest';
import { PLAN_TEMPLATES } from './planTemplates';

// The enterprise split (2026-10): six capabilities became paid GA betas.
// server/migrations/enterprise-split-2026-10.js appends them to existing paid
// plans with these exact rules, so a plan created from a template today must
// end up where a migrated plan ends up.
const PAID_SPLIT = [
    'automation_privacy_steps',
    'studio_documents',
    'datatable_retention',
    'kb_datatable_sources',
    'kb_scheduled_refresh',
];
const SHARING = 'webpage_sharing';

type Template = (typeof PLAN_TEMPLATES)[number];
const betas = (tpl: Template): string[] => tpl.plan.allowed_beta_features ?? [];
const isPaid = (tpl: Template) => Number(tpl.plan.price) > 0 || tpl.plan.billing_model === 'metered';

describe('plan templates after the enterprise split', () => {
    it('has both free and paid templates to check', () => {
        expect(PLAN_TEMPLATES.some(isPaid)).toBe(true);
        expect(PLAN_TEMPLATES.some(tpl => !isPaid(tpl))).toBe(true);
    });

    it.each(PLAN_TEMPLATES.filter(isPaid).map(tpl => [tpl.id, tpl] as const))(
        'paid template %s carries every paid split capability',
        (_id, tpl) => {
            for (const id of PAID_SPLIT) expect(betas(tpl)).toContain(id);
        },
    );

    it.each(PLAN_TEMPLATES.filter(tpl => !isPaid(tpl)).map(tpl => [tpl.id, tpl] as const))(
        'free template %s carries none of them',
        (_id, tpl) => {
            for (const id of [...PAID_SPLIT, SHARING]) expect(betas(tpl)).not.toContain(id);
        },
    );

    it.each(PLAN_TEMPLATES.map(tpl => [tpl.id, tpl] as const))(
        'template %s lists webpage_sharing exactly when it lists webpages',
        (_id, tpl) => {
            expect(betas(tpl).includes(SHARING)).toBe(betas(tpl).includes('webpages'));
        },
    );

    it('lists no beta twice', () => {
        for (const tpl of PLAN_TEMPLATES) expect(new Set(betas(tpl)).size).toBe(betas(tpl).length);
    });

    it('the Enterprise template ships the Compliance Hub it advertises, and App Studio', () => {
        const enterprise = PLAN_TEMPLATES.find(tpl => tpl.id === 'org-enterprise');
        expect(enterprise).toBeDefined();
        expect(betas(enterprise as Template)).toEqual(expect.arrayContaining(['compliance_hub_gdpr', 'app_studio']));
    });
});
