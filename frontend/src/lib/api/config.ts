import axios from 'axios';
import { rejectPathTraversal } from './pathGuard';

// (Moved verbatim from src/lib/api.ts in F1 so `import './lib/api'` now
// resolves to this directory's index, which imports this file first.)
// Every call site in this app uses a bare relative path (axios.get('/api/...')),
// relying on Vite's dev proxy to reach the backend. That proxy doesn't exist in
// production, where the frontend and backend are deployed as separate origins —
// this sets the same target those relative paths need, once, globally. Mirrors
// the VITE_BACKEND_URL pattern already used for the Socket.IO connection
// (see useSocket.ts). Falling back to '' preserves today's relative-path/dev-proxy
// behavior when the env var is unset.
axios.defaults.baseURL = import.meta.env.VITE_API_URL ?? '';

// P1-E (FA-SEC-04): every request through the shared (default) axios instance
// is refused before dispatch if its path contains a "." or ".." segment (see
// pathGuard.ts). Registered as a normal asynchronous interceptor on purpose:
// when a *synchronous* interceptor throws, axios hands the error to that
// interceptor's error handler and then still dispatches the request.
// (Optional chaining only matters to unit tests that replace axios with a
// partial mock; the real axios always has interceptors.)
axios.interceptors?.request?.use(rejectPathTraversal);
