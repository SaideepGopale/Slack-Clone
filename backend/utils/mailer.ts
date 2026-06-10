import * as nodemailer from "nodemailer";

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

export const sendInviteEmail = async (
  to: string,
  inviteLink: string
) => {
  try {
    const transporter = createTransporter();

    const info = await transporter.sendMail({
      from: `"Smart Chat App" <${process.env.EMAIL_USER}>`,
      to,
      subject: "You're invited 🚀",
      html: `
        <h2>Join Smart Chat App</h2>
        <p>You have been invited</p>
        <a href="${inviteLink}">Accept Invite</a>
      `,
    });

    console.log("Email sent:", info.messageId);
  } catch (error) {
    console.error("Email error:", error);
    throw error;
  }
};

export const sendResetPasswordEmail = async (
  to: string,
  resetLink: string
) => {
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
  } catch (error) {
    console.error("Reset email error:", error);
    throw error;
  }
};