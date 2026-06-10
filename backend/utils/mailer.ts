import * as nodemailer from "nodemailer";

export const sendInviteEmail = async (to: string, inviteLink: string) => {
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;

  if (!emailUser || !emailPass) {
    console.warn('Email credentials not configured - invitations will not be sent');
    return { success: false, message: 'Email service not configured' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: emailUser, pass: emailPass },
    });

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