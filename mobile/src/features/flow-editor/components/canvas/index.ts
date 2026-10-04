/**
 * The Canvas tab of the build screen: the automation as a pan-and-zoom diagram
 * (CanvasView), and the pure model under it — the scene (scene.ts), the
 * camera math (viewport.ts), hand-drawn connections (connect.ts) and moves
 * and Arrange (moves.ts).
 */

export { CanvasView, type CanvasViewProps } from './CanvasView';
export { buildScene, type Scene, type SceneNode } from './scene';
export type { SceneEdge, AddSpot } from './sceneEdges';
export { connectNodes, connectRefusal, removeConnection, type ConnectRefusal, type ConnectRequest } from './connect';
export { arrangeFlow, moveNode, ARRANGE_CHOICES } from './moves';
