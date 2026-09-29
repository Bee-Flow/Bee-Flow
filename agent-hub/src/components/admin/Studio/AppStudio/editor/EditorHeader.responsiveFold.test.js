// @vitest-environment node
import { describe, expect, it } from 'vitest';

/**
 * The header's responsive fold is CONTAINER-QUERY CSS — jsdom lays nothing
 * out, so no rendered test can catch its removal. Same answer the studio
 * already uses for contrast (AppStudio.contrast.test.jsx): pin the mechanism
 * as source, so the day someone strips "a few odd Tailwind classes" during a
 * cleanup, this fails instead of the header silently painting over the
 * inspector again at laptop widths.
 *
 * The header is now the shared Studio chrome (Studio artboard 1b, plan P1):
 * kind tile · name · "Saved · v12" · five segments · "⚠ n to check" ·
 * "View as ▾" · [● LIVE | Publish] · ⋯ — and it KEEPS its wrapping
 * @container instead of the artboard's fixed 48px, because it sits between
 * the chat pane and the inspector (recorded deviation). The fold stages
 * changed shape with it:
 *
 *   wide      every control with its words
 *   <@6xl     the five segment labels go SR-ONLY (icons remain, names
 *             survive for screen readers) and "View as" drops its lead-in
 *   <@4xl     the View-as capsule folds away — the ⋯ menu, which is always
 *             mounted, carries "View as role…", ⌘K and version history
 *   1440/1180 the publish pill folds its own two words — that logic lives in
 *             shared/StatusActionPill under the container name "edhead"
 *
 * What must stay true:
 *   - the header is a named @container and can wrap (the safety net)
 *   - the segments fold to icons WITHOUT losing their names
 *   - the View-as capsule folds away and the ⋯ menu can still reach it
 *   - the publish pill delegates its fold to StatusActionPill, whose
 *     FOLD_CLASSES must know the "edhead" container by name
 *   - row 2 wraps too, so the unfolded "All components" ribbon takes its own
 *     line instead of pushing the row over the inspector
 *   - the center column clips horizontal overflow (AppEditorShell), so
 *     nothing can ever paint across the inspector boundary
 */

async function readSource(file) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.join(__dirname, file), 'utf8');
}

async function readShared(file) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.resolve(__dirname, '../../../../shared', file), 'utf8');
}

describe('EditorHeader — the responsive fold stays wired', () => {
    it('the header is a wrapping named container', async () => {
        const src = await readSource('EditorHeader.jsx');
        expect(src).toMatch(/@container\/edhead[^"]*flex[^"]*flex-wrap|flex[^"]*flex-wrap[^"]*@container\/edhead/);
    });

    it('the segments fold to icons below @6xl without losing their names', async () => {
        const src = await readSource('EditorHeader.jsx');
        // sr-only, not hidden: the five segment names must survive the fold.
        expect(src).toMatch(/@max-6xl\/edhead:sr-only/);
        expect(src).not.toMatch(/segmentLabel[\s\S]{0,120}@max-6xl\/edhead:hidden/);
    });

    it('the View-as capsule folds away below @4xl and the ⋯ menu can still reach it', async () => {
        const src = await readSource('EditorHeader.jsx');
        expect(src).toMatch(/@max-4xl\/edhead:hidden/);
        // The lead-in word goes one stage earlier; the role name never does.
        expect(src).toMatch(/@max-6xl\/edhead:hidden/);
        // The ⋯ menu is always mounted and carries the same choice.
        expect(src).toMatch(/view_as_menu/);
        expect(src).toMatch(/version_history/);
        expect(src).toMatch(/command_palette/);
    });

    it('the publish pill folds through StatusActionPill, which knows "edhead"', async () => {
        const src = await readSource('EditorHeader.jsx');
        expect(src).toMatch(/containerName="edhead"/);
        const pill = await readShared('StatusActionPill.jsx');
        expect(pill).toMatch(/edhead:\s*Object\.freeze\(\{[^}]*@max-\[1440px\]\/edhead:hidden/);
        expect(pill).toMatch(/edhead:\s*Object\.freeze\(\{[^}]*@max-\[1180px\]\/edhead:hidden/);
    });

    it('row 2 wraps, so the unfolded ribbon takes its own line', async () => {
        const row = await readSource('EditorToolRow.jsx');
        expect(row).toMatch(/flex-wrap/);
        const ribbon = await readSource('ComponentRibbon.jsx');
        expect(ribbon).toMatch(/basis-full/);
    });

    it('the center column clips horizontal overflow (AppEditorShell)', async () => {
        const src = await readSource('AppEditorShell.jsx');
        expect(src).toMatch(/overflow-x-clip/);
    });
});
