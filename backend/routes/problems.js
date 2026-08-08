
import express from 'express';
import Problem from '../models/Problem.js';
import Submission from '../models/Submission.js';
import User from '../models/User.js';
import { optionalAuth, protect } from '../middleware/auth.js';
import { resolveTestCases } from '../utils/testCaseFetcher.js';
import { getRandomProblem } from '../utils/randomProblem.js';

const router = express.Router();

// @route   GET /api/problems/:id/next
// @desc    Get the next problem by creation order
// @access  Public / Optional Auth
router.get('/:id/next', optionalAuth, async (req, res) => {
  try {
    const current = await Problem.findById(req.params.id);
    if (!current) return res.status(404).json({ message: 'Problem not found' });
    const next = await Problem.findOne({ createdAt: { $gt: current.createdAt } }).sort({ createdAt: 1 }).populate('category');
    if (!next) return res.status(404).json({ message: 'No next problem' });
    const nextData = next.toObject();
    await resolveTestCases(nextData);
    nextData.testCases = nextData.testCases.filter(tc => !tc.isHidden);
    res.json(nextData);
  } catch (error) {
    console.error('Get next problem error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/problems/:id/previous
// @desc    Get the previous problem by creation order
// @access  Public / Optional Auth
router.get('/:id/previous', optionalAuth, async (req, res) => {
  try {
    const current = await Problem.findById(req.params.id);
    if (!current) return res.status(404).json({ message: 'Problem not found' });
    const prev = await Problem.findOne({ createdAt: { $lt: current.createdAt } }).sort({ createdAt: -1 }).populate('category');
    if (!prev) return res.status(404).json({ message: 'No previous problem' });
    const prevData = prev.toObject();
    await resolveTestCases(prevData);
    prevData.testCases = prevData.testCases.filter(tc => !tc.isHidden);
    res.json(prevData);
  } catch (error) {
    console.error('Get previous problem error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/problems
// @desc    Get all problems with user solved status, filters, pagination
// @access  Public / Optional Auth
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { difficulty, tag, search, company, list, status, sort, page, limit: lim } = req.query;
    
    let query = {};
    if (difficulty) query.difficulty = difficulty;
    if (tag) query.tags = tag;
    if (company) query.companyTags = company;
    if (list) query.lists = list;
    if (search) query.title = { $regex: search, $options: 'i' };

    // Pagination
    const pageNum = parseInt(page) || 1;
    const pageSize = Math.min(parseInt(lim) || 50, 100);
    const skip = (pageNum - 1) * pageSize;

    // Get user's solved problem IDs for status filtering (if logged in)
    const user = req.user ? await User.findById(req.user._id).select('solvedProblems') : null;
    const solvedIds = new Set((user?.solvedProblems || []).map(sp => sp.problem?.toString()));

    // Sorting
    let sortObj = { createdAt: -1 };
    if (sort === 'difficulty') sortObj = { difficulty: 1, createdAt: -1 };
    else if (sort === 'acceptance') sortObj = { acceptanceRate: -1, createdAt: -1 };
    else if (sort === 'frequency') sortObj = { frequency: -1, createdAt: -1 };

    const total = await Problem.countDocuments(query);
    let problems = await Problem.find(query)
      .select('-testCases -functionSignature -hints')
      .sort(sortObj)
      .skip(skip)
      .limit(pageSize)
      .lean();

    // Attach solved status
    problems = problems.map(p => ({
      ...p,
      solved: solvedIds.has(p._id.toString()),
    }));

    // Filter by solved status AFTER fetching (since it's computed)
    if (status === 'solved') problems = problems.filter(p => p.solved);
    else if (status === 'unsolved') problems = problems.filter(p => !p.solved);

    // Get all unique tags across ALL problems (for topic filter sidebar)
    const rawTags = await Problem.distinct('tags');

    // Normalize and deduplicate tags to prevent duplicate topics under any circumstance
    const normalizedTagsSet = new Set();
    const tagMap = {
      'arrays': 'Array',
      'array': 'Array',
      'arrays & hashing': 'Hash Table',
      'strings': 'String',
      'string': 'String',
      'stacks,': 'Stack',
      'stacks': 'Stack',
      'stack': 'Stack',
      'dynamic': 'Dynamic Programming',
      'dynamic programming': 'Dynamic Programming',
      'math & geometry': 'Math',
      'math': 'Math',
      'two pointers': 'Two Pointers',
      'binary search': 'Binary Search',
      'bit manipulation': 'Bit Manipulation'
    };

    rawTags.forEach(t => {
      if (!t) return;
      const lower = t.trim().toLowerCase();
      if (tagMap[lower]) {
        normalizedTagsSet.add(tagMap[lower]);
      } else {
        const words = lower.split(/\s+/);
        const capitalized = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        normalizedTagsSet.add(capitalized);
      }
    });

    const allTags = Array.from(normalizedTagsSet).sort();

    res.json({
      problems,
      pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.ceil(total / pageSize) },
      allTags,
    });
  } catch (error) {
    console.error('Get problems error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// @route   GET /api/problems/random
// @desc    Get a random problem for match
// @access  Public / Optional Auth
router.get('/random', optionalAuth, async (req, res) => {
  try {
    const { difficulty } = req.query;
    
    let query = {};
    if (difficulty) {
      query.difficulty = difficulty;
    }

    const problem = await getRandomProblem(query);

    if (!problem) {
      return res.status(404).json({ message: 'No problems found' });
    }

    // Return problem without hidden test cases
    const problemData = problem.toObject();
    await resolveTestCases(problemData);
    problemData.testCases = problemData.testCases.filter(tc => !tc.isHidden);

    res.json(problemData);
  } catch (error) {
    console.error('Get random problem error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/problems/:id
// @desc    Get problem by ID
// @access  Public / Optional Auth
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const problem = await Problem.findById(req.params.id).populate('category');

    if (!problem) {
      return res.status(404).json({ message: 'Problem not found' });
    }

    // Return problem with only visible (non-hidden) test cases
    const problemData = problem.toObject();
    await resolveTestCases(problemData);
    problemData.testCases = problemData.testCases.filter(tc => !tc.isHidden);

    // Check if user has solved this problem (if logged in)
    const acceptedSubmission = req.user ? await Submission.findOne({
      userId: req.user._id,
      problemId: req.params.id,
      status: 'Accepted'
    }) : null;

    problemData.solved = !!acceptedSubmission;

    // Get real statistics
    const totalSubmissions = await Submission.countDocuments({
      problemId: req.params.id
    });

    const totalSolved = await Submission.countDocuments({
      problemId: req.params.id,
      status: 'Accepted'
    });

    problemData.totalSubmissions = totalSubmissions;
    problemData.totalSolved = totalSolved;

    res.json(problemData);
  } catch (error) {
    console.error('Get problem error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/problems
// @desc    Create a new problem (admin only - simplified for now)
// @access  Private
router.post('/', protect, async (req, res) => {
  try {
    const problem = await Problem.create(req.body);
    res.status(201).json(problem);
  } catch (error) {
    console.error('Create problem error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/problems/online-users/:problemId
// @desc    Get number of online users viewing a problem
// @access  Public
router.get('/online-users/:problemId', async (req, res) => {
  try {
    // In production, track socket.io connections
    // For now, return number of users currently viewing this problem from session/socket data
    // Default to 1 (the current user)
    const onlineCount = 1;
    
    res.json({ 
      onlineUsers: onlineCount,
      problemId: req.params.problemId
    });
  } catch (error) {
    console.error('Get online users error:', error);
    res.status(500).json({ 
      message: 'Server error',
      onlineUsers: 1
    });
  }
});

export default router;

