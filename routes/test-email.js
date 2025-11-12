import express from 'express';
import { sendVerificationEmail } from '../utils/emailService.js';

const router = express.Router();

// @route   GET /api/test-email/:email
// @desc    Test email sending (REMOVE IN PRODUCTION)
// @access  Public
router.get('/send/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    console.log('🧪 Testing email send to:', email);
    
    await sendVerificationEmail(email, 'TestUser', 'test-token-12345');
    
    res.json({
      success: true,
      message: 'Test email sent successfully! Check your inbox.',
      email: email
    });
  } catch (error) {
    console.error('❌ Test email failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send test email',
      error: error.message,
      stack: error.stack
    });
  }
});

export default router;
