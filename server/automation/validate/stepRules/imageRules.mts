/**
 * `images` on an `ai_step` or `data_extraction`: the pictures the step may
 * show its model (core/automationRunner/aiStepImages.mts).
 *
 *   - shape (integrity): a list of at most MAX_IMAGE_BINDINGS bindings, each a
 *     `{kind: ref|template|literal|expr}` object, usually the `sourceHandle`
 *     of a "read file" step that read an image;
 *   - the model (completeness, so a draft still saves): with the caller's
 *     `imageModels` fact (automation/imageModelsFact.mts), a step whose model
 *     cannot see is refused with the fix. Only a known `false` is a finding;
 *     the run checks again and falls back to the text read from the images.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { isObject } = nodeRequire('../helpers') as { isObject(v: unknown): v is Record<string, any> };

export const MAX_IMAGE_BINDINGS = 20;
const BINDING_KINDS = new Set(['ref', 'template', 'literal', 'expr']);

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
interface RuleCtx {
    pushE: (f: Finding) => void;
    pushW: (f: Finding) => void;
    imageModels?: { tiers?: Record<string, boolean>; dataExtraction?: boolean | null } | null;
}

/** The step's `images` shape, then whether its model can see. */
export function checkStepImages(ctx: RuleCtx, step: Record<string, any>, at: string): void {
    if (step.type !== 'ai_step' && step.type !== 'data_extraction') return;
    if (step.images === undefined || step.images === null) return;
    const code = `${step.type}.images_invalid`;
    if (!Array.isArray(step.images)) {
        ctx.pushE({ code, severity: 'error', path: `${at}.images`, message: `Step ${step.id}: images must be a list of bindings.`, hint: 'Bind each image: images: [{kind:"ref", path:"steps.<read>.output.sourceHandle"}].' });
        return;
    }
    if (step.images.length > MAX_IMAGE_BINDINGS) {
        ctx.pushE({ code, severity: 'error', path: `${at}.images`, message: `Step ${step.id}: ${step.images.length} image bindings is more than the limit of ${MAX_IMAGE_BINDINGS}.`, hint: 'Bind the output of the "read file" step that read them all (a fan-out) once, instead of each image.' });
        return;
    }
    let shapeOk = true;
    step.images.forEach((b: unknown, i: number) => {
        if (isObject(b) && typeof b.kind === 'string' && BINDING_KINDS.has(b.kind)) return;
        shapeOk = false;
        ctx.pushE({ code, severity: 'error', path: `${at}.images[${i}]`, message: `Step ${step.id}: image ${i + 1} is not a binding.`, hint: 'Each image is a binding, e.g. {kind:"ref", path:"steps.<read>.output.sourceHandle"} (the handle a "read file" step returns for an image).' });
    });
    if (shapeOk && step.images.length) checkImageModel(ctx, step, at);
}

function checkImageModel(ctx: RuleCtx, step: Record<string, any>, at: string): void {
    const fact = ctx.imageModels;
    if (!fact) return;
    if (step.type === 'data_extraction') {
        if (fact.dataExtraction === false) {
            ctx.pushE({ code: 'data_extraction.images_model_no_vision', severity: 'error', path: `${at}.images`, message: `Step ${step.id}: the extraction model cannot read images.`, hint: 'Ask an administrator to set an extraction model that supports images (Admin → AI models → data extraction model), or remove the images and extract from the text read from them (bind source to the read step\'s content).' });
        }
        return;
    }
    const tiers = fact.tiers || {};
    const seeing = Object.keys(tiers).filter((k) => tiers[k] === true);
    const tier = typeof step.modelTier === 'string' && step.modelTier ? step.modelTier : 'auto';
    const pick = seeing.length ? `Set modelTier to a tier whose model reads images: ${seeing.join(', ')}.` : 'No model tier of this workspace reads images; ask an administrator to set one up, or remove the images and use the text read from them.';
    if (tier !== 'auto' && tiers[tier] === false) {
        ctx.pushE({ code: 'ai_step.images_model_no_vision', severity: 'error', path: `${at}.modelTier`, message: `Step ${step.id}: the model of tier "${tier}" cannot read images.`, hint: pick });
        return;
    }
    if (tier !== 'auto') return;
    const known = Object.values(tiers);
    if (known.length && !seeing.length) {
        ctx.pushE({ code: 'ai_step.images_model_no_vision', severity: 'error', path: `${at}.modelTier`, message: `Step ${step.id}: no model this step can run on reads images.`, hint: pick });
    } else if (known.some((v) => v === false)) {
        ctx.pushW({ code: 'ai_step.images_model_auto', severity: 'warning', path: `${at}.modelTier`, message: `Step ${step.id}: on "auto" the step may run on a model that cannot read images, and then gets the text read from them instead.`, hint: pick });
    }
}
