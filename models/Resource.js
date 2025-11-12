import mongoose from 'mongoose';

const resourceSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['learning-path', 'tutorial', 'video', 'external']
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  category: String,
  difficulty: {
    type: String,
    enum: ['Beginner', 'Intermediate', 'Advanced', 'Beginner to Advanced']
  },
  topics: [String],
  url: String,
  platform: String,
  icon: {
    type: String,
    default: 'BookOpen'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  order: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Add index for sorting
resourceSchema.index({ type: 1, order: 1 });

export default mongoose.model('Resource', resourceSchema);
