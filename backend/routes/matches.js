import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import Match from '../models/Match.js';
import Problem from '../models/Problem.js';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';
import { executeCode as executeCodeWithJudge0, analyzeComplexity } from '../utils/codeExecutor.js';
import { calculateMatchRatings, determineWinner, getBestSubmission } from '../utils/eloRating.js';

import { createNotification } from './notifications.js';
import { getOnlineUsers } from '../socket/matchmaking.js';
import { resolveTestCases } from '../utils/testCaseFetcher.js';
import { getRandomProblem } from '../utils/randomProblem.js';
import { getIO } from '../utils/socketSingleton.js';
import { scheduleMatchTimeout, cancelMatchTimeout } from '../utils/matchTimeout.js';

const router = express.Router();

// @route   POST /api/matches/solo
// @desc    Start a solo match
// @access  Private
router.post('/solo', protect, async (req, res) => {
  try {
    let problem;
    const { problemId } = req.body;

    if (problemId) {
      // Use specific problem if provided
      problem = await Problem.findById(problemId);
      if (!problem) {
        return res.status(404).json({ message: 'Problem not found' });
      }
    } else {
      // Get random problem (O(1) via $sample aggregation)
      problem = await getRandomProblem();
      if (!problem) {
        return res.status(404).json({ message: 'No problems available' });
      }
    }

    // Create solo match
    const match = await Match.create({
      matchType: 'solo',
      problem: problem._id,
      players: [req.user._id],
      status: 'in-progress',
      startTime: new Date()
    });

    await match.populate('problem');

    // Return problem without all test cases
    const matchData = match.toObject();
    await resolveTestCases(matchData.problem);
    matchData.problem.visibleTestCases = matchData.problem.testCases.filter(tc => !tc.isHidden);
    delete matchData.problem.testCases;

    res.json(matchData);
  } catch (error) {
    console.error('Solo match error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/matches/friend/create
// @desc    Create a friend challenge
// @access  Private
router.post('/friend/create', protect, async (req, res) => {
  try {
    // Get a random problem (O(1) via $sample aggregation)
    const problem = await getRandomProblem();

    if (!problem) {
      return res.status(404).json({ message: 'No problems available' });
    }

    // Generate unique invite code
    const inviteCode = uuidv4();

    // Create friend match
    const match = await Match.create({
      matchType: 'friend',
      problem: problem._id,
      players: [req.user._id],
      status: 'waiting',
      inviteCode: inviteCode
    });

    await match.populate('problem players');

    res.json({
      matchId: match._id,
      inviteCode: inviteCode,
      inviteLink: `${process.env.FRONTEND_URL}/match/join/${inviteCode}`,
      creator: req.user.username
    });
  } catch (error) {
    console.error('Create friend match error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/matches/friend/challenge-by-email
// @desc    Send a friend challenge via email
// @access  Private
router.post('/friend/challenge-by-email', protect, async (req, res) => {
  try {
    const { friendEmail } = req.body;

    if (!friendEmail) {
      return res.status(400).json({ message: 'Friend email is required' });
    }

    // Check if friend exists
    const friend = await User.findOne({ email: friendEmail });
    if (!friend) {
      return res.status(404).json({ message: 'Friend not found' });
    }

    // Check if challenging yourself
    if (friend._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot challenge yourself' });
    }

    // Get a random problem (O(1) via $sample aggregation)
    const problem = await getRandomProblem();

    if (!problem) {
      return res.status(404).json({ message: 'No problems available' });
    }

    // Create friend match with email challenge
    const match = await Match.create({
      matchType: 'friend',
      problem: problem._id,
      players: [req.user._id],
      status: 'waiting',
      challengerEmail: req.user.email,
      challengedEmail: friendEmail,
      challengeStatus: 'pending'
    });

    await match.populate('problem');

    // Create persistent notification for the challenged user
    await createNotification(
      friend._id,
      'challenge_received',
      'New Friend Challenge!',
      `${req.user.username} challenged you to a DSA battle!`,
      null, // We don't link directly since we use the socket/toast or we can just send matchId in data
      { matchId: match._id.toString(), challenger: req.user.username }
    );

    res.json({
      matchId: match._id,
      message: `Challenge sent to ${friendEmail}`,
      challenger: req.user.username,
      challengedUser: friend.username,
      isOnline: friend.isOnline
    });
  } catch (error) {
    console.error('Challenge by email error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/matches/friend/pending-challenges
// @desc    Get pending challenges for current user
// @access  Private
router.get('/friend/pending-challenges', protect, async (req, res) => {
  try {
    const challenges = await Match.find({
      challengedEmail: req.user.email,
      challengeStatus: 'pending',
      status: 'waiting'
    })
      .populate('problem')
      .sort({ createdAt: -1 });

    res.json(challenges);
  } catch (error) {
    console.error('Get pending challenges error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/matches/friend/accept-challenge/:matchId
// @desc    Accept a friend challenge
// @access  Private
router.post('/friend/accept-challenge/:matchId', protect, async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId).populate('problem');

    if (!match) {
      return res.status(404).json({ message: 'Challenge not found' });
    }

    // Verify user is the challenged player
    if (match.challengedEmail !== req.user.email) {
      return res.status(403).json({ message: 'This challenge is not for you' });
    }

    // Check if already accepted
    if (match.status !== 'waiting') {
      return res.status(400).json({ message: 'Challenge already accepted or expired' });
    }

    // Add player and start match
    match.players.push(req.user._id);
    match.status = 'in-progress';
    match.challengeStatus = 'accepted';
    match.startTime = new Date();
    await match.save();

    // Schedule 30-minute timeout for auto-resolution
    scheduleMatchTimeout(match._id);

    await match.populate('players');

    // Create persistent notification for the challenger
    const challenger = await User.findOne({ email: match.challengerEmail });
    if (challenger) {
      await createNotification(
        challenger._id,
        'challenge_accepted',
        'Challenge Accepted!',
        `${req.user.username} accepted your challenge. Get ready!`,
        `/match/${match._id.toString()}`,
        { matchId: match._id.toString(), challengedUser: req.user.username }
      );
    }

    // Emit socket event to notify the challenger that challenge was accepted
    const io = getIO();
    if (io && match.challengerEmail) {
      const onlineUsers = getOnlineUsers();
      
      // Find challenger's socket
      let challengerSocket = null;
      for (const [userId, userInfo] of onlineUsers.entries()) {
        if (userInfo.email === match.challengerEmail) {
          challengerSocket = userInfo.socketId;
          break;
        }
      }

      if (challengerSocket) {
        io.to(challengerSocket).emit('challenge-accepted', {
          matchId: match._id.toString(),
          message: 'Your challenge was accepted!',
          timestamp: Date.now()
        });
        console.log(`Notified challenger ${match.challengerEmail} that challenge was accepted`);
      } else {
        console.log(`Challenger ${match.challengerEmail} is not currently online`);
      }
    }

    // Return match data without all test cases
    const matchData = match.toObject();

    if (!matchData.problem) {
      return res.status(500).json({ message: 'Problem data is corrupted' });
    }

    await resolveTestCases(matchData.problem);
    matchData.problem.visibleTestCases = matchData.problem.testCases.filter(tc => !tc.isHidden);
    delete matchData.problem.testCases;

    res.json(matchData);
  } catch (error) {
    console.error('Accept challenge error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/matches/friend/reject-challenge/:matchId
// @desc    Reject a friend challenge
// @access  Private
router.post('/friend/reject-challenge/:matchId', protect, async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId);

    if (!match) {
      return res.status(404).json({ message: 'Challenge not found' });
    }

    // Verify user is the challenged player
    if (match.challengedEmail !== req.user.email) {
      return res.status(403).json({ message: 'This challenge is not for you' });
    }

    // Update challenge status
    match.challengeStatus = 'rejected';
    match.status = 'cancelled';
    await match.save();

    // Create persistent notification for the challenger
    const challenger = await User.findOne({ email: match.challengerEmail });
    if (challenger) {
      await createNotification(
        challenger._id,
        'challenge_rejected',
        'Challenge Declined',
        `${req.user.username} declined your challenge.`,
        null,
        { matchId: match._id.toString(), challengedUser: req.user.username }
      );
    }

    // Emit socket event to notify the challenger that challenge was rejected
    const io = getIO();
    if (io && match.challengerEmail) {
      const onlineUsers = getOnlineUsers();
      
      // Find challenger's socket
      let challengerSocket = null;
      for (const [userId, userInfo] of onlineUsers.entries()) {
        if (userInfo.email === match.challengerEmail) {
          challengerSocket = userInfo.socketId;
          break;
        }
      }

      if (challengerSocket) {
        io.to(challengerSocket).emit('challenge-rejected', {
          matchId: match._id.toString(),
          message: 'Your challenge was rejected',
          timestamp: Date.now()
        });
        console.log(`Notified challenger ${match.challengerEmail} that challenge was rejected`);
      }
    }

    res.json({ message: 'Challenge rejected' });
  } catch (error) {
    console.error('Reject challenge error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/matches/friend/join/:inviteCode
// @desc    Join a friend challenge
// @access  Private
router.post('/friend/join/:inviteCode', protect, async (req, res) => {
  try {
    const match = await Match.findOne({ 
      inviteCode: req.params.inviteCode,
      status: 'waiting'
    }).populate('problem players');

    if (!match) {
      return res.status(404).json({ message: 'Invalid or expired invite code' });
    }

    // Check if user is already in match
    if (match.players.some(p => p._id.toString() === req.user._id.toString())) {
      return res.status(400).json({ message: 'You are already in this match' });
    }

    // Add player and start match
    match.players.push(req.user._id);
    match.status = 'in-progress';
    match.startTime = new Date();
    await match.save();

    // Schedule 30-minute timeout for auto-resolution
    scheduleMatchTimeout(match._id);

    await match.populate('players');

    // Return match data without all test cases
    const matchData = match.toObject();

    if (!matchData.problem) {
      return res.status(500).json({ message: 'Problem data is corrupted' });
    }

    await resolveTestCases(matchData.problem);
    matchData.problem.visibleTestCases = matchData.problem.testCases.filter(tc => !tc.isHidden);
    delete matchData.problem.testCases;

    res.json(matchData);
  } catch (error) {
    console.error('Join friend match error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/matches/:matchId/submit
// @desc    Submit code for a match
// @access  Private
router.post('/:matchId/submit', protect, async (req, res) => {
  try {
    const { code, language } = req.body;

    // Validate code submission
    if (!code || !code.trim()) {
      return res.status(400).json({ message: 'Code cannot be empty' });
    }

    if (!language) {
      return res.status(400).json({ message: 'Language is required' });
    }

    const match = await Match.findById(req.params.matchId).populate('problem');

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    if (!match.problem) {
      return res.status(500).json({ message: 'Problem data is corrupted' });
    }

    // Check if user is in this match
    if (!match.players.some(p => p.toString() === req.user._id.toString())) {
      return res.status(403).json({ message: 'You are not in this match' });
    }

    const problemData = match.problem.toObject();
    await resolveTestCases(problemData);

    // Execute code with all test cases (including hidden ones)
    const executionResult = await executeCodeWithJudge0(
      code,
      problemData.testCases,
      language,
      problemData.timeLimit / 1000 // Convert ms to seconds
    );
    
    // Analyze complexity
    const complexity = analyzeComplexity(code);

    // Create submission
    const submission = {
      userId: req.user._id,
      code,
      language,
      submittedAt: new Date(),
      executionTime: executionResult.executionTime,
      memoryUsed: executionResult.memoryUsed,
      testCasesPassed: executionResult.testCasesPassed,
      totalTestCases: executionResult.totalTestCases,
      status: executionResult.status,
      timeComplexity: complexity.timeComplexity,
      spaceComplexity: complexity.spaceComplexity
    };

    if (match.matchType === 'solo') {
      // Solo match ends immediately
      match.submissions.push(submission);
      match.status = 'completed';
      match.endTime = new Date();
      match.duration = Math.floor((match.endTime - match.startTime) / 1000);
      
      // Update user stats for solo (no rating change)
      const user = await User.findById(req.user._id);
      user.totalMatches++;
      if (executionResult.status === 'Accepted') {
        user.wins++;
      }
      await user.save();
      await match.save();
    } else if (match.matchType === 'friend' || match.matchType === 'matchmaking') {
      
      // Save the submission atomically using findOneAndUpdate to avoid race conditions.
      const updateDoc = { $push: { submissions: submission } };

      const updatedMatch = await Match.findOneAndUpdate(
        { _id: req.params.matchId, status: 'in-progress' },
        updateDoc,
        { new: true }
      );

      if (!updatedMatch) {
        // If match is already completed or not in progress, fetch the final state and return it
        const finalMatch = await Match.findById(req.params.matchId).populate('players winner');
        return res.json({
          submission: submission,
          executionResult: executionResult,
          match: finalMatch
        });
      }

      // Check if both players have submitted
      const uniqueSubmitters = new Set(updatedMatch.submissions.map(s => s.userId.toString()));
      
      if (uniqueSubmitters.size === updatedMatch.players.length) {
        // Try to atomically acquire a lock by transitioning status to 'completed'
        const lockedMatch = await Match.findOneAndUpdate(
          { _id: req.params.matchId, status: 'in-progress' },
          { $set: { status: 'completed', endTime: new Date() } },
          { new: true }
        );

        if (lockedMatch) {
          // Cancel the scheduled timeout since match resolved normally
          cancelMatchTimeout(lockedMatch._id);

          // Both submitted and we won the atomic state transition lock - determine winner
          lockedMatch.duration = Math.floor((lockedMatch.endTime - lockedMatch.startTime) / 1000);

          // Get BEST submission from each player (not last)
          const player1Id = lockedMatch.players[0].toString();
          const player2Id = lockedMatch.players[1].toString();
          
          const player1Submission = getBestSubmission(lockedMatch.submissions, player1Id);
          const player2Submission = getBestSubmission(lockedMatch.submissions, player2Id);

          // Determine winner using real-world submission speed as primary tiebreaker
          const result = determineWinner(
            player1Submission,
            player2Submission,
            lockedMatch.startTime,
            lockedMatch.submissions
          );

          // Get players
          const player1 = await User.findById(player1Id);
          const player2 = await User.findById(player2Id);

          // Calculate rating changes with dynamic K-factors
          const ratingChanges = calculateMatchRatings(
            player1.rating, player1.totalMatches,
            player2.rating, player2.totalMatches,
            result
          );

          // Update ratings and stats
          player1.updateRating(ratingChanges.player1.newRating);
          player1.totalMatches++;
          player2.updateRating(ratingChanges.player2.newRating);
          player2.totalMatches++;

          if (result === 'player1') {
            lockedMatch.winner = player1Id;
            player1.wins++;
            player2.losses++;
          } else if (result === 'player2') {
            lockedMatch.winner = player2Id;
            player2.wins++;
            player1.losses++;
          } else {
            player1.draws++;
            player2.draws++;
          }

          await player1.save();
          await player2.save();

          // Store rating changes in match
          lockedMatch.ratingChanges = [
            {
              userId: player1Id,
              oldRating: ratingChanges.player1.oldRating,
              newRating: ratingChanges.player1.newRating,
              change: ratingChanges.player1.change
            },
            {
              userId: player2Id,
              oldRating: ratingChanges.player2.oldRating,
              newRating: ratingChanges.player2.newRating,
              change: ratingChanges.player2.change
            }
          ];

          await lockedMatch.save();

          // Send notifications to both players
          await createNotification(
            player1Id,
            'match_result',
            'Match Completed',
            result === 'player1' ? `🎉 You won! Rating: ${ratingChanges.player1.change >= 0 ? '+' : ''}${ratingChanges.player1.change}` :
            result === 'draw' ? `Match ended in a draw. Rating: ${ratingChanges.player1.change >= 0 ? '+' : ''}${ratingChanges.player1.change}` :
            `You lost to ${player2.username}. Rating: ${ratingChanges.player1.change >= 0 ? '+' : ''}${ratingChanges.player1.change}`,
            `/results/${lockedMatch._id}`
          );

          await createNotification(
            player2Id,
            'match_result',
            'Match Completed',
            result === 'player2' ? `🎉 You won! Rating: ${ratingChanges.player2.change >= 0 ? '+' : ''}${ratingChanges.player2.change}` :
            result === 'draw' ? `Match ended in a draw. Rating: ${ratingChanges.player2.change >= 0 ? '+' : ''}${ratingChanges.player2.change}` :
            `You lost to ${player1.username}. Rating: ${ratingChanges.player2.change >= 0 ? '+' : ''}${ratingChanges.player2.change}`,
            `/results/${lockedMatch._id}`
          );

          // Emit match-completed to match room
          const io = getIO();
          if (io) {
            io.to(`match-${lockedMatch._id.toString()}`).emit('match-completed', {
              matchId: lockedMatch._id.toString(),
              winnerId: lockedMatch.winner ? lockedMatch.winner.toString() : null,
              match: lockedMatch
            });
          }
        }
      }
    }

    const finalMatch = await Match.findById(req.params.matchId).populate('players winner');

    res.json({
      submission: submission,
      executionResult: executionResult,
      match: finalMatch
    });
  } catch (error) {
    console.error('Submit code error:', error);
    res.status(500).json({ message: 'Server error during code execution' });
  }
});

// @route   GET /api/matches/:matchId
// @desc    Get match details
// @access  Private
router.get('/:matchId', protect, async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId)
      .populate('problem players winner');

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const matchData = match.toObject();
    if (matchData.problem) {
      await resolveTestCases(matchData.problem);
      matchData.problem.visibleTestCases = (matchData.problem.testCases || []).filter(tc => !tc.isHidden);
      delete matchData.problem.testCases;
    }

    res.json(matchData);
  } catch (error) {
    console.error('Get match error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/matches/:matchId/giveup
// @desc    Give up in a match (declare opponent as winner)
// @access  Private
router.post('/:matchId/giveup', protect, async (req, res) => {
  try {
    // Atomically grab the match if it's still in-progress (prevents double-resolution race)
    const match = await Match.findOneAndUpdate(
      {
        _id: req.params.matchId,
        status: 'in-progress',
        players: req.user._id,
        matchType: { $ne: 'solo' }
      },
      { $set: { status: 'completed', endTime: new Date() } },
      { new: true }
    ).populate('players');

    if (!match) {
      // Either not found, already resolved, user not in match, or solo
      const existing = await Match.findById(req.params.matchId);
      if (!existing) return res.status(404).json({ message: 'Match not found' });
      if (existing.matchType === 'solo') return res.status(400).json({ message: 'Cannot give up in solo practice' });
      if (existing.status !== 'in-progress') return res.status(400).json({ message: 'Match is already resolved' });
      return res.status(403).json({ message: 'You are not in this match' });
    }

    match.duration = Math.floor((match.endTime - match.startTime) / 1000);

    // Cancel the scheduled timeout since match resolved via give-up
    cancelMatchTimeout(match._id);

    // Determine winner (the other player)
    const givingUpPlayerId = req.user._id.toString();
    const winnerId = match.players.find(p => p._id.toString() !== givingUpPlayerId)._id;
    const loserId = req.user._id;

    match.winner = winnerId;

    // Get both players
    const winner = await User.findById(winnerId);
    const loser = await User.findById(loserId);

    // Calculate rating changes with dynamic K-factors
    const ratingChanges = calculateMatchRatings(
      winner.rating, winner.totalMatches,
      loser.rating, loser.totalMatches,
      'player1'
    );

    // Update ratings and stats
    winner.updateRating(ratingChanges.player1.newRating);
    winner.totalMatches++;
    winner.wins++;

    loser.updateRating(ratingChanges.player2.newRating);
    loser.totalMatches++;
    loser.losses++;

    await winner.save();
    await loser.save();

    // Store rating changes in match
    match.ratingChanges = [
      {
        userId: winnerId,
        oldRating: ratingChanges.player1.oldRating,
        newRating: ratingChanges.player1.newRating,
        change: ratingChanges.player1.change
      },
      {
        userId: loserId,
        oldRating: ratingChanges.player2.oldRating,
        newRating: ratingChanges.player2.newRating,
        change: ratingChanges.player2.change
      }
    ];

    await match.save();
    await match.populate('players winner');

    // Notify the other player via socket
    const io = getIO();
    if (io) {
      io.to(`match-${match._id.toString()}`).emit('opponent-gave-up', {
        matchId: match._id.toString(),
        userId: req.user._id.toString(),
        username: req.user.username,
        winnerId: winnerId.toString(),
        match: match
      });
      io.to(`match-${match._id.toString()}`).emit('match-completed', {
        matchId: match._id.toString(),
        winnerId: winnerId.toString(),
        reason: 'opponent-gave-up',
        match: match
      });
    }

    res.json({
      message: 'You gave up. Opponent wins!',
      match: match
    });
  } catch (error) {
    console.error('Give up error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/matches/user/history
// @desc    Get user's match history
// @access  Private
router.get('/user/history', protect, async (req, res) => {
  try {
    const matches = await Match.find({
      players: req.user._id,
      status: 'completed'
    })
      .populate('problem players winner')
      .sort({ createdAt: -1 })
      .limit(20);

    res.json(matches);
  } catch (error) {
    console.error('Get match history error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;

