/**
 * The rules of the app `code` step that both its validator (validate/codeStepChecks.mts) and its
 * executor (actionExecutor/steps/code.mts) apply, with no I/O: what an input may be called and
 * which sandbox bridges the code may not name.
 */

export const MAX_INPUT_NAME = 60;

type Capabilities = { usesHttp?: boolean; usesDb?: boolean; tools?: unknown[] };
export type CodeAnalysisLike = { ok?: boolean; capabilities?: Capabilities };

/** A name a JavaScript reader can write as inputs.<name>: a letter, `_` or `$`, then also digits. */
export function isInputName(name: string): boolean {
    if (name.length === 0 || name.length > MAX_INPUT_NAME) return false;
    for (let i = 0; i < name.length; i += 1) {
        const c = name.charCodeAt(i);
        const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
        const digit = c >= 48 && c <= 57;
        if (!letter && !(digit && i > 0)) return false;
    }
    return name !== '__proto__';
}

/** The bridges of the automation sandbox the code names that an app's code step does not have. */
export function forbiddenBridges(analysis: CodeAnalysisLike | null | undefined): string[] {
    const caps = analysis && analysis.ok ? analysis.capabilities : null;
    if (!caps) return [];
    return [caps.usesHttp ? 'ctx.http' : '', Array.isArray(caps.tools) && caps.tools.length ? 'ctx.integrations' : '', caps.usesDb ? 'ctx.db' : ''].filter(Boolean);
}

/** Why the code may not run in an app because of the bridges it names, or null. */
export function bridgeRefusal(analysis: CodeAnalysisLike | null | undefined): string | null {
    const named = forbiddenBridges(analysis);
    if (!named.length) return null;
    return `A code step in an app has no network, integrations or database, and this code uses ${named.join(', ')}. Read data through the step's inputs and write it with an ordinary step after this one (vars.<resultVar>).`;
}
