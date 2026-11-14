import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../aviary-kit/fonts';
import { ThemeProvider } from '../aviary-kit/theme';
import { AccessGate } from './AccessGate';
import { App, DURABLE_ACCENT } from './App';
import '@xyflow/react/dist/style.css';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 2000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ThemeProvider storageKey="aviary-durable-theme" accent={DURABLE_ACCENT}>
      <QueryClientProvider client={queryClient}>
        <AccessGate>
          <App />
        </AccessGate>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
