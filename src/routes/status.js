import { Router } from 'express';
import { checkSpendingLimits } from '../services/spending.js';

const router = Router();

// Get system status
router.get('/', async (req, res) => {
  const { paused } = await checkSpendingLimits();
  res.json({
    status: paused ? 'limited' : 'operational',
  });
});

export default router;
