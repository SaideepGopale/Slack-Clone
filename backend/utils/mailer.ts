import * as nodemailer from "nodemailer";

// Port 465 (implicit TLS) instead of 587 (STARTTLS) — some hosts (Render's
// free tier included) block outbound 587 to fight spam abuse, which showed
// up as sendOtpEmail hanging for a full 2 minutes before timing out rather
// than failing fast. 465 is more often left open. The explicit *Timeout
// options are the other half of that fix: without them nodemailer falls
// back to very long OS-level defaults, so a still-blocked port silently
// hangs the request instead of erroring quickly.
const createTransporter = () =>
  nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });

// 1. Send Invite Email Function
export const sendInviteEmail = async (to: string, inviteLink: string, workspaceName: string) => {
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;

  if (!emailUser || !emailPass) {
    console.warn('Email credentials not configured - invitations will not be sent');
    return { success: false, message: 'Email service not configured' };
  }

  try {
    const transporter = createTransporter();

    const info = await transporter.sendMail({
      from: `"Smart Chat App" <${emailUser}>`,
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

    console.log("Email sent successfully:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error("Email error:", error.message);
    throw new Error(`Failed to send invitation email: ${error.message}`);
  }
};

// 2. Send Sign-Up OTP Email Function
export const sendOtpEmail = async (to: string, code: string) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    // Unlike invites/reset links, there's no fallback way to hand someone a
    // verification code if the email never sends — fail the signup request
    // loudly rather than leave them stuck on a code that never arrives.
    throw new Error('Email service is not configured — cannot send verification codes.');
  }

  const transporter = createTransporter();

  try {
    const info = await transporter.sendMail({
      from: `"Slick Workspace" <${process.env.EMAIL_USER}>`,
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
    console.log('OTP email sent:', info.messageId);
  } catch (error: any) {
    console.error('OTP email error:', error.message || error);
    throw new Error(`Failed to send verification email: ${error.message}`);
  }
};

// 3. Send Reset Password Email Function — used by both self-service
// "forgot password" and the admin "force reset" action.
export const sendResetPasswordEmail = async (to: string, resetLink: string) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('Email credentials not configured - reset email will not be sent');
    return;
  }

  try {
    const transporter = createTransporter();

    const info = await transporter.sendMail({
      from: `"Slick Workspace" <${process.env.EMAIL_USER}>`,
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

    console.log("Reset email sent:", info.messageId);
  } catch (error: any) {
    console.error("Reset email error:", error.message || error);
    throw error;
  }
};