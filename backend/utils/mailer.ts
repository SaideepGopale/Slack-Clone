import * as nodemailer from "nodemailer";

export const sendInviteEmail = async (to: string, inviteLink: string) => {
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

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
  }
};