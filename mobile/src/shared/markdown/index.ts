/**
 * Markdown for chat answers and anything else the server writes in it — the
 * web's MarkdownRenderer, natively (Markdown.tsx says what it draws).
 * `@/shared/markdown/Markdown` still resolves for the callers that import it
 * by file.
 *
 * Besides the renderer: the link and image address rules (links.ts), the
 * provider that teaches it the app's screens, the scroll host that lets
 * `#anchor` links move a screen, and the full-screen image viewer, which the
 * chat's generated images share with pictures inside an answer. And the map
 * embed's reading (mapModel.ts), which the chat's map card shares with a
 * ```map fence: both open Maps on the place or route an embed URL shows.
 */

export { imageSource, linkTarget, type AppLinkTranslator, type ImageSource, type LinkTarget, type MarkdownImage } from './links';
export { InlineMarkdown, type InlineMarkdownProps } from './InlineMarkdown';
export { Markdown } from './Markdown';
export { MarkdownLinkProvider, useAppLinkTranslator } from './MarkdownLinkProvider';
export { plainMarkdown } from './plain';
export { MarkdownScrollHostProvider, scrollViewHost, type MarkdownScrollHost } from './render/anchors';
export { ImageLightbox } from './renderers/image/ImageLightbox';
export { mapsLinkFor, readEmbed, type MapRoute } from './renderers/map/mapModel';
