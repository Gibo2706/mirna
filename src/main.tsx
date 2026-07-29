import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from '@/app/App';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { PwaStatus } from '@/app/PwaStatus';
import { ToastProvider } from '@/components/ToastProvider';
import '@/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <App />
          <PwaStatus />
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
