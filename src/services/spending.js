import pool from '../db/index.js';
import { CONFIG } from '../config/index.js';

// Database-backed spending tracker that persists across deploys
export async function initSpendingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spending_tracker (
      id INTEGER PRIMARY KEY DEFAULT 1,
      daily_date DATE NOT NULL DEFAULT CURRENT_DATE,
      daily_amount DECIMAL(10,4) NOT NULL DEFAULT 0,
      monthly_month VARCHAR(7) NOT NULL DEFAULT TO_CHAR(CURRENT_DATE, 'YYYY-MM'),
      monthly_amount DECIMAL(10,4) NOT NULL DEFAULT 0,
      paused BOOLEAN NOT NULL DEFAULT FALSE,
      CHECK (id = 1)
    )
  `);

  // Ensure single row exists
  await pool.query(`
    INSERT INTO spending_tracker (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);
}

async function getOrResetSpending() {
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = new Date().toISOString().slice(0, 7);

  const result = await pool.query('SELECT * FROM spending_tracker WHERE id = 1');
  let tracker = result.rows[0];

  if (!tracker) {
    await initSpendingTable();
    return getOrResetSpending();
  }

  // Reset daily if new day
  if (tracker.daily_date.toISOString().slice(0, 10) !== today) {
    await pool.query(
      'UPDATE spending_tracker SET daily_date = $1, daily_amount = 0 WHERE id = 1',
      [today]
    );
    tracker.daily_amount = 0;
  }

  // Reset monthly if new month
  if (tracker.monthly_month !== currentMonth) {
    await pool.query(
      'UPDATE spending_tracker SET monthly_month = $1, monthly_amount = 0, paused = FALSE WHERE id = 1',
      [currentMonth]
    );
    tracker.monthly_amount = 0;
    tracker.paused = false;
  }

  return tracker;
}

export async function checkSpendingLimits() {
  const tracker = await getOrResetSpending();

  const shouldPause =
    parseFloat(tracker.daily_amount) >= CONFIG.DAILY_SPENDING_LIMIT ||
    parseFloat(tracker.monthly_amount) >= CONFIG.MONTHLY_SPENDING_LIMIT;

  if (shouldPause !== tracker.paused) {
    await pool.query('UPDATE spending_tracker SET paused = $1 WHERE id = 1', [shouldPause]);
  }

  return { paused: shouldPause };
}

export async function trackSpending(amount) {
  await pool.query(
    `UPDATE spending_tracker
     SET daily_amount = daily_amount + $1,
         monthly_amount = monthly_amount + $1
     WHERE id = 1`,
    [amount]
  );
  return checkSpendingLimits();
}

export async function isSystemPaused() {
  const { paused } = await checkSpendingLimits();
  return paused;
}

export async function getSpendingStatus() {
  const tracker = await getOrResetSpending();
  const { paused } = await checkSpendingLimits();

  return {
    daily: parseFloat(tracker.daily_amount),
    monthly: parseFloat(tracker.monthly_amount),
    paused,
    limits: {
      daily: CONFIG.DAILY_SPENDING_LIMIT,
      monthly: CONFIG.MONTHLY_SPENDING_LIMIT
    }
  };
}
