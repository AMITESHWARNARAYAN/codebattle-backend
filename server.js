import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Load environment variables FIRST before importing anything that uses them
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try to load .env file (for local development), but don't fail if it doesn't exist (production uses Render env vars)
const envPath = `${__dirname}/.env`;
const result = dotenv.config({ path: envPath });
if (result.error) {
  console.log('ℹ️ No .env file found (using environment variables from hosting platform)');
} else {
  console.log('✅ .env loaded successfully from file');
}

// Log critical environment variables status
console.log('='.repeat(50));
console.log('Environment Check:');
console.log('- GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? '✅ Set' : '❌ Not set');
console.log('- GROQ_API_KEY:', process.env.GROQ_API_KEY ? '✅ Set' : '❌ Not set');
console.log('- SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? '✅ Set' : '❌ Not set');
console.log('- MONGODB_URI:', process.env.MONGODB_URI ? '✅ Set' : '❌ Not set');
console.log('- JWT_SECRET:', process.env.JWT_SECRET ? '✅ Set' : '❌ Not set');
console.log('='.repeat(50));

const app = express();
const httpServer = createServer(app);

// CORS configuration
const corsOrigin = process.env.CORS_ORIGIN || '*';
console.log('CORS Origin:', corsOrigin);

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Make io globally accessible for notifications
global.io = io;

// Socket.io connection handling for notifications
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join user to their own room for notifications
  socket.on('join', (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined their notification room`);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Middleware
app.use(cors({
  origin: corsOrigin,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to MongoDB
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error('❌ MONGODB_URI environment variable not set!');
  console.error('Please add MONGODB_URI to your Render environment variables.');
  process.exit(1);
}
console.log('📡 Connecting to MongoDB...');
mongoose.connect(mongoUri)
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

// Dynamically import routes after .env is loaded
async function setupRoutes() {
  const { default: setupMatchmakingModule } = await import('./socket/matchmaking.js');
  const { default: authRoutesModule } = await import('./routes/auth.js');
  const { default: problemRoutesModule } = await import('./routes/problems.js');
  const { default: matchRoutesModule } = await import('./routes/matches.js');
  const { default: userRoutesModule } = await import('./routes/users.js');
  const { default: adminRoutesModule } = await import('./routes/admin.js');
  const { default: explanationRoutesModule } = await import('./routes/explanations.js');
  const { default: categoryRoutesModule } = await import('./routes/categories.js');
  const { default: dailyChallengeRoutesModule } = await import('./routes/dailyChallenge.js');
  const { default: submissionRoutesModule } = await import('./routes/submissions.js');
  const { default: discussionRoutesModule } = await import('./routes/discussions.js');
  const { default: adminChallengeRoutesModule } = await import('./routes/adminChallenges.js');
  const { default: challengeRoutesModule } = await import('./routes/challenges.js');
  const { default: contestRoutesModule } = await import('./routes/contests.js');
  const { default: adminContestRoutesModule } = await import('./routes/adminContests.js');
  const { default: notificationRoutesModule } = await import('./routes/notifications.js');
  const { default: judgeRoutesModule } = await import('./routes/judge.js');
  const { default: verificationRoutesModule } = await import('./routes/verification.js');
  const { default: testEmailRoutesModule } = await import('./routes/test-email.js');
  const { default: resourceRoutesModule } = await import('./routes/resources.js');

  // Setup WebSocket
  setupMatchmakingModule(io);

  // Routes
  app.use('/api/auth', authRoutesModule);
  app.use('/api/verification', verificationRoutesModule);
  app.use('/api/test-email', testEmailRoutesModule); // Test email endpoint
  app.use('/api/problems', problemRoutesModule);
  app.use('/api/matches', matchRoutesModule);
  app.use('/api/users', userRoutesModule);
  app.use('/api/admin', adminRoutesModule);
  app.use('/api/explanations', explanationRoutesModule);
  app.use('/api/categories', categoryRoutesModule);
  app.use('/api/daily-challenge', dailyChallengeRoutesModule);
  app.use('/api/submissions', submissionRoutesModule);
  app.use('/api/discussions', discussionRoutesModule);
  app.use('/api/admin/challenges', adminChallengeRoutesModule);
  app.use('/api/challenges', challengeRoutesModule);
  app.use('/api/contests', contestRoutesModule);
  app.use('/api/admin/contests', adminContestRoutesModule);
  app.use('/api/notifications', notificationRoutesModule);
  app.use('/api/judge', judgeRoutesModule);
  app.use('/api/resources', resourceRoutesModule);

  const { default: problemMetadataRoutesModule } = await import('./routes/problemMetadata.js');
  app.use('/api/problem-metadata', problemMetadataRoutesModule);
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

// Start server AFTER routes are set up
const PORT = process.env.PORT || 5000;

setupRoutes()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`✅ Frontend URL: ${process.env.FRONTEND_URL}`);
      console.log(`✅ All routes registered successfully`);
    });
  })
  .catch(err => {
    console.error('❌ Error setting up routes:', err);
    process.exit(1);
  });

export default app;

