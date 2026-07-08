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
        <div class="console">
          <div class="workspace" style={{ gridTemplateColumns: "1fr" }}>
            <section class="panel" role="alert" style={{ maxWidth: "42rem", margin: "3rem auto" }}>
              <div class="panel-head">
                <span class="tag">
                  <span class="idx" style={{ color: "var(--danger)" }}>!!</span>
                  Console error
                </span>
              </div>
              <div class="panel-body stack">
                <div class="alert">A runtime error interrupted the operator console.</div>
                <div class="mono faint" style={{ fontSize: "0.8rem", overflowWrap: "anywhere" }}>
                  {this.state.message}
                </div>
                <div class="row">
                  <button type="button" class="btn primary" onClick={this.resetBoundary}>
                    Retry
                  </button>
                  <button type="button" class="btn ghost" onClick={() => window.location.reload()}>
                    Reload page
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      );
    }

    return <>{this.props.children}</>;
  }
}
