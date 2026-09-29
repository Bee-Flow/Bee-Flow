// Pure grading logic for Learning Center sim steps (SimStep.jsx).
//
// A sim is an interactive widget that IS the question — the learner constructs
// an answer (assemble a flow, match pairs, order steps) instead of picking from
// prose options. Grading is local and instant, like the built-in quizzes: the
// answer keys ship with the lesson, which is fine for teaching (the same trust
// level as `choice.correct` on quiz steps). Everything here is pure so it can
// be unit-tested without a DOM.
//
// Sim config shapes (the `sim` field on a step):
//
//   { kind: 'match', pairs: [{ id, left, right }] }
//     Learner taps one left and one right tile to pair them. Grading is
//     per-pick: a wrong pairing bounces immediately (Duolingo match-the-pairs).
//
//   { kind: 'order', items: [{ id, label }], solution: [id, …], feedbackFallback? }
//     Learner arranges the items, then checks. `solution` is the correct order.
//
//   { kind: 'flow-build', scenarios: [ … ] }
//     The flagship widget: a mini automation canvas. Each scenario gives a
//     plain-language brief; the learner picks ONE trigger and assembles the
//     steps rail in order from a parts palette. Scenario shape:
//       {
//         id, briefFallback,
//         trigger: {
//           options: [{ id, label, desc? }],
//           correct: 'schedule',
//           feedback: { [wrongOptionId]: 'why that trigger misses' },
//         },
//         steps: {
//           palette: [{ id, label, hint? }],   // includes distractors
//           solution: ['fetch', 'summarise', 'send'],
//           feedback: { [paletteId]: 'why this step does not belong' },
//         },
//       }

// ── match ────────────────────────────────────────────────────────────────────

// True when the tapped left and right tiles belong to the same pair. Tiles are
// keyed by their pair id on both sides, so a match is simply id equality — but
// both ids must name a real pair (an unknown id never matches).
export function matchPickCorrect(pairs, leftId, rightId) {
    if (leftId !== rightId) return false;
    return (pairs || []).some((p) => p.id === leftId);
}

// ── order ────────────────────────────────────────────────────────────────────

// Grade an arrangement against the solution order. Returns the index of the
// first misplaced item (for targeted feedback) or -1 when correct.
export function evaluateOrder(solution, arrangement) {
    const sol = solution || [];
    const arr = arrangement || [];
    if (arr.length !== sol.length) return { correct: false, firstWrongIndex: Math.min(arr.length, sol.length) };
    for (let i = 0; i < sol.length; i += 1) {
        if (arr[i] !== sol[i]) return { correct: false, firstWrongIndex: i };
    }
    return { correct: true, firstWrongIndex: -1 };
}

// ── flow-build ───────────────────────────────────────────────────────────────

// Grade one flow-build attempt: { triggerId, stepIds } against a scenario.
// Returns { correct, problems: [string] } where problems are specific, kind
// teaching messages (wrong-answer-specific feedback, not just "incorrect").
export function evaluateFlow(scenario, attempt) {
    const problems = [];
    const trig = scenario?.trigger || {};
    const stepsCfg = scenario?.steps || {};
    const triggerId = attempt?.triggerId || null;
    const stepIds = Array.isArray(attempt?.stepIds) ? attempt.stepIds : [];

    if (!triggerId) {
        problems.push('Every automation starts with a trigger — pick one first.');
    } else if (triggerId !== trig.correct) {
        const specific = trig.feedback && trig.feedback[triggerId];
        problems.push(specific || 'That trigger doesn’t fit this scenario — reread when the work should start.');
    }

    const solution = stepsCfg.solution || [];
    const solutionSet = new Set(solution);

    // Extra steps (distractors picked from the palette).
    for (const id of stepIds) {
        if (!solutionSet.has(id)) {
            const specific = stepsCfg.feedback && stepsCfg.feedback[id];
            const label = paletteLabel(stepsCfg, id);
            problems.push(specific || `“${label}” isn’t needed here — the brief doesn’t ask for it.`);
        }
    }

    // Missing steps.
    for (const id of solution) {
        if (!stepIds.includes(id)) {
            const label = paletteLabel(stepsCfg, id);
            problems.push(`Something’s missing: the flow still needs “${label}”.`);
        }
    }

    // Order — only meaningful once the sets agree.
    if (problems.length === 0 || (triggerId === trig.correct && sameSet(stepIds, solution))) {
        const inOrder = stepIds.filter((id) => solutionSet.has(id));
        const { correct } = evaluateOrder(solution, inOrder);
        if (!correct && sameSet(stepIds, solution)) {
            problems.push('Right parts, wrong order — think about what has to happen before what.');
        }
    }

    return { correct: problems.length === 0, problems };
}

function paletteLabel(stepsCfg, id) {
    const item = (stepsCfg.palette || []).find((p) => p.id === id);
    return item?.label || id;
}

function sameSet(a, b) {
    if (a.length !== b.length) return false;
    const set = new Set(b);
    return a.every((id) => set.has(id));
}

// ── shared ───────────────────────────────────────────────────────────────────

// Deterministic shuffle so a sim's tiles don't render in answer order but stay
// stable across re-renders (seeded by the step id — no Math.random in render).
export function seededShuffle(items, seedStr) {
    const arr = [...(items || [])];
    let seed = 0;
    const s = String(seedStr || 'seed');
    for (let i = 0; i < s.length; i += 1) seed = (seed * 31 + s.charCodeAt(i)) >>> 0;
    for (let i = arr.length - 1; i > 0; i -= 1) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const j = seed % (i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
