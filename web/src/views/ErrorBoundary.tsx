import { Component, type ReactNode } from "react";
import { EmptyState } from "../ds/EmptyState";

/**
 * Catches a crash inside one tab. Without this, an unexpected field in any
 * upstream response unmounts the whole app and leaves a blank page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[faf-web] tab crashed:", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <EmptyState
          icon="alert"
          title="This tab couldn't be shown"
          hint="The data it got back wasn't in the expected shape. The other tabs still work."
          bordered
        />
      );
    }
    return this.props.children;
  }
}
