/**
 * T.36: whether this server can send e-mail at all (a Resend API key is
 * configured). Callers use it to say so honestly instead of claiming an
 * e-mail went out. Kept apart from utils/mailer — a configuration question,
 * not a send function — so asking never depends on the mail module (which
 * several test suites replace wholesale).
 */
export const emailDeliveryConfigured = () => Boolean(process.env.RESEND_API_KEY?.trim());
