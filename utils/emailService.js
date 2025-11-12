import nodemailer from 'nodemailer';
import crypto from 'crypto';

// Create reusable transporter with SendGrid SMTP - optimized for Render
const createTransporter = () => {
  return nodemailer.createTransport({
    host: 'smtp.sendgrid.net',
    port: 465, // Use SSL instead of TLS for better compatibility
    secure: true, // Use SSL
    auth: {
      user: 'apikey', // This is literally the string 'apikey'
      pass: process.env.SENDGRID_API_KEY // Your SendGrid API key
    },
    pool: true, // Use connection pooling
    maxConnections: 5,
    maxMessages: 10,
    rateDelta: 1000,
    rateLimit: 5,
    connectionTimeout: 15000, // 15 seconds
    greetingTimeout: 15000,
    socketTimeout: 45000, // 45 seconds
    logger: true, // Enable logging for debugging
    debug: false // Disable detailed debug logs
  });
};

// Generate verification token
export const generateVerificationToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Send verification email
export const sendVerificationEmail = async (email, username, token) => {
  const transporter = createTransporter();
  
  const verificationUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email/${token}`;
  
  const mailOptions = {
    from: {
      name: 'CodeBattle',
      address: 'amiteshwarnarayan@gmail.com' // Your verified SendGrid sender
    },
    to: email,
    subject: 'Verify Your CodeBattle Account',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 10px;
            padding: 30px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          .content {
            background: white;
            border-radius: 8px;
            padding: 30px;
          }
          .logo {
            text-align: center;
            font-size: 32px;
            font-weight: bold;
            color: #667eea;
            margin-bottom: 20px;
          }
          h1 {
            color: #333;
            font-size: 24px;
            margin-bottom: 20px;
          }
          .button {
            display: inline-block;
            padding: 14px 28px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-weight: bold;
            margin: 20px 0;
            text-align: center;
          }
          .button:hover {
            opacity: 0.9;
          }
          .footer {
            text-align: center;
            color: white;
            margin-top: 20px;
            font-size: 14px;
          }
          .warning {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 12px;
            margin: 20px 0;
            border-radius: 4px;
          }
          .code {
            background: #f5f5f5;
            padding: 3px 6px;
            border-radius: 3px;
            font-family: monospace;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="content">
            <div class="logo">⚔️ CodeBattle</div>
            <h1>Welcome, ${username}! 🎉</h1>
            <p>Thank you for joining <strong>CodeBattle</strong> - the ultimate competitive coding platform!</p>
            <p>To start your coding journey and access all features, please verify your email address by clicking the button below:</p>
            
            <div style="text-align: center;">
              <a href="${verificationUrl}" class="button">
                ✓ Verify Email Address
              </a>
            </div>
            
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #667eea;">
              ${verificationUrl}
            </p>
            
            <div class="warning">
              <strong>⏰ Note:</strong> This verification link will expire in <strong>1 hour</strong> for security reasons.
            </div>
            
            <p>Once verified, you can:</p>
            <ul>
              <li>🎯 Challenge friends in real-time coding battles</li>
              <li>🏆 Compete in matchmaking with ELO rankings</li>
              <li>💡 Solve daily challenges and build streaks</li>
              <li>📊 Track your progress and climb the leaderboard</li>
            </ul>
            
            <p style="margin-top: 30px; color: #666; font-size: 14px;">
              If you didn't create an account with CodeBattle, please ignore this email.
            </p>
          </div>
          
          <div class="footer">
            <p>© 2025 CodeBattle. All rights reserved.</p>
            <p>Happy Coding! 💻</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
      Welcome to CodeBattle, ${username}!
      
      Please verify your email address by clicking the link below:
      ${verificationUrl}
      
      This link will expire in 1 hour.
      
      If you didn't create an account with CodeBattle, please ignore this email.
      
      Happy Coding!
      CodeBattle Team
    `
  };

  // Retry logic for connection timeouts
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📧 Attempt ${attempt}/${maxRetries} - Sending verification email to: ${email}`);
      const info = await transporter.sendMail(mailOptions);
      console.log('✅ Verification email sent successfully!');
      console.log('Message ID:', info.messageId);
      return true;
    } catch (error) {
      lastError = error;
      console.error(`❌ Attempt ${attempt}/${maxRetries} failed:`, error.message);
      
      // Wait before retry (exponential backoff)
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000; // 2s, 4s
        console.log(`⏳ Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // All retries failed
  console.error('❌ All email sending attempts failed:', lastError.message);
  throw new Error('Failed to send verification email after multiple attempts');
};

// Send welcome email after verification
export const sendWelcomeEmail = async (email, username) => {
  const transporter = createTransporter();
  
  const mailOptions = {
    from: {
      name: 'CodeBattle',
      address: 'amiteshwarnarayan@gmail.com' // Your verified SendGrid sender
    },
    to: email,
    subject: 'Welcome to CodeBattle! 🎉',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 10px;
            padding: 30px;
          }
          .content {
            background: white;
            border-radius: 8px;
            padding: 30px;
          }
          .logo {
            text-align: center;
            font-size: 32px;
            font-weight: bold;
            color: #667eea;
            margin-bottom: 20px;
          }
          .button {
            display: inline-block;
            padding: 14px 28px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-weight: bold;
            margin: 10px 0;
          }
          .feature {
            background: #f8f9fa;
            padding: 15px;
            margin: 10px 0;
            border-radius: 6px;
            border-left: 4px solid #667eea;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="content">
            <div class="logo">⚔️ CodeBattle</div>
            <h1>🎉 Email Verified Successfully!</h1>
            <p>Hey ${username}! 👋</p>
            <p>Your email has been verified and your account is now fully active!</p>
            
            <h2>🚀 Quick Start Guide:</h2>
            
            <div class="feature">
              <strong>1️⃣ Solo Practice</strong><br>
              Sharpen your skills with unlimited practice problems
            </div>
            
            <div class="feature">
              <strong>2️⃣ Matchmaking</strong><br>
              Battle random opponents in real-time coding duels
            </div>
            
            <div class="feature">
              <strong>3️⃣ Friend Challenges</strong><br>
              Challenge your friends to coding battles
            </div>
            
            <div class="feature">
              <strong>4️⃣ Daily Challenges</strong><br>
              Solve daily problems and build your streak
            </div>
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard" class="button">
                Start Coding Now! 🔥
              </a>
            </div>
            
            <p style="margin-top: 30px; text-align: center; color: #666;">
              Good luck and may the best coder win! 💻⚡
            </p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  // Retry logic for connection timeouts
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📧 Attempt ${attempt}/${maxRetries} - Sending welcome email to: ${email}`);
      const info = await transporter.sendMail(mailOptions);
      console.log('✅ Welcome email sent successfully!');
      return true;
    } catch (error) {
      lastError = error;
      console.error(`❌ Attempt ${attempt}/${maxRetries} failed:`, error.message);
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // Don't throw error for welcome email failure, just log it
  console.error('❌ All welcome email attempts failed, but continuing...');
  return false;
};

// Resend verification email
export const resendVerificationEmail = async (email, username, token) => {
  return await sendVerificationEmail(email, username, token);
};
