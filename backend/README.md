# CodeBattle Backend

CodeBattle is a backend service for a DSA practice and competition platform. It powers problem solving, real-time matches, contests, and daily challenges so users can practice coding in a structured and competitive way.

## What This Project Does

- Lets users practice DSA problems with full submission and judging support.
- Supports multiple practice modes for different learning styles.
- Handles real-time battles, notifications, and contest flows.
- Stores users, problems, submissions, matches, and challenge data in MongoDB.

## Core Features

### Practice Modes

- **Solo practice** - solve problems at your own pace.
- **Friend challenge** - challenge a specific user by invite or email.
- **Matchmaking** - get paired automatically with another player.
- **Contests** - participate in competitive coding contests.
- **Daily challenges** - try a fresh challenge every day.

### Platform Features

- DSA problem browsing and filtering.
- Code submission and automated judging.
- Match scoring and rating updates.
- User authentication and profiles.
- Real-time notifications with Socket.io.
- Contest and leaderboard-style gameplay.

## Tech Stack

- Node.js
- Express
- MongoDB with Mongoose
- Socket.io
- JWT authentication
- Judge0 / code execution pipeline

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file in the backend folder.

3. Start the backend:

```bash
npm run dev
```

## Environment Variables

The backend expects values like:

- `MONGODB_URI`
- `JWT_SECRET`
- `FRONTEND_URL`
- `JUDGE0_API_URL`
- `JUDGE0_API_KEY`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `SENDGRID_API_KEY`

## Backend Responsibilities

- User authentication and profile data.
- DSA problem and submission management.
- Solo, friend, and matchmaking gameplay.
- Contest and daily challenge support.
- Notification and real-time event delivery.

## Notes

- Do not commit `.env` or `node_modules`.
- This repository is meant to contain only backend application code and related runtime files.
