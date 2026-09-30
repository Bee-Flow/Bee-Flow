/** Lines of SVG text centred on a point: a node's label, a link's label, a subgraph's title. */

import React from 'react';
import { Text as SvgText, TSpan } from 'react-native-svg';

import { LINE_HEIGHT } from './flowchartLayout';
import { MERMAID_FONT_SIZE } from './mermaidTheme';

export function CentredLines({ x, y, lines, color }: { x: number; y: number; lines: readonly string[]; color: string }) {
    const top = y - ((lines.length - 1) * LINE_HEIGHT) / 2 + MERMAID_FONT_SIZE * 0.35;
    return (
        <SvgText fontSize={MERMAID_FONT_SIZE} fill={color} textAnchor="middle">
            {lines.map((line, i) => (
                <TSpan key={i} x={x} y={top + i * LINE_HEIGHT}>
                    {line}
                </TSpan>
            ))}
        </SvgText>
    );
}

