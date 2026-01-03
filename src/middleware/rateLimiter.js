// Simple in-memory rate limiter
const requests = new Map();

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of requests.entries()) {
    if (now - data.windowStart > 60000) {
      requests.delete(key);
    }
  }
}, 300000);

export function rateLimiter({ windowMs = 60000, max = 100 } = {}) {
  return (req, res, next) => {
    const key = req.user?.id || req.ip || 'unknown';
    const now = Date.now();

    let data = requests.get(key);

    if (!data || now - data.windowStart > windowMs) {
      data = { windowStart: now, count: 0 };
      requests.set(key, data);
    }

    data.count++;

    if (data.count > max) {
      return res.status(429).json({
        error: 'Too many requests. Please try again later.'
      });
    }

    next();
  };
}

// Stricter limiter for expensive operations (AI calls)
export const recipeRateLimiter = rateLimiter({ windowMs: 60000, max: 10 });

// General API rate limiter
export const apiRateLimiter = rateLimiter({ windowMs: 60000, max: 100 });
