import express from 'express';
import Resource from '../models/Resource.js';
import auth from '../middleware/auth.js';

const router = express.Router();

// Get all active resources (public)
router.get('/', async (req, res) => {
  try {
    const resources = await Resource.find({ isActive: true })
      .sort({ type: 1, order: 1, createdAt: -1 })
      .select('-createdBy');
    
    res.json(resources);
  } catch (error) {
    console.error('Get resources error:', error);
    res.status(500).json({ message: 'Failed to fetch resources' });
  }
});

// Get resources by type (public)
router.get('/type/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const resources = await Resource.find({ type, isActive: true })
      .sort({ order: 1, createdAt: -1 })
      .select('-createdBy');
    
    res.json(resources);
  } catch (error) {
    console.error('Get resources by type error:', error);
    res.status(500).json({ message: 'Failed to fetch resources' });
  }
});

// Admin Routes (require auth and admin role)

// Get all resources (admin)
router.get('/admin', auth, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const resources = await Resource.find()
      .sort({ type: 1, order: 1, createdAt: -1 })
      .populate('createdBy', 'username email');
    
    res.json(resources);
  } catch (error) {
    console.error('Get all resources error:', error);
    res.status(500).json({ message: 'Failed to fetch resources' });
  }
});

// Create resource (admin)
router.post('/admin', auth, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { type, title, description, category, difficulty, topics, url, platform, icon } = req.body;

    const resource = new Resource({
      type,
      title,
      description,
      category,
      difficulty,
      topics,
      url,
      platform,
      icon,
      createdBy: req.user.id
    });

    await resource.save();
    res.status(201).json(resource);
  } catch (error) {
    console.error('Create resource error:', error);
    res.status(500).json({ message: 'Failed to create resource' });
  }
});

// Update resource (admin)
router.put('/admin/:id', auth, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { id } = req.params;
    const { type, title, description, category, difficulty, topics, url, platform, icon, isActive } = req.body;

    const resource = await Resource.findByIdAndUpdate(
      id,
      { type, title, description, category, difficulty, topics, url, platform, icon, isActive },
      { new: true, runValidators: true }
    );

    if (!resource) {
      return res.status(404).json({ message: 'Resource not found' });
    }

    res.json(resource);
  } catch (error) {
    console.error('Update resource error:', error);
    res.status(500).json({ message: 'Failed to update resource' });
  }
});

// Delete resource (admin)
router.delete('/admin/:id', auth, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { id } = req.params;
    const resource = await Resource.findByIdAndDelete(id);

    if (!resource) {
      return res.status(404).json({ message: 'Resource not found' });
    }

    res.json({ message: 'Resource deleted successfully' });
  } catch (error) {
    console.error('Delete resource error:', error);
    res.status(500).json({ message: 'Failed to delete resource' });
  }
});

// Update resource order (admin)
router.patch('/admin/:id/order', auth, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { id } = req.params;
    const { order } = req.body;

    const resource = await Resource.findByIdAndUpdate(
      id,
      { order },
      { new: true }
    );

    if (!resource) {
      return res.status(404).json({ message: 'Resource not found' });
    }

    res.json(resource);
  } catch (error) {
    console.error('Update resource order error:', error);
    res.status(500).json({ message: 'Failed to update resource order' });
  }
});

export default router;
