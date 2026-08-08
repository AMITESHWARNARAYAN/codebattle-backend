import express from 'express';
import AdminChallenge from '../models/AdminChallenge.js';
import Submission from '../models/Submission.js';
import { protect, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// @route   GET /api/challenges
// @desc    Get all active challenges
// @access  Public / Optional Auth
router.get('/', optionalAuth, async (req, res) => {
  try {
    const now = new Date();
    
    const userId = req.user ? req.user._id : null;
    const filter = {
      status: 'active',
      isVisible: true,
      startDate: { $lte: now },
      endDate: { $gt: now },
    };
    if (userId) {
      filter.$or = [
        { challengeType: 'global' },
        { challengeType: 'targeted', targetUsers: userId }
      ];
    } else {
      filter.challengeType = 'global';
    }

    const challenges = await AdminChallenge.find(filter)
      .populate('problem', 'title difficulty description')
      .populate('createdBy', 'username')
      .sort({ startDate: -1 });

    const challengesWithStatus = challenges.map(challenge => {
      const participant = userId ? challenge.participants.find(
        p => p.user.toString() === userId.toString()
      ) : null;
      
      return {
        ...challenge.toObject(),
        isParticipating: !!participant,
        userStatus: participant ? participant.status : null,
        userScore: participant ? participant.score : 0
      };
    });

    res.json(challengesWithStatus);
  } catch (error) {
    console.error('Get active challenges error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/challenges/upcoming
// @desc    Get upcoming challenges
// @access  Public / Optional Auth
router.get('/upcoming', optionalAuth, async (req, res) => {
  try {
    const now = new Date();
    const userId = req.user ? req.user._id : null;
    
    const filter = {
      status: 'scheduled',
      isVisible: true,
      startDate: { $gt: now }
    };
    if (userId) {
      filter.$or = [
        { challengeType: 'global' },
        { challengeType: 'targeted', targetUsers: userId }
      ];
    } else {
      filter.challengeType = 'global';
    }

    const challenges = await AdminChallenge.find(filter)
      .populate('problem', 'title difficulty')
      .populate('createdBy', 'username')
      .sort({ startDate: 1 })
      .limit(10);

    res.json(challenges);
  } catch (error) {
    console.error('Get upcoming challenges error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/challenges/completed
// @desc    Get user's completed challenges
// @access  Public / Optional Auth
router.get('/completed', optionalAuth, async (req, res) => {
  try {
    if (!req.user) return res.json([]);

    const challenges = await AdminChallenge.find({
      'participants.user': req.user._id,
      'participants.status': 'completed'
    })
      .populate('problem', 'title difficulty')
      .populate('createdBy', 'username')
      .sort({ 'participants.completedAt': -1 });

    const completedChallenges = challenges.map(challenge => {
      const participant = challenge.participants.find(
        p => p.user.toString() === req.user._id.toString() && p.status === 'completed'
      );
      
      return {
        ...challenge.toObject(),
        userScore: participant.score,
        userCompletedAt: participant.completedAt,
        userRuntime: participant.submission?.runtime
      };
    });

    res.json(completedChallenges);
  } catch (error) {
    console.error('Get completed challenges error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/challenges/:id
// @desc    Get single challenge details
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const challenge = await AdminChallenge.findById(req.params.id)
      .populate('problem')
      .populate('createdBy', 'username');

    if (!challenge) {
      return res.status(404).json({ message: 'Challenge not found' });
    }

    // Check if user has access to this challenge
    const hasAccess = challenge.challengeType === 'global' || 
                     challenge.targetUsers.some(userId => userId.toString() === req.user._id.toString());

    if (!hasAccess) {
      return res.status(403).json({ message: 'You do not have access to this challenge' });
    }

    // Get user's participation status
    const participant = challenge.participants.find(
      p => p.user.toString() === req.user._id.toString()
    );

    const challengeData = {
      ...challenge.toObject(),
      userStatus: participant ? participant.status : 'not-started',
      userScore: participant ? participant.score : 0,
      userStartedAt: participant ? participant.startedAt : null,
      userCompletedAt: participant ? participant.completedAt : null
    };

    res.json(challengeData);
  } catch (error) {
    console.error('Get challenge error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/challenges/:id/start
// @desc    Start a challenge
// @access  Private
router.post('/:id/start', protect, async (req, res) => {
  try {
    const challenge = await AdminChallenge.findById(req.params.id);

    if (!challenge) {
      return res.status(404).json({ message: 'Challenge not found' });
    }

    // Check if challenge is active
    if (challenge.status !== 'active') {
      return res.status(400).json({ message: 'Challenge is not active' });
    }

    // Check if user already started
    const existingParticipant = challenge.participants.find(
      p => p.user.toString() === req.user._id.toString()
    );

    if (existingParticipant) {
      return res.status(400).json({ message: 'You have already started this challenge' });
    }

    // Add user as participant
    challenge.participants.push({
      user: req.user._id,
      status: 'in-progress',
      startedAt: new Date()
    });

    challenge.totalParticipants = challenge.participants.length;
    await challenge.save();

    res.json({
      message: 'Challenge started successfully',
      problemId: challenge.problem
    });
  } catch (error) {
    console.error('Start challenge error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/challenges/:id/submit
// @desc    Submit solution for a challenge
// @access  Private
router.post('/:id/submit', protect, async (req, res) => {
  try {
    const { code, language, runtime, memory, testCasesPassed, totalTestCases, status } = req.body;
    
    const challenge = await AdminChallenge.findById(req.params.id);

    if (!challenge) {
      return res.status(404).json({ message: 'Challenge not found' });
    }

    // Find participant
    const participantIndex = challenge.participants.findIndex(
      p => p.user.toString() === req.user._id.toString()
    );

    if (participantIndex === -1) {
      return res.status(400).json({ message: 'You have not started this challenge' });
    }

    // Calculate score (100 points max, based on test cases passed)
    const score = totalTestCases > 0 ? Math.round((testCasesPassed / totalTestCases) * 100) : 0;

    // Update participant
    challenge.participants[participantIndex].submission = {
      code,
      language,
      runtime,
      memory,
      testCasesPassed,
      totalTestCases
    };
    challenge.participants[participantIndex].score = score;

    if (status === 'Accepted') {
      challenge.participants[participantIndex].status = 'completed';
      challenge.participants[participantIndex].completedAt = new Date();
      challenge.completedCount = challenge.participants.filter(p => p.status === 'completed').length;
    } else {
      challenge.participants[participantIndex].status = 'in-progress';
    }

    await challenge.save();

    // Also create a submission record
    await Submission.create({
      user: req.user._id,
      problem: challenge.problem,
      code,
      language,
      status,
      runtime,
      memory,
      testCasesPassed,
      totalTestCases
    });

    res.json({
      message: status === 'Accepted' ? 'Challenge completed!' : 'Submission recorded',
      score,
      status: challenge.participants[participantIndex].status
    });
  } catch (error) {
    console.error('Submit challenge error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/challenges/:id/leaderboard
// @desc    Get challenge leaderboard
// @access  Private
router.get('/:id/leaderboard', protect, async (req, res) => {
  try {
    const challenge = await AdminChallenge.findById(req.params.id)
      .populate('participants.user', 'username rating');

    if (!challenge) {
      return res.status(404).json({ message: 'Challenge not found' });
    }

    const leaderboard = challenge.participants
      .filter(p => p.status === 'completed')
      .sort((a, b) => {
        // Sort by score (descending), then by completion time (ascending)
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return new Date(a.completedAt) - new Date(b.completedAt);
      })
      .map((p, index) => ({
        rank: index + 1,
        username: p.user.username,
        rating: p.user.rating,
        score: p.score,
        completedAt: p.completedAt,
        runtime: p.submission?.runtime
      }));

    res.json(leaderboard);
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;

