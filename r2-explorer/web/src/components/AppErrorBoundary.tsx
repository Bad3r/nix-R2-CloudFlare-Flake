import { Component } from "preact";
import type { ComponentChildren, ErrorInfo, JSX } from "preact";

type AppErrorBoundaryProps = {
  children: ComponentChildren;
  onError?: (error: unknown, errorInfo: ErrorInfo) => void;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

function boundaryMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Unexpected runtime error.";
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
    return {
      hasError: true,
      message: boundaryMessage(error),
    };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
  }

  private resetBoundary = (): void => {
    this.setState({
      hasError: false,
      message: "",
    });
  };

  render(): JSX.Element {
    if (this.state.hasError) {
      return (
        <main className="shell">
          <section className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Console Error</h2>
            </div>
            <div className="panel-content stack">
              <div className="badge danger">A runtime error interrupted the operator console.</div>
              <div className="mono subtle">{this.state.message}</div>
              <div className="row">
                <button className="primary" onClick={this.resetBoundary}>
                  Retry
                </button>
                <button className="ghost" onClick={() => window.location.reload()}>
                  Reload page
                </button>
              </div>
            </div>
          </section>
        </main>
      );
    }

    return <>{this.props.children}</>;
  }
}
