// Curated catalogue of plan templates shown in the "+ From Template" gallery.
//
// Each template is a complete payload for the PlanEditor form (the shape comes
// from initPlanForm in usePlanForm.ts). Selecting a template seeds the editor
// pre-populated so an admin can adjust before saving — nothing is persisted
// until they hit "Create plan".
//
// Tier slugs (`allowed_models`) match TIER_META keys in
// agent-hub/src/components/tierMeta.js so the AI Configuratie layer can
// resolve them to concrete vendor models (Claude primary, Mistral as EU
// fallback).
//
// Caps + prices were sized against May 2026 model pricing
// (Claude Haiku 4.5 / Sonnet 4.6 / Opus 4.7; Mistral Small / Medium / Large)
// targeting ~75% gross margin at 50% utilisation and ≥50% at cap-hit, with
// a 70/30 Claude/Mistral mix and a 4,000-input + 600-output token average
// per message. See the plan file for full math.
//
// White-label is intentionally **not** included on any cloud template — it's
// a self-hosted-only feature gated by license-key activation.

import type { PlanTemplate } from './planTemplates.types';
import { ORG_PLAN_TEMPLATES } from './planTemplatesOrg';
import { CONSUMER_PLAN_TEMPLATES } from './planTemplatesConsumer';

export type { PlanTemplate, PlanTemplateDisplay } from './planTemplates.types';

export const PLAN_TEMPLATES: PlanTemplate[] = [...ORG_PLAN_TEMPLATES, ...CONSUMER_PLAN_TEMPLATES];

export function getTemplate(id: string): PlanTemplate | null {
    return PLAN_TEMPLATES.find(t => t.id === id) || null;
}
