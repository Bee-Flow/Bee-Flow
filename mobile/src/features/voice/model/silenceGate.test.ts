/**
 * The silence gate, taken somewhere other than a quiet office.
 *
 * The failure this file exists to catch is not a crash. It is a gate that
 * works on the developer's desk and, in a car or a café, either never fires
 * (the turn hangs until the 55-second ceiling) or fires constantly (the
 * assistant interrupts you mid-sentence). Both read to a user as "voice mode
 * is broken", and neither shows up in any test that does not model a room.
 */

import { createSilenceGate, normalise, DEFAULT_GATE, type GateDecision } from './silenceGate';

/** dBFS for a 0..1 level, the inverse of normalise. */
const dbFor = (level: number) => level * 60 - 60;

/**
 * Feed a room to the gate. `levels` are 0..1 mic levels, one per 100 ms tick,
 * which is the rate the hook polls at.
 */
function run(levels: number[], opts: { startAt?: number; tickMs?: number } = {}) {
    const tickMs = opts.tickMs ?? 100;
    const start = opts.startAt ?? 1_000_000;
    const gate = createSilenceGate();
    gate.reset(start);
    const decisions: GateDecision[] = [];
    levels.forEach((level, i) => {
        const now = start + (i + 1) * tickMs;
        decisions.push(gate.feed({ db: dbFor(level), durationMillis: (i + 1) * tickMs, now }));
    });
    return decisions;
}

const speech = (ticks: number, level = 0.7) => Array(ticks).fill(level);
const room = (ticks: number, level: number) => Array(ticks).fill(level);

describe('normalise', () => {
    it('maps the bottom 60 dB across 0..1 and clamps outside it', () => {
        expect(normalise(-60)).toBe(0);
        expect(normalise(-30)).toBeCloseTo(0.5);
        expect(normalise(0)).toBe(1);
        expect(normalise(-90)).toBe(0);
        expect(normalise(12)).toBe(1);
    });

    it('treats a recorder that has not reported yet as silence', () => {
        expect(normalise(undefined)).toBe(0);
        expect(normalise(NaN)).toBe(0);
    });
});

describe('a quiet room', () => {
    it('ends the turn about a second after the talking stops', () => {
        // 2s of speech, then silence. The hold is 1100 ms.
        const decisions = run([...room(5, 0.02), ...speech(20), ...room(20, 0.02)]);
        const submitAt = decisions.findIndex((d) => d.kind === 'submit');
        expect(submitAt).toBeGreaterThan(-1);

        // The hold starts when the SMOOTHED level falls below the gate, and
        // smoothing decays gently so the orb does not flicker — so the wall
        // clock is the hold plus a few ticks of decay, never less than the hold.
        const ticksAfterSpeech = submitAt - (5 + 20 - 1);
        expect(ticksAfterSpeech * 100).toBeGreaterThanOrEqual(DEFAULT_GATE.silenceHoldMs);
        expect(ticksAfterSpeech * 100).toBeLessThan(DEFAULT_GATE.silenceHoldMs + 1000);
    });

    it('reports the length of the utterance, not of the file', () => {
        // A long pause before anyone speaks must not inflate the reported time.
        const decisions = run([...room(30, 0.02), ...speech(10), ...room(20, 0.02)]);
        const submit = decisions.find((d) => d.kind === 'submit');
        expect(submit).toBeDefined();
        if (submit?.kind !== 'submit') throw new Error('unreachable');
        // ~10 ticks of speech plus the 1100 ms hold, NOT the 30 ticks before it.
        expect(submit.spokenMs).toBeLessThan(3000);
        expect(submit.spokenMs).toBeGreaterThan(1000);
    });

    it('holds through a dip between words', () => {
        // The gap between two words is below the speech margin but the turn
        // must not end there: that is what the lower silence margin is for.
        const decisions = run([
            ...room(5, 0.02),
            ...speech(8),
            ...room(4, 0.1), // a short gap, still above the floor
            ...speech(8),
            ...room(20, 0.02),
        ]);
        const submits = decisions.filter((d) => d.kind === 'submit');
        expect(submits).toHaveLength(1);
        const firstSubmit = decisions.findIndex((d) => d.kind === 'submit');
        expect(firstSubmit).toBeGreaterThan(5 + 8 + 4);
    });
});

describe('a room that is not quiet', () => {
    it('still hears a voice over a café', () => {
        // A steady 0.35 background: far above any fixed threshold that would
        // also catch a soft voice, which is exactly why the floor is tracked.
        const decisions = run([...room(40, 0.35), ...speech(15, 0.75), ...room(20, 0.35)]);
        expect(decisions.some((d) => d.kind === 'submit')).toBe(true);
    });

    it('does not mistake a fan starting up for someone talking', () => {
        // The floor rises slowly by design, so a sustained new noise source
        // must not produce a turn on its own.
        const decisions = run([...room(30, 0.05), ...room(120, 0.3)]);
        expect(decisions.some((d) => d.kind === 'submit')).toBe(false);
    });

    it('does not fire on a room that is merely loud and steady', () => {
        const decisions = run(room(150, 0.6));
        expect(decisions.some((d) => d.kind === 'submit')).toBe(false);
    });
});

describe('the limits', () => {
    it('cuts an utterance that runs past the ceiling', () => {
        // Someone reading aloud: never a gap long enough to end the turn, and
        // a level that moves the way a voice does.
        const ticks = Math.ceil(DEFAULT_GATE.maxUtteranceMs / 100) + 30;
        const reading = Array.from({ length: ticks }, (_, i) => 0.55 + 0.3 * Math.abs(Math.sin(i / 3)));
        const decisions = run([...room(3, 0.02), ...reading]);
        const submit = decisions.find((d) => d.kind === 'submit');
        expect(submit).toBeDefined();
        if (submit?.kind !== 'submit') throw new Error('unreachable');
        expect(submit.spokenMs).toBeGreaterThanOrEqual(DEFAULT_GATE.maxUtteranceMs);
    });

    it('absorbs a perfectly constant tone into the floor before the ceiling', () => {
        // Known and deliberate. A level that never varies is not a voice — it
        // is a tone, a hum or a held note — and the floor is built to rise onto
        // exactly that. It reaches the level after ~49 s and the turn ends on
        // the silence rule rather than the ceiling. Speech varies, so this does
        // not happen to anyone talking; the test is here so the next reader
        // meets the property as a decision instead of as a bug report.
        const ticks = Math.ceil(DEFAULT_GATE.maxUtteranceMs / 100) + 30;
        const decisions = run([...room(3, 0.02), ...speech(ticks)]);
        const submit = decisions.find((d) => d.kind === 'submit');
        expect(submit).toBeDefined();
        if (submit?.kind !== 'submit') throw new Error('unreachable');
        expect(submit.spokenMs).toBeLessThan(DEFAULT_GATE.maxUtteranceMs);
        expect(submit.spokenMs).toBeGreaterThan(40_000);
    });

    it('asks for a fresh file when nobody has said anything, and never submits one', () => {
        const ticks = Math.ceil(DEFAULT_GATE.idleRestartMs / 100) + 5;
        const decisions = run(room(ticks, 0.02));
        expect(decisions.some((d) => d.kind === 'restart')).toBe(true);
        expect(decisions.some((d) => d.kind === 'submit')).toBe(false);
    });

    it('does not recycle the file out from under someone who is talking', () => {
        // Speech starts before the idle ceiling and continues past it.
        const idleTicks = Math.ceil(DEFAULT_GATE.idleRestartMs / 100);
        const decisions = run([...room(idleTicks - 30, 0.02), ...speech(60)]);
        expect(decisions.some((d) => d.kind === 'restart')).toBe(false);
    });
});

describe('reset', () => {
    it('forgets the previous room so a new capture starts from nothing', () => {
        const gate = createSilenceGate();
        gate.reset(0);
        // Load the floor up with a loud room.
        for (let i = 1; i <= 50; i += 1) gate.feed({ db: dbFor(0.8), durationMillis: i * 100, now: i * 100 });

        gate.reset(100_000);
        // In the quiet room that follows, an ordinary voice must register.
        let spoke = false;
        for (let i = 1; i <= 40; i += 1) {
            const level = i > 10 ? 0.5 : 0.02;
            const d = gate.feed({ db: dbFor(level), durationMillis: i * 100, now: 100_000 + i * 100 });
            if (d.elapsedSeconds > 0) spoke = true;
        }
        expect(spoke).toBe(true);
    });
});
