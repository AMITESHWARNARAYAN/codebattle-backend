import express from 'express';
import DailyChallenge from '../models/DailyChallenge.js';
import Problem from '../models/Problem.js';
import User from '../models/User.js';
import Submission from '../models/Submission.js';
import { protect, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// @route   GET /api/daily-challenge/today
// @desc    Get today's daily challenge
// @access  Public / Optional Auth
router.get('/today', optionalAuth, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let dailyChallenge = await DailyChallenge.findOne({ date: today }).populate('problem');

    // If no challenge exists for today, create one
    if (!dailyChallenge) {
      // Get a random problem that hasn't been used recently
      const recentChallenges = await DailyChallenge.find()
        .sort({ date: -1 })
        .limit(30)
        .select('problem');
      
      const usedProblemIds = recentChallenges.map(c => c.problem);
      
      const randomProblem = await Problem.findOne({
        _id: { $nin: usedProblemIds }
      });

      if (!randomProblem) {
        return res.status(404).json({ message: 'No problems available for daily challenge' });
      }

      dailyChallenge = await DailyChallenge.create({
        date: today,
        problem: randomProblem._id
      });

      dailyChallenge = await DailyChallenge.findById(dailyChallenge._id).populate('problem');
    }

    // Check if user has completed today's challenge
    const userCompleted = req.user ? dailyChallenge.participants.some(
      p => p.user.toString() === req.user._id.toString()
    ) : false;

    // Get user's streak info
    const user = req.user ? await User.findById(req.user._id).select('currentStreak longestStreak lastDailyChallengeDate dailyChallengesCompleted') : null;

    res.json({
      challenge: dailyChallenge,
      userCompleted,
      userStreak: {
        current: user?.currentStreak || 0,
        longest: user?.longestStreak || 0,
        totalCompleted: user?.dailyChallengesCompleted || 0
      }
    });
  } catch (error) {
    console.error('Get daily challenge error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/daily-challenge/complete
// @desc    Mark daily challenge as complete
// @access  Private
router.post('/complete', protect, async (req, res) => {
  try {
    const { submissionId } = req.body;

    // Get the submission
    const submission = await Submission.findById(submissionId);
    if (!submission || submission.status !== 'Accepted') {
      return res.status(400).json({ message: 'Invalid submission' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dailyChallenge = await DailyChallenge.findOne({ date: today });
    if (!dailyChallenge) {
      return res.status(404).json({ message: 'No daily challenge found' });
    }

    // Check if user already completed today's challenge
    const alreadyCompleted = dailyChallenge.participants.some(
      p => p.user.toString() === req.user._id.toString()
    );

    if (alreadyCompleted) {
      return res.status(400).json({ message: 'Already completed today\'s challenge' });
    }

    // Add user to participants
    dailyChallenge.participants.push({
      user: req.user._id,
      completedAt: new Date(),
      runtime: submission.runtime,
      memory: submission.memory
    });
    dailyChallenge.totalParticipants += 1;
    await dailyChallenge.save();

    // Update user streak
    const user = await User.findById(req.user._id);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (!user.lastDailyChallengeDate) {
      // First daily challenge
      user.currentStreak = 1;
      user.longestStreak = 1;
    } else {
      const lastChallengeDate = new Date(user.lastDailyChallengeDate);
      lastChallengeDate.setHours(0, 0, 0, 0);

      if (lastChallengeDate.getTime() === yesterday.getTime()) {
        // Continuing streak
        user.currentStreak += 1;
        if (user.currentStreak > user.longestStreak) {
          user.longestStreak = user.currentStreak;
        }
      } else if (lastChallengeDate.getTime() < yesterday.getTime()) {
        // Streak broken
        user.currentStreak = 1;
      }
      // If same day, don't update streak (already handled by alreadyCompleted check)
    }

    user.lastDailyChallengeDate = today;
    user.dailyChallengesCompleted += 1;
    await user.save();

    res.json({
      message: 'Daily challenge completed!',
      streak: {
        current: user.currentStreak,
        longest: user.longestStreak,
        totalCompleted: user.dailyChallengesCompleted
      }
    });
  } catch (error) {
    console.error('Complete daily challenge error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/daily-challenge/history
// @desc    Get user's daily challenge history
// @access  Private
router.get('/history', protect, async (req, res) => {
  try {
    const { limit = 30 } = req.query;

    const challenges = await DailyChallenge.find({
      'participants.user': req.user._id
    })
      .populate('problem', 'title difficulty')
      .sort({ date: -1 })
      .limit(parseInt(limit));

    const history = challenges.map(challenge => {
      const userParticipation = challenge.participants.find(
        p => p.user.toString() === req.user._id.toString()
      );
      return {
        date: challenge.date,
        problem: challenge.problem,
        completedAt: userParticipation.completedAt,
        runtime: userParticipation.runtime,
        memory: userParticipation.memory
      };
    });

    res.json(history);
  } catch (error) {
    console.error('Get daily challenge history error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/daily-challenge/calendar
// @desc    Get calendar data for daily challenges (last 365 days)
// @access  Private
router.get('/calendar', protect, async (req, res) => {
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);

    const challenges = await DailyChallenge.find({
      date: { $gte: oneYearAgo },
      'participants.user': req.user._id
    }).select('date');

    const calendar = challenges.map(c => ({
      date: c.date,
      completed: true
    }));

    res.json(calendar);
  } catch (error) {
    console.error('Get calendar error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;

