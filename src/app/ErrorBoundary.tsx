import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="grid min-h-dvh place-items-center p-5">
        <div className="w-full max-w-md rounded-3xl border bg-surface p-6 text-center shadow-xl">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-danger-soft text-danger">
            <AlertTriangle />
          </div>
          <h1 className="mt-5 text-xl font-bold">Nešto nije učitano kako treba</h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            Finansijski podaci su ostali na uređaju. Osvežite aplikaciju i pokušajte ponovo.
          </p>
          <Button className="mt-6 w-full" onClick={() => window.location.reload()}>
            <RefreshCw size={18} />
            Osveži aplikaciju
          </Button>
        </div>
      </main>
    );
  }
}
