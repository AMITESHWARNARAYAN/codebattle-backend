import express from 'express';
import Contest from '../models/Contest.js';
import Problem from '../models/Problem.js';
import User from '../models/User.js';
import { protect, optionalAuth } from '../middleware/auth.js';
import { executeCode as executeCodeWithJudge0 } from '../utils/codeExecutor.js';
import { resolveTestCases } from '../utils/testCaseFetcher.js';
import { getDynamicKFactor } from '../utils/eloRating.js';
import { getIO } from '../utils/socketSingleton.js';


const router = express.Router();

// ──────────────────────────────────────────────────────
// Contest Elo Calculation (Codeforces-inspired)
// Participants are ranked by score/penalty, then each
// player's contestRating changes based on performance
// relative to their expected rank.
// ──────────────────────────────────────────────────────


async function finalizeContestRatings(contest) {
  // Only finalize rated contests that haven't been finalized yet
  if (!contest.isRated) return;
  // Use a flag to prevent double-finalization
  if (contest._ratingsFinalized) return;

  const leaderboard = contest.calculateLeaderboard();
  if (leaderboard.length < 2) return; // Need at least 2 participants

  // Fetch all participant users
  const userIds = leaderboard.map(p => p.user);
  const users = await User.find({ _id: { $in: userIds } });
  const userMap = {};
  users.forEach(u => { userMap[u._id.toString()] = u; });

  const n = leaderboard.length;

  for (let i = 0; i < n; i++) {
    const userId = leaderboard[i].user.toString();
    const user = userMap[userId];
    if (!user) continue;

    const actualRank = i + 1; // 1-indexed rank
    const currentRating = user.contestRating || 0;

    // Calculate expected rank: sum of expected scores against all others
    // Expected score vs opponent = 1 / (1 + 10^((opponentRating - myRating) / 400))
    let expectedRank = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const oppId = leaderboard[j].user.toString();
      const opp = userMap[oppId];
      if (!opp) continue;
      const oppRating = opp.contestRating || 0;
      const expectedScore = 1 / (1 + Math.pow(10, (oppRating - currentRating) / 400));
      // expectedRank += probability of losing to this opponent
      expectedRank += (1 - expectedScore);
    }
    expectedRank += 1; // Convert to 1-indexed rank

    // Rating change = K * (expectedRank - actualRank) / n
    // Positive when you beat expectations, negative when you underperform
    const dynamicK = getDynamicKFactor(currentRating, user.contestsParticipated || 0);
    const ratingDelta = Math.round(dynamicK * (expectedRank - actualRank) / Math.sqrt(n));

    const newRating = Math.max(0, currentRating + ratingDelta); // Floor at 0

    // Store rating change on the participant subdoc
    const participant = contest.participants.find(
      p => (p.user._id || p.user).toString() === userId
    );
    if (participant) {
      participant.ratingChange = ratingDelta;
      participant.oldContestRating = currentRating;
      participant.newContestRating = newRating;
    }

    // Update user's contest rating
    user.updateRating(newRating, 'contest');
    user.contestsParticipated = (user.contestsParticipated || 0) + 1;
    await user.save();
  }

  contest._ratingsFinalized = true;
  await contest.save();
}

// ──────────────────────────────────────────────────────
// Helper: auto-sync contest status based on current time
// This runs on every read so we never return stale status
// ──────────────────────────────────────────────────────
async function syncContestStatus(filter = {}) {
  const now = new Date();

  // 1. Upcoming → Running  (startTime has passed, endTime hasn't)
  await Contest.updateMany(
    { status: 'upcoming', startTime: { $lte: now }, endTime: { $gt: now }, ...filter },
    { $set: { status: 'running' } }
  );

  // 2. Upcoming OR Running → Finished  (endTime has passed)
  // This catches both running contests that ended AND upcoming contests whose end time passed
  // (e.g. 0 registered users, or offline backend when contest was scheduled to run)
  const justFinished = await Contest.find(
    { status: { $in: ['upcoming', 'running'] }, endTime: { $lte: now }, ...filter }
  );

  if (justFinished.length > 0) {
    const finishedIds = justFinished.map(c => c._id);
    await Contest.updateMany(
      { _id: { $in: finishedIds } },
      { $set: { status: 'finished' } }
    );

    // Finalize contest ratings for each newly finished contest
    for (const contest of justFinished) {
      try {
        contest.status = 'finished';
        await finalizeContestRatings(contest);
      } catch (err) {
        console.error(`Failed to finalize ratings for contest ${contest._id}:`, err);
      }
    }
  }
}

// ──────────────────────────────────────────────────────
// GET /  — All contests (with filters)
// ──────────────────────────────────────────────────────
router.get('/', optionalAuth, async (req, res) => {
  try {
    await syncContestStatus();
    const { status, type } = req.query;
    const filter = { isVisible: true };
    if (status) filter.status = status;
    if (type) filter.type = type;

    const contests = await Contest.find(filter)
      .populate('problems.problem', 'title difficulty')
      .populate('createdBy', 'username')
      .sort({ startTime: -1 })
      .lean();

    const userId = req.user ? req.user._id.toString() : null;

    const contestsWithUserData = contests.map(contest => ({
      ...contest,
      isRegistered: userId ? contest.participants.some(
        p => (p.user._id || p.user).toString() === userId
      ) : false,
      userRank: userId ? contest.participants.find(
        p => (p.user._id || p.user).toString() === userId
      )?.rank : null
    }));

    res.json(contestsWithUserData);
  } catch (error) {
    console.error('Get contests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────
// GET /upcoming
// ──────────────────────────────────────────────────────
router.get('/upcoming', optionalAuth, async (req, res) => {
  try {
    await syncContestStatus();
    const contests = await Contest.find({ status: 'upcoming', isVisible: true })
      .populate('problems.problem', 'title difficulty')
      .sort({ startTime: 1 })
      .lean();

    const userId = req.user ? req.user._id.toString() : null;

    const result = contests.map(c => ({
      ...c,
      isRegistered: userId ? c.participants.some(p => (p.user._id || p.user).toString() === userId) : false
    }));

    res.json(result);
  } catch (error) {
    console.error('Get upcoming contests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────
// GET /running
// ──────────────────────────────────────────────────────
router.get('/running', optionalAuth, async (req, res) => {
  try {
    await syncContestStatus();
    const contests = await Contest.find({ status: 'running', isVisible: true })
      .populate('problems.problem', 'title difficulty')
      .sort({ startTime: -1 })
      .lean();

    const userId = req.user ? req.user._id.toString() : null;

    const result = contests.map(c => ({
      ...c,
      isRegistered: userId ? c.participants.some(p => (p.user._id || p.user).toString() === userId) : false
    }));

    res.json(result);
  } catch (error) {
    console.error('Get running contests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────
// GET /past
// ──────────────────────────────────────────────────────
router.get('/past', optionalAuth, async (req, res) => {
  try {
    await syncContestStatus();
    const contests = await Contest.find({ status: 'finished', isVisible: true })
      .populate('problems.problem', 'title difficulty')
      .sort({ startTime: -1 })
      .limit(50)
      .lean();

    const userId = req.user ? req.user._id.toString() : null;

    const result = contests.map(c => ({
      ...c,
      isRegistered: userId ? c.participants.some(p => (p.user._id || p.user).toString() === userId) : false
    }));

    res.json(result);
  } catch (error) {
    console.error('Get past contests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────
// GET /:id  — Single contest details
// ──────────────────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    await syncContestStatus();

    const contest = await Contest.findById(req.params.id)
      .populate('problems.problem')
      .populate('createdBy', 'username')
      .populate('participants.user', 'username email');

    if (!contest) {
      return res.status(404).json({ message: 'Contest not found' });
    }

    const userData = req.user ? contest.getUserData(req.user._id) : null;

    res.json({
      ...contest.toObject(),
      isRegistered: !!userData,
      userData
    });
  } catch (error) {
    console.error('Get contest error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────
// POST /:id/register  — Register for contest
// LeetCode-style: can register before OR during a running contest
// ──────────────────────────────────────────────────────
router.post('/:id/register', protect, async (req, res) => {
  try {
    await syncContestStatus();
    const contest = await Contest.findById(req.params.id);

    if (!contest) {
      return res.status(404).json({ message: 'Contest not found' });
    }

    // Allow registration for upcoming AND running contests
    if (contest.status === 'finished' || contest.status === 'cancelled') {
      return res.status(400).json({ message: 'This contest has already ended' });
    }

    const alreadyRegistered = contest.participants.some(
      p => (p.user._id || p.user).toString() === req.user._id.toString()
    );

    if (alreadyRegistered) {
      return res.status(400).json({ message: 'Already registered' });
    }

    contest.participants.push({
      user: req.user._id,
      username: req.user.username,
      registeredAt: new Date(),
      // If contest is already running, mark start immediately
      startedAt: contest.status === 'running' ? new Date() : undefined
    });

    await contest.save();

    res.json({
      message: 'Successfully registered for contest',
      contest
    });
  } catch (error) {
    console.error('Register contest error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────
// POST /:id/start  — Start personal timer (enter the contest)
// For running contests, this records when user begins solving
// ──────────────────────────────────────────────────────
router.post('/:id/start', protect, async (req, res) => {
  try {
    await syncContestStatus();
    const contest = await Contest.findById(req.params.id);

    if (!contest) {
      return res.status(404).json({ message: 'Contest not found' });
    }

    if (contest.status !== 'running') {
      return res.status(400).json({ message: 'Contest is not running yet' });
    }

    let participant = contest.participants.find(
      p => (p.user._id || p.user).toString() === req.user._id.toString()
    );

    // Auto-register if not registered (LeetCode allows joining mid-contest)
    if (!participant) {
      contest.participants.push({
        user: req.user._id,
        username: req.user.username,
        registeredAt: new Date(),
        startedAt: new Date()
      });
      await contest.save();
      participant = contest.participants[contest.participants.length - 1];
    } else if (!participant.startedAt) {
      participant.startedAt = new Date();
      await contest.save();
    }

    res.json({
      message: 'Contest started',
      startedAt: participant.startedAt,
      endTime: contest.endTime // Global end time — not per-user
    });
  } catch (error) {
    console.error('Start contest error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────
// POST /:id/submit  — Submit solution for a contest problem
// ──────────────────────────────────────────────────────
router.post('/:id/submit', protect, async (req, res) => {
  try {
    await syncContestStatus();
    const { problemId, code, language } = req.body;

    const contest = await Contest.findById(req.params.id);

    if (!contest) {
      return res.status(404).json({ message: 'Contest not found' });
    }

    const participant = contest.participants.find(
      p => (p.user._id || p.user).toString() === req.user._id.toString()
    );

    if (!participant) {
      return res.status(400).json({ message: 'You must register first' });
    }

    const isVirtual = !!participant.isVirtual;

    if (isVirtual) {
      if (participant.endedAt) {
        return res.status(400).json({ message: 'Your virtual contest has ended' });
      }
      const personalEndTime = new Date(new Date(participant.startedAt).getTime() + contest.duration * 60000);
      if (new Date() >= personalEndTime) {
        participant.endedAt = personalEndTime;
        await contest.save();
        return res.status(400).json({ message: 'Your virtual contest time has expired' });
      }
    } else {
      if (contest.status !== 'running') {
        return res.status(400).json({ message: 'Contest is not running. Time is up!' });
      }

      if (new Date() >= contest.endTime) {
        contest.status = 'finished';
        await contest.save();
        return res.status(400).json({ message: 'Contest time has ended' });
      }
    }

    if (!participant.startedAt) {
      participant.startedAt = new Date();
    }

    // Find problem in contest
    const contestProblem = contest.problems.find(
      p => p.problem.toString() === problemId
    );

    if (!contestProblem) {
      return res.status(400).json({ message: 'Problem not in this contest' });
    }

    // Get full problem details with test cases
    const problem = await Problem.findById(problemId);
    if (!problem) {
      return res.status(404).json({ message: 'Problem not found' });
    }

    const problemData = problem.toObject();
    await resolveTestCases(problemData);

    // Execute code
    const executionResult = await executeCodeWithJudge0(
      code,
      problemData.testCases,
      language,
      problemData.timeLimit / 1000
    );

    // Determine status
    let status = executionResult.status;
    if (executionResult.testCasesPassed === executionResult.totalTestCases) {
      status = 'accepted';
    } else {
      status = executionResult.status.toLowerCase();
    }

    // Calculate penalty: time from contest start (or user's virtual start)
    const timeSinceContestStart = isVirtual
      ? (new Date() - new Date(participant.startedAt)) / (1000 * 60)
      : (new Date() - new Date(contest.startTime)) / (1000 * 60);

    // Check if already solved
    const alreadySolved = participant.submissions.some(
      s => s.problem.toString() === problemId && s.status === 'accepted'
    );

    // Count wrong attempts for this problem (for penalty calculation)
    const wrongAttempts = participant.submissions.filter(
      s => s.problem.toString() === problemId && s.status !== 'accepted'
    ).length;

    // First to solve bonus: Check if anyone else has solved this problem
    const isFirstToSolve = status === 'accepted' && !contest.participants.some(
      p => p.submissions.some(s => s.problem.toString() === problemId && s.status === 'accepted')
    );

    // Score: full points for acceptance, plus 10 point bonus if first to solve
    let score = status === 'accepted' ? contestProblem.points : 0;
    if (isFirstToSolve) {
      score += 10;
    }

    // Penalty: time of acceptance + 5 min per wrong attempt (LeetCode-style)
    const penalty = status === 'accepted' ? timeSinceContestStart + (wrongAttempts * 5) : 0;

    // Add submission
    participant.submissions.push({
      problem: problemId,
      submittedAt: new Date(),
      code,
      language,
      status,
      runtime: executionResult.executionTime,
      memory: executionResult.memoryUsed,
      testCasesPassed: executionResult.testCasesPassed,
      totalTestCases: executionResult.totalTestCases,
      score,
      penalty: status === 'accepted' ? timeSinceContestStart : 0
    });

    // Update totals only if first accepted submission for this problem
    if (status === 'accepted' && !alreadySolved) {
      participant.totalScore += score;
      participant.totalPenalty += penalty;
      participant.problemsSolved += 1;
    }



    await contest.save();

    // Recalculate leaderboard
    const leaderboard = contest.calculateLeaderboard();

    res.json({
      message: status === 'accepted' ? 'Accepted!' : 'Wrong Answer',
      status,
      score,
      penalty: penalty.toFixed(0),
      totalScore: participant.totalScore,
      problemsSolved: participant.problemsSolved,
      rank: participant.rank,
      executionResult,
      leaderboard: leaderboard.slice(0, 10),
      isFirstToSolve
    });

    // Broadcast contest update to all clients in the room
    const io = getIO();
    if (io) {
      io.to(`contest-${contest._id}`).emit('contest-update', {
        type: 'submission',
        userId: req.user._id,
        username: req.user.username,
        problemId,
        status,
        score,
        isFirstToSolve
      });
    }
  } catch (error) {
    console.error('Submit contest solution error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────
// GET /:id/leaderboard
// Enhanced: returns per-problem details, pagination, AK count
// ──────────────────────────────────────────────────────
router.get('/:id/leaderboard', optionalAuth, async (req, res) => {
  try {
    await syncContestStatus();
    const contest = await Contest.findById(req.params.id)
      .populate('participants.user', 'username email')
      .populate('problems.problem', 'title difficulty');

    if (!contest) {
      return res.status(404).json({ message: 'Contest not found' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const detailed = req.query.detailed === 'true';

    const leaderboard = contest.calculateLeaderboard();

    const totalProblems = contest.problems.length;
    const akCount = leaderboard.filter(p => p.problemsSolved === totalProblems).length;

    if (!detailed) {
      const paginated = leaderboard.slice((page - 1) * limit, page * limit);
      return res.json(paginated);
    }

    const contestStartTime = new Date(contest.startTime);

    const enriched = leaderboard.map((p, idx) => {
      const rank = idx + 1;

      const problemDetails = contest.problems.map(cp => {
        const problemId = (cp.problem._id || cp.problem).toString();

        const allSubs = (p.submissions || []).filter(
          s => (s.problem?._id || s.problem)?.toString() === problemId
        );

        const accepted = allSubs.find(s => s.status === 'accepted');
        const wrongAttempts = allSubs.filter(s => s.status !== 'accepted').length;

        if (accepted) {
          const subTime = new Date(accepted.submittedAt);
          const participantStart = p.startedAt ? new Date(p.startedAt) : contestStartTime;
          const elapsedMs = subTime - participantStart;
          const elapsedStr = formatElapsed(elapsedMs);

          return {
            status: 'accepted',
            time: elapsedStr,
            elapsedMs,
            language: accepted.language || 'cpp',
            code: accepted.code || '',
            wrongAttempts,
          };
        }

        if (wrongAttempts > 0) {
          return {
            status: 'attempted',
            wrongAttempts,
          };
        }

        return { status: 'unattempted' };
      });

      let finishTimeMs = 0;
      const participantStart = p.startedAt ? new Date(p.startedAt) : contestStartTime;
      let lastAcceptedMs = 0;

      problemDetails.forEach(pd => {
        if (pd.status === 'accepted') {
          if (pd.elapsedMs > lastAcceptedMs) {
            lastAcceptedMs = pd.elapsedMs;
          }
          finishTimeMs += pd.wrongAttempts * 5 * 60 * 1000;
        }
      });
      finishTimeMs += lastAcceptedMs;

      return {
        rank,
        user: p.user,
        username: p.username,
        totalScore: p.totalScore,
        problemsSolved: p.problemsSolved,
        finishTime: formatElapsed(finishTimeMs),
        finishTimeMs,
        problems: problemDetails,
      };
    });

    const paginated = enriched.slice((page - 1) * limit, page * limit);

    res.json({
      rankings: paginated,
      meta: {
        contestTitle: contest.title,
        contestType: contest.type,
        status: contest.status,
        totalParticipants: leaderboard.length,
        akCount,
        totalProblems,
        problems: contest.problems.map(cp => ({
          id: (cp.problem._id || cp.problem).toString(),
          title: cp.problem?.title || 'Problem',
          points: cp.points >= 100 ? Math.round(cp.points / 100) : cp.points,
          difficulty: cp.problem?.difficulty,
        })),
        page,
        limit,
        totalPages: Math.ceil(leaderboard.length / limit),
      }
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

function formatElapsed(ms) {
  if (!ms || ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export default router;
