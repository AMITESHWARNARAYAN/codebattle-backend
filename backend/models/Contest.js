import mongoose from 'mongoose';

const contestParticipantSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  username: String,
  registeredAt: {
    type: Date,
    default: Date.now
  },
  startedAt: Date,
  submissions: [{
    problem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Problem'
    },
    submittedAt: Date,
    code: String,
    language: String,
    status: {
      type: String,
      enum: ['accepted', 'wrong-answer', 'time-limit', 'runtime-error', 'compilation-error']
    },
    runtime: Number,
    memory: Number,
    testCasesPassed: Number,
    totalTestCases: Number,
    score: Number, // Points earned for this problem
    penalty: Number // Time penalty in minutes
  }],
  totalScore: {
    type: Number,
    default: 0
  },
  totalPenalty: {
    type: Number,
    default: 0
  },
  problemsSolved: {
    type: Number,
    default: 0
  },
  rank: Number,
  ratingChange: Number,
  oldContestRating: Number,
  newContestRating: Number,
  isVirtual: {
    type: Boolean,
    default: false
  },
  endedAt: Date
});

const contestSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['weekly', 'biweekly', 'special', 'virtual'],
    default: 'weekly'
  },
  problems: [{
    problem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Problem',
      required: true
    },
    points: {
      type: Number,
      default: 100
    },
    order: Number
  }],
  startTime: {
    type: Date,
    required: true
  },
  endTime: {
    type: Date,
    required: true
  },
  duration: {
    type: Number, // Duration in minutes
    required: true
  },
  status: {
    type: String,
    enum: ['upcoming', 'running', 'finished', 'cancelled'],
    default: 'upcoming'
  },
  participants: [contestParticipantSchema],
  totalParticipants: {
    type: Number,
    default: 0
  },
  rules: {
    type: String,
    default: 'Standard ICPC rules apply. Wrong submissions incur 20-minute penalty.'
  },
  prizes: [{
    rank: Number,
    description: String,
    badge: String
  }],
  isRated: {
    type: Boolean,
    default: true
  },
  ratingFloor: {
    type: Number,
    default: 0
  },
  ratingCeiling: {
    type: Number,
    default: 3000
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  isVisible: {
    type: Boolean,
    default: true
  },
  _ratingsFinalized: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
contestSchema.index({ status: 1, startTime: 1 });
contestSchema.index({ type: 1, status: 1 });
contestSchema.index({ 'participants.user': 1 });

// Pre-save hook to update status based on time
contestSchema.pre('save', function(next) {
  const now = new Date();
  
  if (this.status === 'cancelled') {
    return next();
  }
  
  if (now < this.startTime) {
    this.status = 'upcoming';
  } else if (now >= this.startTime && now < this.endTime) {
    this.status = 'running';
  } else if (now >= this.endTime) {
    this.status = 'finished';
  }
  
  this.totalParticipants = this.participants.length;
  next();
});

// Method to calculate leaderboard
contestSchema.methods.calculateLeaderboard = function() {
  const participants = this.participants.map(p => ({
    user: p.user,
    username: p.username,
    totalScore: p.totalScore,
    totalPenalty: p.totalPenalty,
    problemsSolved: p.problemsSolved,
    submissions: p.submissions
  }));

  // Sort by: 1) Total score (desc), 2) Total penalty (asc), 3) Last submission time (asc)
  participants.sort((a, b) => {
    if (b.totalScore !== a.totalScore) {
      return b.totalScore - a.totalScore;
    }
    if (a.totalPenalty !== b.totalPenalty) {
      return a.totalPenalty - b.totalPenalty;
    }
    const aLastSubmission = a.submissions.length > 0 ? 
      new Date(a.submissions[a.submissions.length - 1].submittedAt) : new Date(0);
    const bLastSubmission = b.submissions.length > 0 ? 
      new Date(b.submissions[b.submissions.length - 1].submittedAt) : new Date(0);
    return aLastSubmission - bLastSubmission;
  });

  // Assign ranks
  participants.forEach((p, index) => {
    const participant = this.participants.find(
      part => part.user.toString() === p.user.toString()
    );
    if (participant) {
      participant.rank = index + 1;
    }
  });

  return participants;
};

// Method to check if user can register
contestSchema.methods.canRegister = function(userId) {
  const now = new Date();
  if (now >= this.endTime) return false;
  if (this.status === 'cancelled') return false;
  
  const alreadyRegistered = this.participants.some(
    p => (p.user._id || p.user).toString() === userId.toString()
  );
  
  return !alreadyRegistered;
};

contestSchema.methods.getUserData = function(userId) {
  return this.participants.find(
    p => (p.user._id || p.user).toString() === userId.toString()
  );
};

const Contest = mongoose.model('Contest', contestSchema);

export default Contest;

