import { spaceSteps } from '../styleResolver';
import type { NodeProps } from './appNode.types';

/** App Studio runtime — 'spacer'. Spec: server/appStudio/componentSpecs.js. */

export default function AppSpacer({ node }: NodeProps<{ steps?: number }>) {
    const steps = Number.isFinite(node.props?.steps) ? (node.props as { steps?: number }).steps as number : 2;
    // Each spacer step is two spacing steps (8px × density) of empty height.
    return <div aria-hidden="true" style={{ height: spaceSteps(steps * 2) }} />;
}
