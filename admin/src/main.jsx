import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/base.css';
import './styles/layout.css';
import './styles/messages.css';

// Registered on load, not on first push opt-in: an installable app needs an
// active service worker before the browser will offer to install it, and the
// panel has to be installed *before* iOS will deliver a single notification.
// Waiting for the opt-in would make the two prerequisites circular.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] registration failed:', err.message);
    });
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
