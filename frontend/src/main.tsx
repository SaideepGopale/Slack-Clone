import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './lib/api';
import { applyTheme, watchSystemTheme } from './lib/theme';

// P2 Phase J: apply the saved light/dark choice before the first paint.
applyTheme();
watchSystemTheme();

// Suppress benign Vite/WebSocket rejections in development environment
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason === 'WebSocket closed without opened.' || 
        (typeof event.reason === 'string' && event.reason.includes('WebSocket'))) {
      event.preventDefault();
      console.warn('Caught and suppressed benign WebSocket rejection:', event.reason);
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
