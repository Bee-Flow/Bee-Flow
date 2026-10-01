// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Where the agent's plan hangs (owner, 2026-09-16): ON the canvas, at its left
 * edge — canvas furniture like the zoom stack, not a column of its own and not
 * the top of the message thread, where it scrolled out of sight as soon as the
 * build produced messages.
 *
 * The camera has to know about it: a panel drawn over the canvas would
 * otherwise get cards framed behind it, so the strip it covers is passed to
 * DiagramPane as `cameraInsetLeft` and every shot frames in what is left.
 *
 * BuildTab has no render harness (it needs the whole builder around it), so
 * this pins the arrangement in the source.
 */
const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'BuildTab.jsx'), 'utf8');

describe('BuildTab — the plan on the canvas', () => {
    it('draws it once, through the shared canvas panel (which folds to a pill when the build stops)', () => {
        expect(SRC.match(/<CanvasPlanPanel/g)).toHaveLength(1);
        expect(SRC).not.toMatch(/<BuilderPlanChecklist/, 'the checklist itself belongs to the panel now');
        expect(SRC).toMatch(/idPrefix="builder"/);
        expect(SRC).toMatch(/running=\{state\.running\}/);
    });

    it('lives inside the canvas wrapper, before the canvas itself', () => {
        const wrapper = SRC.indexOf('<div className="relative flex-1 min-w-0">');
        const panel = SRC.indexOf('<CanvasPlanPanel');
        const canvas = SRC.indexOf('<DiagramPane', panel);
        expect(wrapper).toBeGreaterThan(-1);
        expect(panel).toBeGreaterThan(wrapper);
        expect(panel).toBeLessThan(canvas);
    });

    it('shows only with a plan, and reserves its strip from the build camera', () => {
        expect(SRC).toMatch(/const hasPlan = Array\.isArray\(state\.todos\) && state\.todos\.length > 0;/);
        expect(SRC).toMatch(/\{hasPlan && \(/);
        expect(SRC).toMatch(/cameraInsetLeft=\{hasPlan \? PLAN_PANEL_INSET_PX : 0\}/);
    });
});
