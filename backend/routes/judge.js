import express from 'express';
import rateLimit from 'express-rate-limit';
import { protect, optionalAuth } from '../middleware/auth.js';
import { executeCode as executeCodeWithJudge0 } from '../utils/codeExecutor.js';
import Problem from '../models/Problem.js';
import Submission from '../models/Submission.js';
import User from '../models/User.js';
import { resolveTestCases } from '../utils/testCaseFetcher.js';
import { syntaxCheckWithDocker } from '../utils/dockerExecutor.js';

const router = express.Router();

// ═══ Rate Limiters ═══
// Strict limiter for unauthenticated public endpoint (prevents DDoS / API quota burn)
const publicRunLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute window
  max: 5,               // 5 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a minute before trying again.' }
});

// Moderate limiter for authenticated code execution (prevents spam-clicking)
const authRunLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute window
  max: 20,              // 20 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many submissions. Please slow down.' }
});

// @route   POST /api/judge/submit
// @desc    Submit code for execution and evaluation
// @access  Public / Optional Auth
router.post('/submit', optionalAuth, authRunLimiter, async (req, res) => {
  try {
    const { problemId, code, language } = req.body;

    // Validate input
    if (!code || !code.trim()) {
      return res.status(400).json({ message: 'Code cannot be empty' });
    }

    // Check for minimum code length (prevent trivial solutions)
    if (code.trim().length < 5) {
      return res.status(400).json({ message: 'Code is too short to be valid' });
    }

    if (!language) {
      return res.status(400).json({ message: 'Language is required' });
    }

    if (!problemId) {
      return res.status(400).json({ message: 'Problem ID is required' });
    }

    // Submission cooldown: reject if user submitted this problem within the last 5 seconds
    if (req.user) {
      const COOLDOWN_MS = 5000;
      const recentSubmission = await Submission.findOne({
        user: req.user._id,
        problem: problemId,
        submittedAt: { $gt: new Date(Date.now() - COOLDOWN_MS) }
      });
      if (recentSubmission) {
        return res.status(429).json({ message: 'Please wait a few seconds before submitting again.' });
      }
    }

    // Get problem with test cases
    const problem = await Problem.findById(problemId);
    if (!problem) {
      return res.status(404).json({ message: 'Problem not found' });
    }

    const problemData = problem.toObject();
    await resolveTestCases(problemData);

    // Execute code with Judge0 API
    const executionResult = await executeCodeWithJudge0(
      code,
      problemData.testCases,
      language,
      problemData.timeLimit / 1000, // Convert ms to seconds
      problemData.metaData
    );

    // Determine final status
    let finalStatus = executionResult.status;
    if (executionResult.testCasesPassed === executionResult.totalTestCases) {
      finalStatus = 'Accepted';
    }

    let submissionId = null;

    // Create submission record only if user is logged in
    if (req.user) {
      const submission = await Submission.create({
        user: req.user._id,
        problem: problemId,
        code,
        language,
        status: finalStatus,
        runtime: executionResult.executionTime,
        memory: executionResult.memoryUsed,
        testCasesPassed: executionResult.testCasesPassed,
        totalTestCases: executionResult.totalTestCases,
        errorMessage: executionResult.errors.join('\n') || ''
      });
      submissionId = submission._id;
    }

    // Update user solved stats on first Accepted — atomic to prevent race conditions
    if (req.user && finalStatus === 'Accepted') {
      try {
        // Build difficulty-specific increment
        const difficultyInc = {};
        if (problem.difficulty === 'Easy') difficultyInc.easySolved = 1;
        else if (problem.difficulty === 'Medium') difficultyInc.mediumSolved = 1;
        else if (problem.difficulty === 'Hard') difficultyInc.hardSolved = 1;

        // Single atomic operation: filter ensures this only fires if problem
        // is NOT already in solvedProblems. Two concurrent requests cannot both
        // match this filter — only the first one through wins.
        await User.updateOne(
          {
            _id: req.user._id,
            'solvedProblems.problem': { $ne: problemId }
          },
          {
            $addToSet: { solvedProblems: { problem: problemId, solvedAt: new Date() } },
            $inc: { totalSolved: 1, ...difficultyInc }
          }
        );
      } catch (statsErr) {
        console.error('Failed to update user solved stats:', statsErr);
      }
    }

    // Calculate percentile for Accepted submissions
    let runtimePercentile = null;
    let memoryPercentile = null;
    if (finalStatus === 'Accepted') {
      try {
        // Use targeted count queries instead of loading all documents into memory.
        // With the compound index on {problem, status}, these are O(log N) lookups.
        const totalAccepted = await Submission.countDocuments({ problem: problemId, status: 'Accepted' });
        if (totalAccepted > 5) {
          const fasterCount = await Submission.countDocuments({
            problem: problemId, status: 'Accepted',
            runtime: { $gt: executionResult.executionTime }
          });
          runtimePercentile = Math.round((fasterCount / totalAccepted) * 100);

          const lessMemCount = await Submission.countDocuments({
            problem: problemId, status: 'Accepted',
            memory: { $gt: executionResult.memoryUsed }
          });
          memoryPercentile = Math.round((lessMemCount / totalAccepted) * 100);
        } else {
          // Dynamic normal distribution simulation for realistic first-user feedback
          const getRealisticRuntimePercentile = (time, lang) => {
            let mean = 80, std = 35;
            if (lang === 'cpp') { mean = 6; std = 3; }
            else if (lang === 'java') { mean = 15; std = 8; }
            else if (lang === 'python') { mean = 45; std = 18; }
            const z = (mean - time) / std;
            const p = 1 / (1 + Math.exp(-0.07056 * Math.pow(z, 3) - 1.5976 * z));
            return Math.min(99, Math.max(7, Math.round(p * 100)));
          };
          const getRealisticMemoryPercentile = (mem, lang) => {
            let mean = 32, std = 8;
            if (lang === 'cpp') { mean = 12; std = 4; }
            else if (lang === 'java') { mean = 45; std = 12; }
            else if (lang === 'python') { mean = 25; std = 6; }
            const z = (mean - mem) / std;
            const p = 1 / (1 + Math.exp(-0.07056 * Math.pow(z, 3) - 1.5976 * z));
            return Math.min(99, Math.max(9, Math.round(p * 100)));
          };
          runtimePercentile = getRealisticRuntimePercentile(executionResult.executionTime, language);
          memoryPercentile = getRealisticMemoryPercentile(executionResult.memoryUsed, language);
        }
      } catch (pErr) { console.error('Percentile calc error:', pErr); }
    }

    // LeetCode-style output filtering: Protect hidden test cases but reveal the first failed one if any
    let filteredOutputs = [];
    const rawOutputs = executionResult.outputs || [];
    const specCases = problemData.testCases || [];

    if (finalStatus === 'Accepted') {
      // Show only public test cases
      filteredOutputs = rawOutputs.filter((_, idx) => !specCases[idx]?.isHidden);
    } else {
      // Find the index of the first failed test case
      const firstFailedIdx = rawOutputs.findIndex(out => !out.passed);

      // Construct outputs list: include all public ones, plus the first failed one (even if it's hidden)
      rawOutputs.forEach((out, idx) => {
        const isHidden = !!specCases[idx]?.isHidden;
        const isFirstFailed = idx === firstFailedIdx;

        if (!isHidden || isFirstFailed) {
          filteredOutputs.push({
            ...out,
            isHidden,
            isFirstFailed
          });
        }
      });
    }

    // Return detailed results
    res.json({
      submissionId: submissionId,
      status: finalStatus,
      testCasesPassed: executionResult.testCasesPassed,
      totalTestCases: executionResult.totalTestCases,
      executionTime: executionResult.executionTime,
      memoryUsed: executionResult.memoryUsed,
      outputs: filteredOutputs,
      errors: executionResult.errors,
      compile_output: executionResult.compile_output,
      runtimePercentile,
      memoryPercentile,
      message: finalStatus === 'Accepted'
        ? 'All test cases passed!'
        : `${executionResult.testCasesPassed}/${executionResult.totalTestCases} test cases passed`
    });

  } catch (error) {
    console.error('Code submission error:', error);
    res.status(500).json({
      message: 'Server error during code execution',
      error: error.message
    });
  }
});

// @route   POST /api/judge/run-public
// @desc    Run code without authentication (for landing page demo)
// @access  Public
router.post('/run-public', publicRunLimiter, async (req, res) => {
  try {
    const { code, language } = req.body;

    // Validate input
    if (!code || !code.trim()) {
      return res.status(400).json({ message: 'Code cannot be empty' });
    }

    if (!language) {
      return res.status(400).json({ message: 'Language is required' });
    }

    // Create a single test case with no input (just run the code)
    const testCases = [{
      input: '',
      expectedOutput: ''
    }];

    // Execute code with a shorter timeout for public runs
    const executionResult = await executeCodeWithJudge0(
      code,
      testCases,
      language,
      3 // 3 second timeout for public demo runs
    );

    // Return results
    res.json({
      output: executionResult.outputs[0]?.actualOutput || '',
      error: executionResult.errors[0] || '',
      executionTime: executionResult.executionTime,
      memoryUsed: executionResult.memoryUsed,
      status: executionResult.status
    });

  } catch (error) {
    console.error('Public code run error:', error);
    res.status(500).json({
      message: 'Server error during code execution',
      error: error.message
    });
  }
});

// @route   POST /api/judge/run
// @desc    Run code with specific test case or custom input
// @access  Public / Optional Auth
router.post('/run', optionalAuth, authRunLimiter, async (req, res) => {
  try {
    const { code, language, input, problemId, testCaseIndex } = req.body;

    // Validate input
    if (!code || !code.trim()) {
      return res.status(400).json({ message: 'Code cannot be empty' });
    }

    // Check for minimum code length (prevent trivial solutions)
    if (code.trim().length < 5) {
      return res.status(400).json({ message: 'Code is too short to be valid' });
    }

    if (!language) {
      return res.status(400).json({ message: 'Language is required' });
    }

    let testCases;
    let metaData = null;

    // If problemId and testCaseIndex provided, use problem's test cases
    if (problemId && testCaseIndex !== undefined) {
      const problem = await Problem.findById(problemId);
      if (!problem) {
        return res.status(404).json({ message: 'Problem not found' });
      }

      const problemData = problem.toObject();
      await resolveTestCases(problemData);
      metaData = problemData.metaData;

      const selectedTestCase = problemData.testCases[testCaseIndex];
      if (!selectedTestCase) {
        return res.status(400).json({ message: 'Invalid test case index' });
      }

      testCases = [selectedTestCase];
    } else {
      // Use custom input
      testCases = [{
        input: input || '',
        expectedOutput: '' // No expected output for custom run
      }];
    }

    // Execute code
    const executionResult = await executeCodeWithJudge0(
      code,
      testCases,
      language,
      5, // 5 second timeout for custom runs
      metaData
    );

    // Enhanced result formatting
    const result = {
      status: executionResult.status === 'Accepted' ? 'Accepted' : 'Wrong Answer',
      output: executionResult.outputs[0]?.actualOutput || '',
      error: executionResult.errors[0] || '',
      executionTime: executionResult.executionTime,
      memoryUsed: executionResult.memoryUsed,
      testCasesPassed: executionResult.testCasesPassed,
      totalTestCases: executionResult.totalTestCases,
      // Add raw stdout/stderr if available for debugging
      stdout: executionResult.outputs[0]?.stdout || '',
      stderr: executionResult.outputs[0]?.stderr || executionResult.errors[0] || '',
      compile_output: executionResult.compile_output || ''
    };

    // If there was a runtime/compilation error, update status
    if (executionResult.status !== 'Accepted') {
      result.status = executionResult.status;
    }

    res.json(result);

  } catch (error) {
    console.error('Code run error:', error);
    res.status(500).json({
      message: 'Server error during code execution',
      error: error.message
    });
  }
});

// @route   GET /api/judge/languages
// @desc    Get supported languages
// @access  Public / Optional Auth
router.get('/languages', optionalAuth, async (req, res) => {
  try {
    const languages = [
      { id: 'javascript', name: 'JavaScript (Node.js)', extension: 'js' },
      { id: 'python', name: 'Python 3', extension: 'py' },
      { id: 'java', name: 'Java', extension: 'java' },
      { id: 'cpp', name: 'C++', extension: 'cpp' },
      { id: 'c', name: 'C', extension: 'c' },
      { id: 'csharp', name: 'C#', extension: 'cs' },
      { id: 'go', name: 'Go', extension: 'go' },
      { id: 'rust', name: 'Rust', extension: 'rs' },
      { id: 'ruby', name: 'Ruby', extension: 'rb' },
      { id: 'php', name: 'PHP', extension: 'php' },
      { id: 'swift', name: 'Swift', extension: 'swift' },
      { id: 'kotlin', name: 'Kotlin', extension: 'kt' }
    ];

    res.json(languages);
  } catch (error) {
    console.error('Get languages error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/judge/hints/:problemId
// @desc    Get hints for a problem
// @access  Public / Optional Auth
router.get('/hints/:problemId', optionalAuth, async (req, res) => {
  try {
    const { problemId } = req.params;

    // Get problem with hints
    const problem = await Problem.findById(problemId);
    if (!problem) {
      return res.status(404).json({ message: 'Problem not found' });
    }

    // Return hints with progressive unlock levels
    const hints = problem.hints || [];

    res.json({
      total: hints.length,
      hints: hints.map((hint, idx) => ({
        id: idx + 1,
        title: hint.title || `Hint ${idx + 1}`,
        content: hint.content || hint,
        unlocked: false, // User can unlock by solving or viewing solution
        unlockedAt: null
      }))
    });
  } catch (error) {
    console.error('Get hints error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/judge/run-batch
// @desc    Run code against visible (public) test cases and custom cases — LeetCode "Run" behavior
// @access  Public / Optional Auth
router.post('/run-batch', optionalAuth, authRunLimiter, async (req, res) => {
  try {
    const { code, language, problemId, customCases } = req.body;
    if (!code || !code.trim() || code.trim().length < 5) return res.status(400).json({ message: 'Code too short' });
    if (!language) return res.status(400).json({ message: 'Language required' });
    if (!problemId) return res.status(400).json({ message: 'Problem ID required' });

    const problem = await Problem.findById(problemId);
    if (!problem) return res.status(404).json({ message: 'Problem not found' });

    const problemData = problem.toObject();
    await resolveTestCases(problemData);

    // "Run" only executes PUBLIC test cases (non-hidden)
    let publicCases = (problemData.testCases || []).filter(tc => !tc.isHidden);

    // If customCases are passed, map and append them
    if (customCases && Array.isArray(customCases) && customCases.length > 0) {
      const parsedCustomCases = customCases.map((tc, idx) => ({
        input: tc.input || '',
        expectedOutput: tc.expectedOutput || '',
        isHidden: false,
        testCaseIndex: publicCases.length + idx
      }));
      publicCases = [...publicCases, ...parsedCustomCases];
    }

    if (publicCases.length === 0) return res.status(400).json({ message: 'No public test cases found' });

    const executionResult = await executeCodeWithJudge0(code, publicCases, language, 5, problemData.metaData, { failFast: false });

    res.json({
      status: executionResult.status,
      testCasesPassed: executionResult.testCasesPassed,
      totalTestCases: executionResult.totalTestCases,
      executionTime: executionResult.executionTime,
      memoryUsed: executionResult.memoryUsed,
      outputs: executionResult.outputs,
      errors: executionResult.errors,
      compile_output: executionResult.compile_output
    });
  } catch (error) {
    console.error('Batch run error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/judge/percentile/:problemId
// @desc    Get runtime/memory distribution for a problem
// @access  Private
router.get('/percentile/:problemId', protect, async (req, res) => {
  try {
    const subs = await Submission.find({ problem: req.params.problemId, status: 'Accepted' }).select('runtime memory language');
    if (subs.length === 0) return res.json({ runtimeDistribution: [], memoryDistribution: [], totalAccepted: 0 });

    const runtimes = subs.map(s => s.runtime || 0).sort((a, b) => a - b);
    const memories = subs.map(s => s.memory || 0).sort((a, b) => a - b);

    // Create buckets for distribution chart
    const createBuckets = (values, bucketCount = 20) => {
      const min = values[0], max = values[values.length - 1];
      const range = max - min || 1;
      const step = range / bucketCount;
      const buckets = [];
      for (let i = 0; i < bucketCount; i++) {
        const lo = min + step * i, hi = min + step * (i + 1);
        buckets.push({ range: [Math.round(lo), Math.round(hi)], count: values.filter(v => v >= lo && v < hi).length });
      }
      return buckets;
    };

    res.json({
      runtimeDistribution: createBuckets(runtimes),
      memoryDistribution: createBuckets(memories),
      totalAccepted: subs.length,
      avgRuntime: Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length),
      avgMemory: Math.round(memories.reduce((a, b) => a + b, 0) / memories.length * 100) / 100
    });
  } catch (error) {
    console.error('Percentile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ═══ Real-Time Syntax Checking (compile-only, no execution) ═══
const syntaxCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many syntax checks. Please slow down.' }
});

// @route   POST /api/judge/syntax-check
// @desc    Check code syntax without execution (compile-only)
// @access  Private
router.post('/syntax-check', protect, syntaxCheckLimiter, async (req, res) => {
  try {
    const { code, language } = req.body;

    if (!code || !language || code.trim().length < 5) {
      return res.json({ valid: true });
    }

    const result = await syntaxCheckWithDocker(code, language);
    res.json(result);
  } catch (error) {
    console.error('Syntax check error:', error);
    res.json({ valid: true }); // Never block user on internal errors
  }
});

export default router;
