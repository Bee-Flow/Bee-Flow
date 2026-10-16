/**
 * The extra fields of a header button of kind "github", as the public site
 * gets them from server/core/cms/legacyContent.js. An allow-list: other
 * buttons get none and stay plain links.
 */
export interface GithubCtaFields {
    kind?: 'github';
    repoUrl?: string;
    starsFallback?: number;
    starsText?: string;
    newTabText?: string;
}

interface GithubCtaSource {
    kind?: unknown;
    repoUrl?: unknown;
    starsFallback?: unknown;
    starsText?: unknown;
    newTabText?: unknown;
}

export function githubCtaFields(cta: GithubCtaSource): GithubCtaFields {
    if (cta.kind !== 'github') return {};
    return {
        kind: 'github',
        ...(typeof cta.repoUrl === 'string' ? { repoUrl: cta.repoUrl } : {}),
        ...(typeof cta.starsFallback === 'number' && Number.isFinite(cta.starsFallback)
            ? { starsFallback: cta.starsFallback } : {}),
        ...(typeof cta.starsText === 'string' ? { starsText: cta.starsText } : {}),
        ...(typeof cta.newTabText === 'string' ? { newTabText: cta.newTabText } : {}),
    };
}
