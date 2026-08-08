import express from 'express';
import Discussion from '../models/Discussion.js';
import { protect, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

// Get all discussions for a problem
router.get('/problem/:problemId', optionalAuth, async (req, res) => {
  try {
    const { problemId } = req.params;
    const { sortBy = 'recent', tag, search } = req.query;

    let query = { problem: problemId };
    if (tag) {
      query.tags = tag;
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { content: { $regex: search, $options: 'i' } }
      ];
    }

    let sortOptions = {};
    switch (sortBy) {
      case 'popular':
        sortOptions = { isPinned: -1, upvotes: -1, createdAt: -1 };
        break;
      case 'mostVoted':
        sortOptions = { isPinned: -1, upvotes: -1 };
        break;
      case 'recent':
      default:
        sortOptions = { isPinned: -1, createdAt: -1 };
    }

    const discussions = await Discussion.find(query)
      .populate('user', 'username email')
      .populate('comments.user', 'username email')
      .sort(sortOptions)
      .lean();

    const userIdStr = req.user ? req.user._id.toString() : null;

    // Calculate vote counts
    const discussionsWithVotes = discussions.map(d => ({
      ...d,
      voteCount: d.upvotes.length - d.downvotes.length,
      commentCount: d.comments.length,
      userVote: userIdStr ? (d.upvotes.some(u => u.toString() === userIdStr) ? 'up' : d.downvotes.some(u => u.toString() === userIdStr) ? 'down' : null) : null
    }));

    res.json(discussionsWithVotes);
  } catch (error) {
    console.error('Error fetching discussions:', error);
    res.status(500).json({ message: 'Failed to fetch discussions' });
  }
});

// @route   PUT /api/discussions/:id/pin
// @desc    Pin/unpin a discussion (Admin only)
// @access  Private (Admin)
router.put('/:id/pin', protect, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const discussion = await Discussion.findById(req.params.id);
    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    discussion.isPinned = !discussion.isPinned;
    await discussion.save();

    res.json({
      message: discussion.isPinned ? 'Discussion pinned' : 'Discussion unpinned',
      isPinned: discussion.isPinned
    });
  } catch (error) {
    console.error('Error pinning discussion:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single discussion
router.get('/:id', protect, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.id)
      .populate('user', 'username email')
      .populate('comments.user', 'username email')
      .populate('comments.replies.user', 'username email');

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    // Increment view count
    discussion.views += 1;
    await discussion.save();

    const discussionObj = discussion.toObject();
    discussionObj.voteCount = discussion.upvotes.length - discussion.downvotes.length;
    discussionObj.commentCount = discussion.comments.length;
    discussionObj.userVote = req.user ? (discussion.upvotes.some(u => u.toString() === req.user._id.toString()) ? 'up' : discussion.downvotes.some(u => u.toString() === req.user._id.toString()) ? 'down' : null) : null;

    res.json(discussionObj);
  } catch (error) {
    console.error('Error fetching discussion:', error);
    res.status(500).json({ message: 'Failed to fetch discussion' });
  }
});

// Create new discussion
router.post('/', protect, async (req, res) => {
  try {
    const { problem, title, content, code, language, tags, isSolution } = req.body;

    if (!problem || !title || !content) {
      return res.status(400).json({ message: 'Problem, title, and content are required' });
    }

    const discussion = new Discussion({
      problem,
      user: req.user._id,
      title,
      content,
      code,
      language,
      tags: tags || [],
      isSolution: isSolution || false
    });

    await discussion.save();
    await discussion.populate('user', 'username email');

    res.status(201).json(discussion);
  } catch (error) {
    console.error('Error creating discussion:', error);
    res.status(500).json({ message: 'Failed to create discussion' });
  }
});

// Update discussion
router.put('/:id', protect, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.id);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    if (discussion.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this discussion' });
    }

    const { title, content, code, language, tags } = req.body;

    if (title) discussion.title = title;
    if (content) discussion.content = content;
    if (code !== undefined) discussion.code = code;
    if (language) discussion.language = language;
    if (tags) discussion.tags = tags;

    await discussion.save();
    await discussion.populate('user', 'username email');

    res.json(discussion);
  } catch (error) {
    console.error('Error updating discussion:', error);
    res.status(500).json({ message: 'Failed to update discussion' });
  }
});

// Delete discussion
router.delete('/:id', protect, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.id);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    if (discussion.user.toString() !== req.user._id.toString() && !req.user.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this discussion' });
    }

    await discussion.deleteOne();
    res.json({ message: 'Discussion deleted successfully' });
  } catch (error) {
    console.error('Error deleting discussion:', error);
    res.status(500).json({ message: 'Failed to delete discussion' });
  }
});

// Upvote discussion
router.post('/:id/upvote', protect, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.id);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    const userId = req.user._id;
    const upvoteIndex = discussion.upvotes.indexOf(userId);
    const downvoteIndex = discussion.downvotes.indexOf(userId);

    // Remove from downvotes if exists
    if (downvoteIndex > -1) {
      discussion.downvotes.splice(downvoteIndex, 1);
    }

    // Toggle upvote
    if (upvoteIndex > -1) {
      discussion.upvotes.splice(upvoteIndex, 1);
    } else {
      discussion.upvotes.push(userId);
    }

    await discussion.save();

    res.json({
      voteCount: discussion.upvotes.length - discussion.downvotes.length,
      userVote: upvoteIndex > -1 ? null : 'up'
    });
  } catch (error) {
    console.error('Error upvoting discussion:', error);
    res.status(500).json({ message: 'Failed to upvote discussion' });
  }
});

// Downvote discussion
router.post('/:id/downvote', protect, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.id);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    const userId = req.user._id;
    const upvoteIndex = discussion.upvotes.indexOf(userId);
    const downvoteIndex = discussion.downvotes.indexOf(userId);

    // Remove from upvotes if exists
    if (upvoteIndex > -1) {
      discussion.upvotes.splice(upvoteIndex, 1);
    }

    // Toggle downvote
    if (downvoteIndex > -1) {
      discussion.downvotes.splice(downvoteIndex, 1);
    } else {
      discussion.downvotes.push(userId);
    }

    await discussion.save();

    res.json({
      voteCount: discussion.upvotes.length - discussion.downvotes.length,
      userVote: downvoteIndex > -1 ? null : 'down'
    });
  } catch (error) {
    console.error('Error downvoting discussion:', error);
    res.status(500).json({ message: 'Failed to downvote discussion' });
  }
});

// Add comment to discussion
router.post('/:id/comments', protect, async (req, res) => {
  try {
    const { content, code, language } = req.body;

    if (!content) {
      return res.status(400).json({ message: 'Content is required' });
    }

    const discussion = await Discussion.findById(req.params.id);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    const comment = {
      user: req.user._id,
      content,
      code,
      language,
      upvotes: [],
      downvotes: [],
      replies: []
    };

    discussion.comments.push(comment);
    await discussion.save();
    await discussion.populate('comments.user', 'username email');

    const newComment = discussion.comments[discussion.comments.length - 1];
    res.status(201).json(newComment);
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ message: 'Failed to add comment' });
  }
});

// Upvote comment
router.post('/:discussionId/comments/:commentId/upvote', protect, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.discussionId);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    const comment = discussion.comments.id(req.params.commentId);

    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const userId = req.user._id;
    const upvoteIndex = comment.upvotes.indexOf(userId);
    const downvoteIndex = comment.downvotes.indexOf(userId);

    if (downvoteIndex > -1) {
      comment.downvotes.splice(downvoteIndex, 1);
    }

    if (upvoteIndex > -1) {
      comment.upvotes.splice(upvoteIndex, 1);
    } else {
      comment.upvotes.push(userId);
    }

    await discussion.save();

    res.json({
      voteCount: comment.upvotes.length - comment.downvotes.length,
      userVote: upvoteIndex > -1 ? null : 'up'
    });
  } catch (error) {
    console.error('Error upvoting comment:', error);
    res.status(500).json({ message: 'Failed to upvote comment' });
  }
});

export default router;

