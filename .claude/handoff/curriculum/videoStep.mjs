// Video steps for generate.mjs.
//
// A lesson gets a video from its entry in curriculum.json, NOT from the lesson
// JSON (the validator never sees it, so the authoring rules for interactions
// are untouched):
//
//   { "id": "creating-agents", ..., "video": { "id": "agents-intro",
//     "titleFallback": "Agents in 70 seconds", "after": "first-slide" } }
//
//   id             the videoId in the media pack's manifest.json
//   titleFallback  optional caption under the player (English; keyed into learn.js)
//   after          'first-slide' (default): right after the lesson's first slide,
//                  or at the very start when it has none; or a 0-based step
//                  index to insert after.
//
// The step is optional by construction (stepTypes.stepIsRequired), never counts
// towards gates or mastery, and the player drops it when the deployment has no
// pack — see agent-hub/src/components/onboarding/learnMedia.ts.

export const VIDEO_ID_RX = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VIDEO_KEYS = new Set(['id', 'titleFallback', 'after']);

/** The step id a video gets inside its lesson (≤ 64 chars: progressValidation's cap). */
export function videoStepId(videoId) {
    return `video-${videoId}`;
}

/**
 * Insert the curriculum's video step into a lesson's authored steps.
 * Returns { steps, problems }: `steps` is a new array (the input is never
 * mutated); with problems it is the input unchanged.
 */
export function insertVideoStep(lessonId, steps, video) {
    const problems = [];
    const where = `lesson ${lessonId}: video`;
    if (video === undefined || video === null) return { steps, problems };
    if (typeof video !== 'object' || Array.isArray(video)) {
        return { steps, problems: [`${where} must be an object`] };
    }
    for (const k of Object.keys(video)) if (!VIDEO_KEYS.has(k)) problems.push(`${where}.${k} is not a known field`);
    if (typeof video.id !== 'string' || !VIDEO_ID_RX.test(video.id)) problems.push(`${where}.id must match ${VIDEO_ID_RX}`);
    if (video.titleFallback !== undefined && (typeof video.titleFallback !== 'string' || !video.titleFallback.trim() || video.titleFallback.length > 120)) {
        problems.push(`${where}.titleFallback must be a non-empty string of at most 120 characters`);
    }
    let at;
    const after = video.after === undefined ? 'first-slide' : video.after;
    if (after === 'first-slide') {
        at = steps.findIndex((s) => s.type === 'slide') + 1; // 0 when there is no slide
    } else if (Number.isInteger(after) && after >= 0 && after < steps.length) {
        at = after + 1;
    } else {
        problems.push(`${where}.after must be 'first-slide' or a step index 0..${steps.length - 1}`);
    }
    if (typeof video.id === 'string') {
        const id = videoStepId(video.id);
        if (steps.some((s) => s.id === id)) problems.push(`${where}: step id ${id} already exists in the lesson`);
    }
    if (problems.length) return { steps, problems };

    const step = { type: 'video', id: videoStepId(video.id), videoId: video.id };
    if (video.titleFallback !== undefined) step.title = video.titleFallback;
    return { steps: [...steps.slice(0, at), step, ...steps.slice(at)], problems };
}

/**
 * The generated JS for a video step. `K(field)` builds the step's dictionary
 * key and `put(key, english)` records it, exactly as for the other step kinds.
 */
export function videoStepToJs(s, K, put, js) {
    if (typeof s.title === 'string') {
        put(K('title'), s.title);
        return `{ type: STEP_TYPES.VIDEO, id: ${js(s.id)}, videoId: ${js(s.videoId)}, titleKey: ${js(K('title'))}, titleFallback: ${js(s.title)} }`;
    }
    return `{ type: STEP_TYPES.VIDEO, id: ${js(s.id)}, videoId: ${js(s.videoId)} }`;
}
