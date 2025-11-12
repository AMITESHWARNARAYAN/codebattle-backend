import express from 'express';
import { protect } from '../middleware/auth.js';
import { executeCodeWithJudge0 } from '../utils/codeExecutor.js';
import Problem from '../models/Problem.js';
import Submission from '../models/Submission.js';

const router = express.Router();

// @route   POST /api/judge/submit
// @desc    Submit code for execution and evaluation
// @access  Private
router.post('/submit', protect, async (req, res) => {
  try {
    const { problemId, code, language } = req.body;

    // Validate input
    if (!code || !code.trim()) {
      return res.status(400).json({ message: 'Code cannot be empty' });
    }

    if (!language) {
      return res.status(400).json({ message: 'Language is required' });
    }

    if (!problemId) {
      return res.status(400).json({ message: 'Problem ID is required' });
    }

    // Get problem with test cases
    const problem = await Problem.findById(problemId);
    if (!problem) {
      return res.status(404).json({ message: 'Problem not found' });
    }

    // Execute code with Judge0 API
    const executionResult = await executeCodeWithJudge0(
      code,
      problem.testCases,
      language,
      problem.timeLimit / 1000 // Convert ms to seconds
    );

    // Determine final status
    let finalStatus = executionResult.status;
    if (executionResult.testCasesPassed === executionResult.totalTestCases) {
      finalStatus = 'Accepted';
    }

    // Create submission record
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

    // Return detailed results
    res.json({
      submissionId: submission._id,
      status: finalStatus,
      testCasesPassed: executionResult.testCasesPassed,
      totalTestCases: executionResult.totalTestCases,
      executionTime: executionResult.executionTime,
      memoryUsed: executionResult.memoryUsed,
      outputs: executionResult.outputs,
      errors: executionResult.errors,
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

// @route   POST /api/judge/run
// @desc    Run code with specific test case or custom input
// @access  Private
router.post('/run', protect, async (req, res) => {
  try {
    const { code, language, input, problemId, testCaseIndex } = req.body;

    // Validate input
    if (!code || !code.trim()) {
      return res.status(400).json({ message: 'Code cannot be empty' });
    }

    if (!language) {
      return res.status(400).json({ message: 'Language is required' });
    }

    let testCases;
    let timeLimit = 5; // Default 5 seconds

    // If problemId and testCaseIndex provided, use specific test case
    if (problemId && typeof testCaseIndex === 'number') {
      const problem = await Problem.findById(problemId);
      if (!problem) {
        return res.status(404).json({ message: 'Problem not found' });
      }

      if (testCaseIndex >= 0 && testCaseIndex < problem.testCases.length) {
        testCases = [problem.testCases[testCaseIndex]];
        timeLimit = problem.timeLimit / 1000; // Convert ms to seconds
      } else {
        return res.status(400).json({ message: 'Invalid test case index' });
      }
    } else {
      // Create a single test case with custom input
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
      timeLimit
    );

    const result = executionResult.outputs[0] || {};

    res.json({
      output: result.actualOutput || '',
      expectedOutput: testCases[0].expectedOutput || '',
      error: executionResult.errors[0] || '',
      executionTime: executionResult.executionTime,
      memoryUsed: executionResult.memoryUsed,
      status: executionResult.status,
      passed: result.passed,
      testCasesPassed: executionResult.testCasesPassed,
      totalTestCases: executionResult.totalTestCases
    });

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
// @access  Private
router.get('/languages', protect, async (req, res) => {
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

export default router;

