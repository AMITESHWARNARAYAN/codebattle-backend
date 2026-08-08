import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// Generate JWT token
export const generateToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });
};

// ═══ In-Memory User Cache ═══
// Avoids hitting MongoDB on every single authenticated request.
// Entries expire after USER_CACHE_TTL_MS so that permission changes (e.g., isAdmin)
// propagate within a short window. Cache is bounded to prevent memory leaks.
const USER_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const USER_CACHE_MAX_SIZE = 500;

// Map<userId, { user: UserDoc, cachedAt: number }>
const userCache = new Map();

/**
 * Get a user from cache if the entry is still fresh.
 * Returns null on cache miss or stale entry.
 */
function getCachedUser(userId) {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > USER_CACHE_TTL_MS) {
    userCache.delete(userId);
    return null;
  }
  return entry.user;
}

/**
 * Store a user in cache, evicting the oldest entry if at capacity.
 */
function setCachedUser(userId, user) {
  // Evict oldest (FIFO — Map iterates in insertion order)
  if (userCache.size >= USER_CACHE_MAX_SIZE) {
    const oldestKey = userCache.keys().next().value;
    userCache.delete(oldestKey);
  }
  userCache.set(userId, { user, cachedAt: Date.now() });
}

/**
 * Invalidate a specific user's cache entry.
 * Call this after profile updates, role changes, etc.
 */
export function invalidateUserCache(userId) {
  userCache.delete(userId);
}

// Protect routes - verify JWT token
export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Try cache first, fall back to DB
      let user = getCachedUser(decoded.id);
      if (!user) {
        // Only select fields needed for auth checks and common route usage.
        // Heavy fields like solvedProblems[] and matchHistory[] are excluded
        // since routes that need them can fetch the full user explicitly.
        user = await User.findById(decoded.id).select(
          '-password -solvedProblems -matchHistory'
        );

        if (user) {
          setCachedUser(decoded.id, user);
        }
      }

      if (!user) {
        return res.status(401).json({ message: 'User not found' });
      }

      req.user = user;
      next();
    } catch (error) {
      console.error('Auth middleware error:', error);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
};

// Optional auth — attaches req.user if valid token provided, but does not block guests
export const optionalAuth = async (req, res, next) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      let user = getCachedUser(decoded.id);
      if (!user) {
        user = await User.findById(decoded.id).select('-password -solvedProblems -matchHistory');
        if (user) setCachedUser(decoded.id, user);
      }
      if (user) req.user = user;
    } catch (e) {
      // Ignore token errors for guest requests
    }
  }
  next();
};

// Admin middleware
export const isAdmin = (req, res, next) => {
  if (req.user && req.user.isAdmin) {
    next();
  } else {
    res.status(403).json({ message: 'Not authorized as admin' });
  }
};
