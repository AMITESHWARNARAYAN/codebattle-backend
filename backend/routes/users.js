import express from 'express';
import User from '../models/User.js';
import { protect, optionalAuth, invalidateUserCache } from '../middleware/auth.js';
import bcrypt from 'bcryptjs';
import Match from '../models/Match.js';

const router = express.Router();

// @route   GET /api/users/leaderboard
// @desc    Get top users by rating
// @access  Public / Optional Auth
router.get('/leaderboard', optionalAuth, async (req, res) => {
  try {
    let limit = parseInt(req.query.limit) || 100;

    // Validate limit to prevent abuse
    if (limit < 1 || limit > 1000) {
      limit = 100;
    }

    const users = await User.find()
      .select('username rating highestRating contestRating contestHighestRating wins losses draws totalMatches')
      .sort({ rating: -1 })
      .limit(limit);

    const leaderboard = users.map((user, index) => ({
      rank: index + 1,
      username: user.username,
      rating: user.rating,
      highestRating: user.highestRating,
      contestRating: user.contestRating,
      contestHighestRating: user.contestHighestRating,
      wins: user.wins,
      losses: user.losses,
      draws: user.draws,
      totalMatches: user.totalMatches,
      winRate: user.totalMatches > 0 ? ((user.wins / user.totalMatches) * 100).toFixed(1) : 0,
    }));

    res.json(leaderboard);
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/stats
// @desc    Get current user's detailed stats
// @access  Private
router.get('/stats', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password')
      .populate({
        path: 'matchHistory',
        options: { limit: 10, sort: { createdAt: -1 } },
        populate: { path: 'problem players winner' }
      });

    res.json(user);
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/rating-history
// @desc    Get current user's rating history
// @access  Private
router.get('/rating-history', protect, async (req, res) => {
  try {
    // In a real app, we would query a separate RatingHistory model
    // For now, we'll mock it or return data from matches if available
    // This is a placeholder for the actual implementation
    const user = await User.findById(req.user._id);

    // Mock data structure for frontend graph
    const history = [
      { date: new Date(user.createdAt), rating: 0 },
      // ... fetch actual history from Match or Contest results
    ];

    res.json(history);
  } catch (error) {
    console.error('Get rating history error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/badges
// @desc    Get current user's badges
// @access  Private
router.get('/badges', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('badges streak');

    // Calculate potential new badges based on stats
    // This is a simple implementation, in a real app this might be a separate service
    const newBadges = [];

    // Streak badges
    if (user.streak.current >= 7 && !user.badges.includes('Daily Streak')) {
      newBadges.push('Daily Streak');
    }

    // If new badges earned, save them
    if (newBadges.length > 0) {
      user.badges.push(...newBadges);
      await user.save();
    }

    res.json({
      badges: user.badges,
      streak: user.streak
    });
  } catch (error) {
    console.error('Get badges error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/search
// @desc    Search users by username
// @access  Private
router.get('/search', protect, async (req, res) => {
  try {
    const { query } = req.query;

    if (!query || query.length < 2) {
      return res.status(400).json({ message: 'Search query must be at least 2 characters' });
    }

    // Escape special regex characters to prevent ReDoS attacks
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const users = await User.find({
      username: { $regex: escapedQuery, $options: 'i' }
    })
      .select('username rating isOnline')
      .limit(10);

    res.json(users);
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/:username
// @desc    Get user profile by username
// @access  Public / Optional Auth
router.get('/:username', optionalAuth, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username })
      .select('-password -email');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Fetch match history for battle rating graph
    const matches = await Match.find({
      players: user._id,
      status: 'completed'
    }).sort({ endTime: 1 }).select('endTime ratingChanges');

    const ratingHistory = [{
      date: user.createdAt,
      rating: 0 // Starting battle rating
    }];

    for (const match of matches) {
      const userChange = match.ratingChanges?.find(rc => rc.userId.toString() === user._id.toString());
      if (userChange) {
        ratingHistory.push({
          date: match.endTime,
          rating: userChange.newRating
        });
      }
    }

    // Build contest rating history from finished rated contests
    const Contest = (await import('../models/Contest.js')).default;
    const finishedContests = await Contest.find({
      status: 'finished',
      isRated: true,
      _ratingsFinalized: true,
      'participants.user': user._id
    }).sort({ endTime: 1 }).select('endTime title participants').lean();

    const contestRatingHistory = [];
    for (const contest of finishedContests) {
      const participant = contest.participants.find(
        p => p.user.toString() === user._id.toString()
      );
      if (participant && participant.newContestRating != null) {
        contestRatingHistory.push({
          date: contest.endTime,
          rating: participant.newContestRating,
          change: participant.ratingChange,
          contestTitle: contest.title,
          rank: participant.rank
        });
      }
    }

    const userData = user.toObject();
    userData.ratingHistory = ratingHistory; // Battle rating history
    userData.contestRatingHistory = contestRatingHistory; // Contest rating history
    userData.hasContestRating = contestRatingHistory.length > 0; // Flag for frontend

    res.json(userData);
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/users/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', protect, async (req, res) => {
  try {
    const { username, email, bio } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if username is already taken by another user
    if (username && username !== user.username) {
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return res.status(400).json({ message: 'Username already taken' });
      }
      user.username = username;
    }

    // Check if email is already taken by another user
    if (email && email !== user.email) {
      const existingEmail = await User.findOne({ email });
      if (existingEmail) {
        return res.status(400).json({ message: 'Email already in use' });
      }
      user.email = email;
    }

    if (bio !== undefined) user.bio = bio;

    await user.save();

    // Invalidate auth cache so subsequent requests see updated profile
    invalidateUserCache(req.user._id.toString());

    res.json({
      _id: user._id,
      username: user.username,
      email: user.email,
      bio: user.bio,
      rating: user.rating,
      contestRating: user.contestRating,
      wins: user.wins,
      losses: user.losses,
      draws: user.draws,
      totalMatches: user.totalMatches
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/users/change-password
// @desc    Change user password
// @access  Private
router.put('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Please provide current and new password' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }

    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);

    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/users/account
// @desc    Delete user account
// @access  Private
router.delete('/account', protect, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ message: 'Please provide your password to confirm deletion' });
    }

    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Incorrect password' });
    }

    // Delete user
    await User.findByIdAndDelete(req.user._id);

    // Remove from auth cache
    invalidateUserCache(req.user._id.toString());

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;

