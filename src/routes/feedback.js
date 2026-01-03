import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { authenticateToken } from '../middleware/auth.js';
import pool from '../db/index.js';

const router = Router();

// Submit feedback
router.post('/', authenticateToken, asyncHandler(async (req, res) => {
  const { message, type } = req.body;

  await pool.query(
    'INSERT INTO feedback (user_id, email, message, type) VALUES ($1, $2, $3, $4)',
    [req.user?.user_id || null, req.user?.email || null, message, type || 'idea']
  );

  res.json({ success: true });
}));

// Submit rating
router.post('/rating', authenticateToken, asyncHandler(async (req, res) => {
  const { stars } = req.body;
  const identifier = req.user?.user_id?.toString() || req.ip;

  await pool.query(
    `INSERT INTO ratings (user_id, identifier, stars) VALUES ($1, $2, $3)
     ON CONFLICT (identifier) DO UPDATE SET stars = $3, updated_at = NOW()`,
    [req.user?.user_id || null, identifier, stars]
  );

  res.json({ success: true });
}));

// Get ratings summary
router.get('/ratings/summary', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings');
  const { avg, count } = result.rows[0];

  if (count < 5) return res.json({ average: 0, count: 0, display: null });

  res.json({
    average: parseFloat(avg),
    count: parseInt(count),
    display: {
      average: parseFloat(avg).toFixed(1),
      count: parseInt(count),
      text: `${parseFloat(avg).toFixed(1)} ★ from ${count} cooks`
    }
  });
}));

export default router;
