import * as nodemailer from "nodemailer";

// Reusable transporter creator from development branch
const createTransporter = () =>
  nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

// 1. Send Invite Email Function
export const sendInviteEmail = async (to: string, inviteLink: string) => {
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
      subject: "You're invited 🚀",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2>Join Smart Chat App</h2>
          <p>You have been invited to collaborate on our Smart Chat App!</p>
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

// 2. Send Reset Password Email Function
export const sendResetPasswordEmail = async (to: string, resetLink: string) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('Email credentials not configured - reset email will not be sent');
    return;
  }

  try {
    const transporter = createTransporter();

    const info = await transporter.sendMail({
      from: `"Smart Chat App" <${process.env.EMAIL_USER}>`,
      to,
      subject: "Reset your Smart Chat App password",
      html: `
        <h2>Password Reset</h2>
        <p>We received a request to reset your password. Click the link below to set a new password. The link will expire in one hour.</p>
        <a href="${resetLink}">${resetLink}</a>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });

    console.log("Reset email sent:", info.messageId);
  } catch (error: any) {
    console.error("Reset email error:", error.message || error);
    throw error;
  }
};