/**
 * The password rules checked before a round trip. Mirrors the server's floor
 * (auth/passwordPolicy.js): eight characters for a normal account. The server
 * still decides, and its message is what gets shown on a refusal.
 */
export function passwordCheck(current: string, next: string, repeat: string) {
    return {
        tooShort: next.length > 0 && next.length < 8,
        mismatch: repeat.length > 0 && repeat !== next,
        ready: current.length > 0 && next.length >= 8 && repeat === next,
    };
}
