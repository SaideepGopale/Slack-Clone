import { User } from '../types';

// Whoever has role: 'ADMIN' in the database lands in the admin panel instead
// of the regular workspace — matches the backend's own source of truth
// (see admin.middleware.ts's isAdminUser). This used to be a hardcoded
// `user.email === 'admin@slack.com'` check, which silently broke the moment
// that specific account stopped existing (e.g. after a database reset created
// a differently-named admin account with the correct role but a new email).
export const isAdminAccount = (user: User | null) => user?.role === 'ADMIN';
