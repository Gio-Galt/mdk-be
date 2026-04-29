import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import MiningWidget from './MiningWidget.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MiningWidget />
  </StrictMode>
);
