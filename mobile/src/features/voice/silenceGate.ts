/**
 * When the turn is over, decided from the microphone level alone.
 *
 * This is the part of voice mode that decides you have stopped talking, and it
 * is the difference between a phone call and a walkie-talkie. It lived inside
 * the polling loop of useVoiceSession, where it could only be exercised by
 * holding a real microphone in a real room — so the one property that matters,
 * that it still works somewhere other than a quiet office, was never checked.
 * Here it is arithmetic over numbers, and the tests can put it in a café.
 *
 * WHY A TRACKED FLOOR RATHER THAN A THRESHOLD. A fixed dB gate works in a
 * quiet room and nowhere else: a car, a café or a laptop fan sits well above
 * any threshold low enough to catch a soft voice. So the noise floor is
 * tracked continuously and speech is "meaningfully above the floor". The floor
 * drops fast, because a room going quiet is immediate, and rises slowly,
 * because a fan starting up must not be mistaken for someone speaking.
 *
 * A consequence worth knowing: a level that NEVER varies is absorbed into the
 * floor after about 49 seconds and ends the turn on the silence rule rather
 * than the ceiling. That is the floor doing its job — a tone or a hum is not a
 * voice — and speech varies, so it does not happen to anyone talking.
 *
 * The gate decides; it never acts. Recording, submitting and restarting stay
 * with the hook, which is the only thing that can do them.
 */

export interface GateConfig {
    /** Above floor + this, someone is talking. */
    speechMargin: number;
    /** Above floor + this, they are still talking. Lower, so a dip mid-word does not end the turn. */
    silenceMargin: number;
    /** Quiet for this long after speech: the turn is over. */
    silenceHoldMs: number;
    /** A single utterance never runs longer than this. */
    maxUtteranceMs: number;
    /** Nobody has said anything for this long: recycle the file, keep the mic hot. */
    idleRestartMs: number;
}

export const DEFAULT_GATE: GateConfig = {
    speechMargin: 0.12,
    silenceMargin: 0.06,
    silenceHoldMs: 1100,
    maxUtteranceMs: 55_000,
    idleRestartMs: 20_000,
};

export interface GateReading {
    /** Raw metering from the recorder, in dBFS. `undefined` while it warms up. */
    db: number | undefined;
    /** How long the current FILE has been open, which is not how long anyone has been talking. */
    durationMillis: number;
    now: number;
}

export type GateDecision =
    /** Keep listening. */
    | { kind: 'listening'; level: number; elapsedSeconds: number }
    /** Nobody has spoken; throw the file away and open a new one. */
    | { kind: 'restart'; level: number; elapsedSeconds: number }
    /** The turn is over; send what was said. */
    | { kind: 'submit'; level: number; elapsedSeconds: number; spokenMs: number };

export interface SilenceGate {
    /** Start of a capture. `now` anchors the utterance clock. */
    reset(now: number): void;
    feed(reading: GateReading): GateDecision;
    /**
     * End the utterance from outside — the user tapped send. Returns when it
     * started, or null if the gate never heard speech begin, which is the
     * noisy-room case the tap exists to rescue.
     */
    closeUtterance(): number | null;
}

/** dBFS → 0..1, mapping the bottom 60 dB across the range. */
export function normalise(db: number | undefined): number {
    if (db === undefined || Number.isNaN(db)) return 0;
    if (db <= -60) return 0;
    if (db >= 0) return 1;
    return (db + 60) / 60;
}

export function createSilenceGate(config: Partial<GateConfig> = {}): SilenceGate {
    const { speechMargin, silenceMargin, silenceHoldMs, maxUtteranceMs, idleRestartMs } = {
        ...DEFAULT_GATE,
        ...config,
    };

    let smoothed = 0;
    let noiseFloor = 0;
    let speaking = false;
    let lastVoiceAt = 0;
    let utteranceStart = 0;

    return {
        reset(now: number) {
            smoothed = 0;
            noiseFloor = 0;
            speaking = false;
            lastVoiceAt = 0;
            utteranceStart = now;
        },

        closeUtterance(): number | null {
            const startedAt = speaking ? utteranceStart : null;
            speaking = false;
            return startedAt;
        },

        feed({ db, durationMillis, now }: GateReading): GateDecision {
            const raw = normalise(db);
            // Asymmetric smoothing: jump to a peak so a syllable registers,
            // fall gently so the orb does not flicker between words.
            smoothed = raw > smoothed ? raw : smoothed * 0.8 + raw * 0.2;
            const level = smoothed;

            // Read BEFORE speech can start on this tick: the timer belongs to
            // the utterance, and a clock counting up at someone sitting in
            // silence reads as "this is recording me".
            const elapsedSeconds = speaking ? (now - utteranceStart) / 1000 : 0;

            noiseFloor =
                noiseFloor === 0
                    ? level
                    : level < noiseFloor
                      ? noiseFloor * 0.9 + level * 0.1
                      : noiseFloor * 0.995 + level * 0.005;

            if (!speaking) {
                if (level > noiseFloor + speechMargin) {
                    speaking = true;
                    utteranceStart = now;
                    lastVoiceAt = now;
                    return { kind: 'listening', level, elapsedSeconds };
                }
                // The mic stays hot indefinitely — a call does not hang up
                // because you paused to find your words — but the FILE does not.
                if (durationMillis >= idleRestartMs) {
                    return { kind: 'restart', level, elapsedSeconds };
                }
                return { kind: 'listening', level, elapsedSeconds };
            }

            if (level > noiseFloor + silenceMargin) lastVoiceAt = now;
            const trailing = now - lastVoiceAt;
            const spokenMs = now - utteranceStart;

            if (trailing >= silenceHoldMs || spokenMs >= maxUtteranceMs) {
                speaking = false;
                return { kind: 'submit', level, elapsedSeconds, spokenMs };
            }
            return { kind: 'listening', level, elapsedSeconds };
        },
    };
}
