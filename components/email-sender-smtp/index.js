const fs = require('fs');
const nodemailer = require('nodemailer');

async function main() {
  const inputs = JSON.parse(fs.readFileSync(0, 'utf-8'));

  // Validate required inputs
  if (!inputs.smtpHost) throw new Error("'smtpHost' is required");
  if (!inputs.smtpPort) throw new Error("'smtpPort' is required");
  if (!inputs.smtpUsername) throw new Error("'smtpUsername' is required");
  if (!inputs.smtpPassword) throw new Error("'smtpPassword' is required");
  if (!inputs.fromEmail) throw new Error("'fromEmail' is required");
  if (!inputs.toEmails) throw new Error("'toEmails' is required");
  if (!inputs.subject) throw new Error("'subject' is required");
  if (!inputs.body) throw new Error("'body' is required");

  // Parse comma-separated email lists
  const toEmails = inputs.toEmails.split(',').map(email => email.trim());
  const ccEmails = inputs.ccEmails ? inputs.ccEmails.split(',').map(email => email.trim()) : [];
  const bccEmails = inputs.bccEmails ? inputs.bccEmails.split(',').map(email => email.trim()) : [];
  const attachments = inputs.attachments ? inputs.attachments.split(',').map(path => path.trim()) : [];

  // Validate email addresses
  const emailRegex = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/;
  if (!toEmails.every(email => emailRegex.test(email))) {
    throw new Error("Invalid recipient email address(es)");
  }
  if (ccEmails.length > 0 && !ccEmails.every(email => emailRegex.test(email))) {
    throw new Error("Invalid CC email address(es)");
  }
  if (bccEmails.length > 0 && !bccEmails.every(email => emailRegex.test(email))) {
    throw new Error("Invalid BCC email address(es)");
  }

  // Create transporter
  const transporter = nodemailer.createTransport({
    host: inputs.smtpHost,
    port: inputs.smtpPort,
    secure: inputs.smtpPort === 465,
    tls: inputs.useTLS ? { ciphers: 'SSLv3' } : null,
    auth: {
      user: inputs.smtpUsername,
      pass: inputs.smtpPassword
    }
  });

  // Prepare mail options
  const mailOptions = {
    from: inputs.fromEmail,
    to: toEmails.join(', '),
    subject: inputs.subject,
    text: inputs.isHtml ? undefined : inputs.body,
    html: inputs.isHtml ? inputs.body : undefined,
    cc: ccEmails.length > 0 ? ccEmails.join(', ') : undefined,
    bcc: bccEmails.length > 0 ? bccEmails.join(', ') : undefined,
    attachments: attachments.map(path => ({ path }))
  };

  try {
    const result = await transporter.sendMail(mailOptions);
    
    console.log(JSON.stringify({
      success: true,
      messageId: result.messageId,
      acceptedRecipients: result.accepted.join(', '),
      rejectedRecipients: result.rejected.join(', '),
      error: null
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
    process.exit(1);
  }
}

main().catch(e => {
  process.stderr.write(e.message);
  process.exit(1);
});