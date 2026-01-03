import pool from '../db/index.js';
import { CONFIG } from '../config/index.js';
import { resetMonthlyUsageIfNeeded } from './auth.js';
import { isSystemPaused } from './spending.js';

export async function getAnonymousUsage(fingerprint, ip) {
  let result = await pool.query(
    'SELECT * FROM anonymous_usage WHERE fingerprint = $1',
    [fingerprint]
  );

  if (!result.rows[0]) {
    result = await pool.query(
      `INSERT INTO anonymous_usage (fingerprint, ip_address, recipes_used)
       VALUES ($1, $2, 0)
       RETURNING *`,
      [fingerprint, ip]
    );
  } else {
    await pool.query(
      'UPDATE anonymous_usage SET last_seen = NOW(), ip_address = $2 WHERE fingerprint = $1',
      [fingerprint, ip]
    );
  }

  return result.rows[0];
}

export async function incrementAnonymousUsage(fingerprint) {
  await pool.query(
    'UPDATE anonymous_usage SET recipes_used = recipes_used + 1 WHERE fingerprint = $1',
    [fingerprint]
  );
}

export async function incrementUserUsage(userId) {
  await pool.query(
    `UPDATE users SET
     recipes_used_this_month = recipes_used_this_month + 1,
     total_recipes_ever = total_recipes_ever + 1
     WHERE id = $1`,
    [userId]
  );
}

export async function canCleanRecipe(user, fingerprint, ip) {
  if (await isSystemPaused()) {
    return { allowed: false, reason: 'system_limit' };
  }

  // Logged in user
  if (user) {
    await resetMonthlyUsageIfNeeded(user);

    if (user.subscription === 'pro') return { allowed: true };
    if (user.subscription === 'basic') {
      return {
        allowed: user.recipes_used_this_month < CONFIG.BASIC_RECIPES_PER_MONTH,
        remaining: CONFIG.BASIC_RECIPES_PER_MONTH - user.recipes_used_this_month
      };
    }
    // Free signed-up user
    return {
      allowed: user.recipes_used_this_month < CONFIG.FREE_RECIPES_PER_MONTH,
      remaining: CONFIG.FREE_RECIPES_PER_MONTH - user.recipes_used_this_month,
      upgrade: user.recipes_used_this_month >= CONFIG.FREE_RECIPES_PER_MONTH
    };
  }

  // Anonymous user
  if (fingerprint) {
    const usage = await getAnonymousUsage(fingerprint, ip);
    if (usage.recipes_used < CONFIG.INITIAL_FREE_RECIPES) {
      return {
        allowed: true,
        remaining: CONFIG.INITIAL_FREE_RECIPES - usage.recipes_used,
        isAnonymous: true
      };
    }
    return {
      allowed: false,
      reason: 'initial_limit',
      requiresSignup: true,
      message: "You've used your 10 free recipes! Sign up free to get 3 more each month."
    };
  }

  return { allowed: false, reason: 'no_tracking' };
}

export function getRemainingRecipes(user) {
  if (!user) return 0;
  if (user.subscription === 'pro') return Infinity;
  if (user.subscription === 'basic') {
    return Math.max(0, CONFIG.BASIC_RECIPES_PER_MONTH - user.recipes_used_this_month);
  }
  return Math.max(0, CONFIG.FREE_RECIPES_PER_MONTH - user.recipes_used_this_month);
}
