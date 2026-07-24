import { Resend } from 'resend';

// Switched from Gmail SMTP (nodemailer) to Resend's HTTP API — Render's free
// tier silently blocks/times-out outbound SMTP (ports 587 and 465 both hung
// for minutes instead of failing), which is a known anti-spam measure on
// several free PaaS tiers. Resend runs entirely over HTTPS (443), which
// isn't subject to that restriction.
//
// `onboarding@resend.dev` is Resend's built-in test sender — it works
// immediately for any recipient with zero domain setup. Swap the `from`
// address to a verified domain once you have one for a production-grade
// sender identity.
const FROM_ADDRESS = 'Slick Workspace <onboarding@resend.dev>';

const getClient = (): Resend | null => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
};

// 1. Send Invite Email Function
export const sendInviteEmail = async (to: string, inviteLink: string, workspaceName: string) => {
  const resend = getClient();
  if (!resend) {
    console.warn('RESEND_API_KEY not configured - invitations will not be sent');
    return { success: false, message: 'Email service not configured' };
  }

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `You've been invited to join ${workspaceName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h1>Join your team on ${workspaceName}</h1>
        <p>You have been invited to collaborate on <strong>${workspaceName}</strong>!</p>
        <p>
          <a href="${inviteLink}" style="display: inline-block; padding: 12px 24px; background-color: #4a154b; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
            Accept Invite
          </a>
        </p>
        <p style="color: #999; font-size: 12px;">Or copy this link: ${inviteLink}</p>
      </div>
    `,
  });

  if (error) {
    console.error('Email error:', error.message);
    throw new Error(`Failed to send invitation email: ${error.message}`);
  }

  console.log('Email sent successfully:', data?.id);
  return { success: true, messageId: data?.id };
};

// 2. Send Sign-Up OTP Email Function
export const sendOtpEmail = async (to: string, code: string) => {
  const resend = getClient();
  if (!resend) {
    // Unlike invites/reset links, there's no fallback way to hand someone a
    // verification code if the email never sends — fail the signup request
    // loudly rather than leave them stuck on a code that never arrives.
    throw new Error('Email service is not configured — cannot send verification codes.');
  }

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `${code} is your Slick Workspace verification code`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; border: 1px solid #ece9f4; border-radius: 16px;">
        <div style="width: 40px; height: 40px; background: #2e1065; border-radius: 10px; color: white; font-weight: bold; font-size: 18px; display: flex; align-items: center; justify-content: center; margin-bottom: 24px;">S</div>
        <h2 style="color: #111827; margin: 0 0 8px;">Verify your email</h2>
        <p style="color: #6b7280; font-size: 14px; margin: 0 0 24px;">Enter this code to finish creating your Slick Workspace account. It expires in 5 minutes.</p>
        <div style="background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #4c1d95;">${code}</span>
        </div>
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">If you didn't request this, you can safely ignore this email — no account will be created without this code.</p>
      </div>
    `,
  });

  if (error) {
    console.error('OTP email error:', error.message);
    throw new Error(`Failed to send verification email: ${error.message}`);
  }

  console.log('OTP email sent:', data?.id);
};

// 3. Send Reset Password Email Function — used by both self-service
// "forgot password" and the admin "force reset" action.
export const sendResetPasswordEmail = async (to: string, resetLink: string) => {
  const resend = getClient();
  if (!resend) {
    console.warn('RESEND_API_KEY not configured - reset email will not be sent');
    return;
  }

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: 'Password Reset Request - Slick Workspace',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #350d36;">Reset Your Password</h2>
        <p>We received a request to reset your password for your Slick Workspace account.</p>
        <p>Click the button below to set a new password. This link is valid for <strong>15 minutes</strong>.</p>
        <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background-color: #e8912d; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; margin-top: 15px;">Set New Password</a>
        <p style="margin-top: 25px; font-size: 12px; color: #888;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });

  if (error) {
    console.error('Reset email error:', error.message);
    throw new Error(error.message);
  }

  console.log('Reset email sent:', data?.id);
};
