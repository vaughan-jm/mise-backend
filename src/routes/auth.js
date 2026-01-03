import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  createSession,
  deleteSession,
  getUserByEmail,
  getUserByGoogleId,
  createUser,
  linkGoogleAccount,
  hashPassword,
  verifyPassword,
  resetMonthlyUsageIfNeeded,
  verifyGoogleToken
} from '../services/auth.js';
import { getRemainingRecipes } from '../services/usage.js';
import { CONFIG } from '../config/index.js';

const router = Router();

// Helper to format user response
function formatUserResponse(user, recipesRemaining) {
  return {
    id: user.id,
    email: user.email,
    subscription: user.subscription,
    recipesRemaining
  };
}

// Register with email/password
router.post('/register', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    return res.status(400).json({ error: 'Account already exists' });
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser({ email, passwordHash, googleId: null });
  const session = await createSession(user.id);

  res.json({
    user: formatUserResponse(user, CONFIG.FREE_RECIPES_PER_MONTH),
    token: session.token,
    expiresAt: session.expiresAt
  });
}));

// Login with email/password
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const user = await getUserByEmail(email);
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  await resetMonthlyUsageIfNeeded(user);
  const session = await createSession(user.id);

  res.json({
    user: formatUserResponse(user, getRemainingRecipes(user)),
    token: session.token,
    expiresAt: session.expiresAt
  });
}));

// Google OAuth
router.post('/google', asyncHandler(async (req, res) => {
  const { credential } = req.body;

  // Verify and decode the JWT from Google (with signature verification)
  const { googleId, email } = await verifyGoogleToken(credential);

  let user = await getUserByGoogleId(googleId);

  if (!user) {
    // Check if email exists (user signed up with password before)
    const existingByEmail = await getUserByEmail(email);
    if (existingByEmail) {
      // Link Google account to existing user
      await linkGoogleAccount(existingByEmail.id, googleId);
      user = existingByEmail;
      user.google_id = googleId;
    } else {
      // Create new user
      user = await createUser({ email, passwordHash: null, googleId });
    }
  }

  await resetMonthlyUsageIfNeeded(user);
  const session = await createSession(user.id);

  res.json({
    user: formatUserResponse(user, getRemainingRecipes(user)),
    token: session.token,
    expiresAt: session.expiresAt
  });
}));

// Get current user
router.get('/me', authenticateToken, asyncHandler(async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const user = await resetMonthlyUsageIfNeeded(req.user);

  res.json({
    user: formatUserResponse(user, getRemainingRecipes(user))
  });
}));

// Logout
router.post('/logout', asyncHandler(async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token) {
    await deleteSession(token);
  }
  res.json({ success: true });
}));

export default router;
