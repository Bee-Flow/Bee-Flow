import type { ComponentType } from 'react';
import AddBlockDialogJs from '../dialogs/AddBlockDialog';
import InspectorHostJs from '../inspector/InspectorHost';
import NavigatorPanelJs from '../navigator/NavigatorPanel';
import PreviewStageJs from '../preview/PreviewStage';

// The builder's panes are plain JS: TypeScript reads a `= null` default as
// "this prop is always null" and every destructured prop without a default as
// required. These are the props the panel container passes (same approach as
// blog/jsComponents.ts).

export const NavigatorPanel = NavigatorPanelJs;

export const InspectorHost = InspectorHostJs;

export const PreviewStage = PreviewStageJs;

export const AddBlockDialog = AddBlockDialogJs;
