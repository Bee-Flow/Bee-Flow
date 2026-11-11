import type { BrowserStepModule } from '../browserSteps';

/**
 * back (server/appStudio/componentSpecs/steps/back.js): the previous screen of
 * this visit, with the params it had (../screenTrail.ts). At the start of the
 * visit there is none and nothing happens.
 */
const entry: BrowserStepModule = {
    kind: 'back',
    run: ({ ctx }) => {
        const live = ctx.live.current;
        if (!live.onNavigate || !live.screenTrail) return;
        const prev = live.screenTrail.back();
        if (prev) live.onNavigate(prev.id, prev.params);
    },
};

export default entry;
