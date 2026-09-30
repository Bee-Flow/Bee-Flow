/** The sizes a typeset formula takes, as styles (they vary per formula, so no sheet holds them). */

import type { ViewStyle } from 'react-native';

import type { MathSvg } from './mathSvg';

export function inlineMathStyle(math: MathSvg): ViewStyle {
    return { width: math.width, height: math.height, transform: [{ translateY: math.depth }] };
}

export function blockMathStyle(math: MathSvg): ViewStyle {
    return { width: math.width, height: math.height };
}
