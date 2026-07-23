import axios from 'axios';

// Every call site in this app uses a bare relative path (axios.get('/api/...')),
// relying on Vite's dev proxy to reach the backend. That proxy doesn't exist in
// production, where the frontend and backend are deployed as separate origins —
// this sets the same target those relative paths need, once, globally. Mirrors
// the VITE_BACKEND_URL pattern already used for the Socket.IO connection
// (see useSocket.ts). Falling back to '' preserves today's relative-path/dev-proxy
// behavior when the env var is unset.
axios.defaults.baseURL = import.meta.env.VITE_API_URL ?? '';
