import { describe, expect, it } from 'vitest';
import { DEMO_CAPABILITIES, DEMO_ENTITLEMENTS, DEMO_USER } from './common';

/**
 * The demo describes the Enterprise product. The capabilities the enterprise
 * split (2026-10) moved behind a licence all sit on screens a public demo
 * mounts (the routine builder, App Studio, knowledge bases), and each of those
 * screens checks its own lock, so a missing id shows a visitor a lock where
 * the feature should be.
 */
describe('demo entitlements', () => {
    it('carry the enterprise-split capabilities the demoed screens check', () => {
        for (const id of ['automation_privacy_steps', 'studio_documents', 'datatable_retention', 'kb_scheduled_refresh', 'kb_datatable_sources']) {
            expect(DEMO_CAPABILITIES, id).toContain(id);
            expect(DEMO_ENTITLEMENTS.effective.beta, id).toContain(id);
            expect(DEMO_USER.canUseFeature[id], id).toBe(true);
        }
    });
});
