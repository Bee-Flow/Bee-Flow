// The solution_deployments row as solutionStageStore hands it out (camelCase, mapped), named once
// for the JSDoc of the stage pipeline in this folder. The stage row is ./model's StageRow.
export type DeploymentRow = NonNullable<ReturnType<typeof import('../../stores/solutionStage/deploymentModel').mapDeployment>>;
