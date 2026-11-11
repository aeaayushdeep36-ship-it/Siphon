import { Component, type ReactNode } from 'react';

export class ReportBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <section className="panel" id="evidence" role="alert">
          The report view could not be loaded. Refresh the page to try again.
        </section>
      );
    return this.props.children;
  }
}
