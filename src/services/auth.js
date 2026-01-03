import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import pool from '../db/index.js';
import { CONFIG } from '../config/index.js';

// Initialize Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function createSession(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + CONFIG.SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, token, expiresAt]
  );
  return { token, expiresAt };
}

export async function deleteSession(token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function getUserByEmail(email) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0] || null;
}

export async function getUserByGoogleId(googleId) {
  const result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
  return result.rows[0] || null;
}

export async function createUser({ email, passwordHash, googleId }) {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, google_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [email, passwordHash, googleId]
  );
  return result.rows[0];
}

export async function linkGoogleAccount(userId, googleId) {
  await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, userId]);
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export async function resetMonthlyUsageIfNeeded(user) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (user.month_started !== currentMonth) {
    await pool.query(
      'UPDATE users SET recipes_used_this_month = 0, month_started = $1 WHERE id = $2',
      [currentMonth, user.id]
    );
    user.recipes_used_this_month = 0;
    user.month_started = currentMonth;
  }
  return user;
}

// Verify and decode Google JWT token
export async function verifyGoogleToken(credential) {
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    return {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      emailVerified: payload.email_verified
    };
  } catch (err) {
    console.error('Google token verification failed:', err.message);
    throw new Error('Invalid Google token');
  }
}

// Legacy function for backward compatibility (deprecated - use verifyGoogleToken)
export function decodeGoogleToken(credential) {
  console.warn('decodeGoogleToken is deprecated. Use verifyGoogleToken for secure verification.');
  const payload = JSON.parse(Buffer.from(credential.split('.')[1], 'base64').toString());
  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name
  };
}
