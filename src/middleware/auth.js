import pool from '../db/index.js';

// Validate session token and attach user to request
export async function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const result = await pool.query(
      `SELECT s.*, u.* FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    req.user = result.rows[0] || null;
  } catch (err) {
    console.error('Auth middleware error:', err);
    req.user = null;
  }

  next();
}

// Require authentication - use after authenticateToken
export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// Require paid subscription
export function requirePaidSubscription(req, res, next) {
  if (!req.user || !['basic', 'pro'].includes(req.user.subscription)) {
    return res.status(402).json({
      error: 'upgrade_required',
      message: 'Upgrade to access this feature'
    });
  }
  next();
}
