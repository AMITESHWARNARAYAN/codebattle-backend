import express from 'express';
import User from '../models/User.js';
import VerificationToken from '../models/VerificationToken.js';
import { generateVerificationToken, sendVerificationEmail, sendWelcomeEmail } from '../utils/emailService.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// @route   GET /api/verification/verify/:token
// @desc    Verify email with token
// @access  Public
router.get('/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Find verification token
    const verificationToken = await VerificationToken.findOne({ token });

    if (!verificationToken) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired verification token'
      });
    }

    // Find user and update verification status
    const user = await User.findById(verificationToken.userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email already verified'
      });
    }

    // Update user verification status
    user.isEmailVerified = true;
    await user.save();

    // Delete verification token
    await VerificationToken.deleteOne({ _id: verificationToken._id });

    // Send welcome email (non-blocking)
    sendWelcomeEmail(user.email, user.username).catch(err => 
      console.error('Welcome email failed:', err)
    );

    res.json({
      success: true,
      message: 'Email verified successfully! You can now login.',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        isEmailVerified: user.isEmailVerified
      }
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during verification'
    });
  }
});

// @route   POST /api/verification/resend
// @desc    Resend verification email
// @access  Protected
router.post('/resend', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email already verified'
      });
    }

    // Delete old verification tokens for this user
    await VerificationToken.deleteMany({ userId: user._id });

    // Generate new token
    const token = generateVerificationToken();

    // Save new token
    await VerificationToken.create({
      userId: user._id,
      token
    });

    // Send verification email
    await sendVerificationEmail(user.email, user.username, token);

    res.json({
      success: true,
      message: 'Verification email sent! Please check your inbox.'
    });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send verification email'
    });
  }
});

// @route   GET /api/verification/status
// @desc    Check verification status
// @access  Protected
router.get('/status', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    res.json({
      success: true,
      isEmailVerified: user.isEmailVerified,
      email: user.email
    });
  } catch (error) {
    console.error('Verification status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

export default router;
