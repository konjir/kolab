import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// The design system's three faces, served by Kolab itself, so the page loads nothing from a third party.
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/instrument-sans/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
// The design system's tokens, generated from @konjir/brand (npm run brand), then the page's own styles.
import './brand.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
