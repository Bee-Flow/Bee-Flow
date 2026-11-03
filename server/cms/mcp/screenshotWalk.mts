/**
 * Page-side helpers of the CMS screenshot. Chrome does not paint off-screen
 * cross-origin frames (the sandboxed live-component iframes) until they have
 * been in view, so a capture that jumps straight to `offsetY` photographs an
 * empty band. The walk scrolls through the region that will be photographed,
 * one viewport at a time, with two animation frames per stop.
 */

type WalkPage = { evaluate: (fn: (arg: any) => unknown, arg?: unknown) => Promise<unknown> };

const LIVE_FRAME_SELECTOR = 'iframe[title="Live Component"]';

/** Scroll through [from, to) so every frame in it has painted, then back to `from`. */
export async function paintRegion(page: WalkPage, from: number, to: number): Promise<void> {
    await page.evaluate(async ({ a, b, stepMs }: { a: number, b: number, stepMs: number }) => {
        const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
        const step = window.innerHeight || 800;
        const end = Math.min(b, document.documentElement.scrollHeight);
        for (let y = a; y < end; y += step) {
            window.scrollTo(0, y);
            await raf2();
            await new Promise((r) => setTimeout(r, stepMs));
        }
        window.scrollTo(0, a);
        await raf2();
    }, { a: from, b: to, stepMs: 60 });
}

/** How many live-component iframes the page holds (0 when unknown). */
export async function countLiveFrames(page: WalkPage): Promise<number> {
    const n = await page.evaluate((sel: string) => document.querySelectorAll(sel).length, LIVE_FRAME_SELECTOR).catch(() => 0);
    return Number.isInteger(n) && (n as number) > 0 && (n as number) < 1000 ? (n as number) : 0;
}
