import { readableForeground } from '../../components/theme/applyTheme';

/**
 * Applies the embedder's font, size and bubble-colour customisation from the
 * URL parameters: loads the Google Font and injects the overriding styles.
 */
export function applyEmbedCustomization(): void {
    const params = new URLSearchParams(window.location.search);
    const font = params.get('font');
    const fontSize = params.get('fontSize');
    const lineHeight = params.get('lineHeight');
    const userColor = params.get('userColor');
    const assistantColor = params.get('assistantColor');

    if (font) {
        // Load Google Font dynamically
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@300;400;500;600;700&display=swap`;
        document.head.appendChild(link);
    }

    // Inject overriding styles
    const style = document.createElement('style');
    const rules = [];

    // Font family
    if (font) rules.push(`html, body, body * { font-family: '${font}', sans-serif !important; }`);

    // Font size & line height
    if (fontSize || lineHeight) {
        const textOverrides = [];
        if (fontSize) textOverrides.push(`font-size: ${fontSize}px !important`);
        if (lineHeight) textOverrides.push(`line-height: ${lineHeight} !important`);
        rules.push(`body, .markdown-content, .markdown-content p, .markdown-content li, .markdown-content span, textarea, input { ${textOverrides.join('; ')}; }`);
    }

    // Bubble colors — override CSS variables used by MessageItem. Derive
    // an AA-readable foreground at the same time so dark-accent embeds keep
    // their bubble text legible.
    if (userColor) {
        const fg = readableForeground(userColor);
        rules.push(`:root { --accent-primary: ${userColor} !important; --accent-primary-hover: ${userColor} !important; --accent-primary-fg: ${fg} !important; --user-bubble-bg: ${userColor} !important; --user-bubble-fg: ${fg} !important; }`);
    }
    if (assistantColor) {
        rules.push(`:root { --bg-secondary: ${assistantColor} !important; }`);
    }

    if (rules.length) {
        style.textContent = rules.join('\n');
        document.head.appendChild(style);
    }
}
