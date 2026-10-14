import { spaceSteps } from '../styleResolver';
import type { RuntimeNode } from './runtimeNode.types';

/** App Studio runtime — 'spacer'. Spec: server/appStudio/componentSpecs.js. */

interface AppSpacerProps {
    node: RuntimeNode<{ steps?: number }>;
}

export default function AppSpacer({ node }: AppSpacerProps) {
    const steps = Number.isFinite(node.props?.steps) ? (node.props.steps as number) : 2;
    // Each spacer step is two spacing steps (8px × density) of empty height.
    return <div aria-hidden="true" style={{ height: spaceSteps(steps * 2) }} />;
}
