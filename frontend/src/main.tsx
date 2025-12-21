import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Note: Not using StrictMode to avoid double-initialization of terminal
createRoot(document.getElementById('root')!).render(<App />);
