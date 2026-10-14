/** What a gamma_* tool answered, once it is worth previewing. */
export interface GammaPreview {
    generationId: string | null;
    status: string;
    gammaId: string | null;
    gammaUrl: string | null;
    exportUrl: string | null;
    templateGammaId: string | null;
    templateUrl: string | null;
    sourceTool: string;
}

/** What a gamma_* tool answers with, as far as the preview cares. */
interface GammaToolResult {
    error?: unknown;
    generationId?: string;
    status?: string;
    gammaId?: string;
    gammaUrl?: string;
    exportUrl?: string;
    templateGammaId?: string;
    templateUrl?: string;
}

export const extractGammaPreview = (toolName: string | undefined, result: unknown): GammaPreview | null => {
    if (!toolName?.startsWith?.('gamma_')) return null;
    let raw: unknown = result;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { return null; }
    }
    if (!raw || typeof raw !== 'object') return null;
    const parsed = raw as GammaToolResult;
    if (parsed.error) return null;
    if (!parsed.generationId && !parsed.gammaUrl) return null;
    return {
        generationId: parsed.generationId || null,
        status: parsed.status || (parsed.gammaUrl ? 'completed' : 'pending'),
        gammaId: parsed.gammaId || null,
        gammaUrl: parsed.gammaUrl || null,
        exportUrl: parsed.exportUrl || null,
        templateGammaId: parsed.templateGammaId || null,
        templateUrl: parsed.templateUrl || null,
        sourceTool: toolName,
    };
};
