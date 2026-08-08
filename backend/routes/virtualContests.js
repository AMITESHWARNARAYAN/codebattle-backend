import express from 'express';
import Contest from '../models/Contest.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

// @route   POST /api/virtual-contests/:id/start
// @desc    Start or replay a virtual contest
// @access  Private
router.post('/:id/start', protect, async (req, res) => {
  try {
    const contest = await Contest.findById(req.params.id);

    if (!contest) {
      return res.status(404).json({ message: 'Contest not found' });
    }

    if (contest.status !== 'finished') {
      return res.status(400).json({ message: 'Only finished contests can be taken virtually' });
    }

    let participant = contest.participants.find(
      p => (p.user._id || p.user).toString() === req.user._id.toString()
    );

    const now = new Date();

    if (participant) {
      // Re-initialize for new virtual attempt
      participant.startedAt = now;
      participant.isVirtual = true;
      participant.endedAt = null;
      participant.submissions = [];
      participant.totalScore = 0;
      participant.totalPenalty = 0;
      participant.problemsSolved = 0;
      participant.rank = undefined;
    } else {
      participant = {
        user: req.user._id,
        username: req.user.username,
        registeredAt: now,
        startedAt: now,
        isVirtual: true,
        endedAt: null,
        submissions: [],
        totalScore: 0,
        totalPenalty: 0,
        problemsSolved: 0
      };
      contest.participants.push(participant);
    }

    await contest.save();

    res.json({
      message: 'Virtual contest started',
      startTime: participant.startedAt,
      duration: contest.duration,
      endTime: new Date(now.getTime() + contest.duration * 60000)
    });
  } catch (error) {
    console.error('Start virtual contest error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/virtual-contests/:id/give-up
// @desc    Give up / abandon virtual contest
// @access  Private
router.post('/:id/give-up', protect, async (req, res) => {
  try {
    const contest = await Contest.findById(req.params.id);
    if (!contest) {
      return res.status(404).json({ message: 'Contest not found' });
    }

    const idx = contest.participants.findIndex(
      p => (p.user._id || p.user).toString() === req.user._id.toString()
    );

    if (idx !== -1 && contest.participants[idx].isVirtual) {
      contest.participants.splice(idx, 1);
      await contest.save();
    }

    res.json({ message: 'Virtual contest abandoned' });
  } catch (error) {
    console.error('Give up virtual contest error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/virtual-contests/:id/stop
// @desc    End virtual contest early
// @access  Private
router.post('/:id/stop', protect, async (req, res) => {
  try {
    const contest = await Contest.findById(req.params.id);
    if (!contest) {
      return res.status(404).json({ message: 'Contest not found' });
    }

    const participant = contest.participants.find(
      p => (p.user._id || p.user).toString() === req.user._id.toString()
    );

    if (participant && participant.isVirtual) {
      participant.endedAt = new Date();
      await contest.save();
    }

    res.json({ message: 'Virtual contest stopped' });
  } catch (error) {
    console.error('Stop virtual contest error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/virtual-contests/:id/status
// @desc    Get virtual contest status for current user
// @access  Private
router.get('/:id/status', protect, async (req, res) => {
  try {
    const contest = await Contest.findById(req.params.id);

    if (!contest) {
      return res.status(404).json({ message: 'Contest not found' });
    }

    const participant = contest.participants.find(
      p => (p.user._id || p.user).toString() === req.user._id.toString()
    );

    if (!participant || !participant.isVirtual) {
      return res.status(404).json({ message: 'Not in a virtual contest' });
    }

    const now = new Date();
    const startTime = new Date(participant.startedAt);
    const endTime = new Date(startTime.getTime() + contest.duration * 60000);
    const isExpired = !!participant.endedAt || now >= endTime;
    const remainingTime = isExpired ? 0 : Math.max(0, endTime - now);

    res.json({
      startedAt: startTime,
      endTime,
      remainingTime,
      isFinished: isExpired
    });
  } catch (error) {
    console.error('Get virtual contest status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
