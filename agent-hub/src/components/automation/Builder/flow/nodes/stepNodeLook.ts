import { type CardStyle, cardChrome, cardHeightForPorts, typeColorVar, typeTileStyle, CARD_W } from '../nodeTypeColors';

interface LookArgs {
    family: string | null;
    stepType: string | null;
    status: string | undefined;
    pinned: boolean | undefined;
    disabled: boolean | undefined;
    selected: boolean;
    editing: boolean;
    isSource: boolean;
    isTarget: boolean;
    errorTone: boolean;
    tileColor: string | null;
    far: boolean;
    dim: boolean;
    branchHandleCount: number;
}

/** The card's outline, tile and box styles for one render, from its run status, selection and zoom level. */
export function stepNodeLook({
    family, stepType, status, pinned, disabled, selected, editing, isSource, isTarget, errorTone, tileColor, far, dim, branchHandleCount,
}: LookArgs) {
    const chrome = cardChrome({
        group: family, type: stepType, status, pinned, disabled, selected: selected || editing, error: errorTone,
    });
    const { tile: tileStyle, glyph: glyphStyle } = typeTileStyle(family, { type: stepType, error: errorTone });
    if (tileColor && !errorTone) {
        tileStyle.background = `color-mix(in srgb, ${tileColor} 16%, transparent)`;
        tileStyle.color = tileColor;
    }
    if (far) {
        // Zoomed out, the tile IS the card: 48px, and the glyph grows with it.
        tileStyle.width = 48;
        tileStyle.height = 48;
        if (tileStyle.borderRadius === 9) tileStyle.borderRadius = 12;
        glyphStyle.width = 20;
        glyphStyle.height = 20;
    }
    const familyColor = errorTone ? 'var(--error)' : typeColorVar(family);

    // More than two output ports: the card grows a row per port (nodeTypeColors).
    const cardStyle: CardStyle = {
        width: CARD_W,
        height: cardHeightForPorts(branchHandleCount),
        boxSizing: 'border-box',
        background: 'var(--bg-card)',
        display: 'flex',
        alignItems: 'center',
        gap: far ? 12 : 10,
        padding: far ? '0 12px 0 16px' : (branchHandleCount > 0 ? '0 30px 0 14px' : '0 10px 0 14px'),
        ...chrome.style,
    };
    if (dim && cardStyle.opacity === 1) cardStyle.opacity = 0.7;
    if (isSource && !selected && !status) cardStyle.border = `2px dashed ${familyColor}`;
    if (isTarget && !editing && cardStyle.opacity === 1) cardStyle.opacity = 0.7;

    return { chrome, tileStyle, glyphStyle, familyColor, cardStyle };
}
