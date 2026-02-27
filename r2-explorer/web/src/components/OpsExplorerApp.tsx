import type { ErrorInfo, JSX } from "preact";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { OpsExplorer } from "./OpsExplorer";

function logBoundaryError(error: unknown, errorInfo: ErrorInfo): void {
  console.error("OpsExplorer crashed", error, errorInfo);
}

export function OpsExplorerApp(): JSX.Element {
  return (
    <AppErrorBoundary onError={logBoundaryError}>
      <OpsExplorer />
    </AppErrorBoundary>
  );
}
