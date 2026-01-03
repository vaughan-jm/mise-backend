import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";
import crypto from "crypto";
import bcrypt from "bcryptjs";

dotenv.config();

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// PostgreSQL connection
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.query('SELECT NOW()', (err) => {
  if (err) console.error('❌ Database connection failed:', err.message);
  else console.log('✅ Database connected');
});

// =============================================================================
// CONFIGURATION
// =============================================================================
const CONFIG = {
  COST_PER_URL_RECIPE: 0.03,
  COST_PER_PHOTO_RECIPE: 0.06,
  DAILY_SPENDING_LIMIT: 10,
  MONTHLY_SPENDING_LIMIT: 100,
  INITIAL_FREE_RECIPES: 10,
  FREE_RECIPES_PER_MONTH: 3,
  SESSION_DURATION_DAYS: 30,
  BASIC_RECIPES_PER_MONTH: 20,
};

// In-memory spending tracker (resets on deploy, but that's OK for cost protection)
const spendingTracker = {
  today: { date: new Date().toDateString(), amount: 0 },
  month: { month: new Date().toISOString().slice(0, 7), amount: 0 },
  paused: false,
};

function checkSpendingLimits() {
  const today = new Date().toDateString();
  if (spendingTracker.today.date !== today) {
    spendingTracker.today = { date: today, amount: 0 };
  }
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (spendingTracker.month.month !== currentMonth) {
    spendingTracker.month = { month: currentMonth, amount: 0 };
  }
  
  if (spendingTracker.today.amount >= CONFIG.DAILY_SPENDING_LIMIT ||
      spendingTracker.month.amount >= CONFIG.MONTHLY_SPENDING_LIMIT) {
    spendingTracker.paused = true;
  }
}

function trackSpending(amount) {
  spendingTracker.today.amount += amount;
  spendingTracker.month.amount += amount;
  checkSpendingLimits();
}

// =============================================================================
// MIDDLEWARE
// =============================================================================
app.use(cors({ 
  origin: true,
  credentials: true 
}));
app.use(express.json({ limit: '50mb' }));

// =============================================================================
// AUTH HELPERS
// =============================================================================
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + CONFIG.SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, token, expiresAt]
  );
  return { token, expiresAt };
}

async function validateSession(token) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT s.*, u.* FROM sessions s 
     JOIN users u ON s.user_id = u.id 
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );
  return result.rows[0] || null;
}

async function getUserByEmail(email) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0] || null;
}

async function getUserByGoogleId(googleId) {
  const result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
  return result.rows[0] || null;
}

async function createUser({ email, passwordHash, googleId }) {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, google_id) 
     VALUES ($1, $2, $3) 
     RETURNING *`,
    [email, passwordHash, googleId]
  );
  return result.rows[0];
}

async function resetMonthlyUsageIfNeeded(user) {
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

// =============================================================================
// ANONYMOUS USAGE TRACKING
// =============================================================================
async function getAnonymousUsage(fingerprint, ip) {
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

async function incrementAnonymousUsage(fingerprint) {
  await pool.query(
    'UPDATE anonymous_usage SET recipes_used = recipes_used + 1 WHERE fingerprint = $1',
    [fingerprint]
  );
}

// =============================================================================
// RECIPE LIMITS
// =============================================================================
async function canCleanRecipe(user, fingerprint, ip) {
  checkSpendingLimits();
  if (spendingTracker.paused) {
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

async function incrementUserUsage(user) {
  await pool.query(
    `UPDATE users SET 
     recipes_used_this_month = recipes_used_this_month + 1,
     total_recipes_ever = total_recipes_ever + 1
     WHERE id = $1`,
    [user.id]
  );
}

function getRemainingRecipes(user) {
  if (!user) return 0;
  if (user.subscription === 'pro') return Infinity;
  if (user.subscription === 'basic') {
    return Math.max(0, CONFIG.BASIC_RECIPES_PER_MONTH - user.recipes_used_this_month);
  }
  return Math.max(0, CONFIG.FREE_RECIPES_PER_MONTH - user.recipes_used_this_month);
}

// =============================================================================
// STATUS
// =============================================================================
app.get('/api/status', (req, res) => {
  checkSpendingLimits();
  res.json({
    status: spendingTracker.paused ? 'limited' : 'operational',
  });
});

// =============================================================================
// AUTH ENDPOINTS
// =============================================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const existing = await getUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'Account already exists' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser({ email, passwordHash, googleId: null });
    const session = await createSession(user.id);
    
    res.json({ 
      user: { 
        id: user.id,
        email: user.email, 
        subscription: user.subscription, 
        recipesRemaining: CONFIG.FREE_RECIPES_PER_MONTH 
      },
      token: session.token,
      expiresAt: session.expiresAt
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const user = await getUserByEmail(email);
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    await resetMonthlyUsageIfNeeded(user);
    const session = await createSession(user.id);
    
    res.json({ 
      user: { 
        id: user.id,
        email: user.email, 
        subscription: user.subscription, 
        recipesRemaining: getRemainingRecipes(user)
      },
      token: session.token,
      expiresAt: session.expiresAt
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    
    // Decode the JWT from Google (in production, verify signature!)
    const payload = JSON.parse(Buffer.from(credential.split('.')[1], 'base64').toString());
    const { sub: googleId, email, name } = payload;
    
    let user = await getUserByGoogleId(googleId);
    
    if (!user) {
      // Check if email exists (user signed up with password before)
      const existingByEmail = await getUserByEmail(email);
      if (existingByEmail) {
        // Link Google account to existing user
        await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, existingByEmail.id]);
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
      user: { 
        id: user.id,
        email: user.email, 
        subscription: user.subscription, 
        recipesRemaining: getRemainingRecipes(user)
      },
      token: session.token,
      expiresAt: session.expiresAt
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Google sign-in failed' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = await validateSession(token);
    
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const user = await resetMonthlyUsageIfNeeded(session);
    
    res.json({ 
      user: { 
        id: user.id,
        email: user.email, 
        subscription: user.subscription, 
        recipesRemaining: getRemainingRecipes(user)
      }
    });
  } catch (err) {
    console.error('Auth check error:', err);
    res.status(500).json({ error: 'Auth check failed' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (token) {
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// =============================================================================
// RECIPE HELPERS (same as before)
// =============================================================================
async function fetchWebpage(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    return await response.text();
  } catch (err) {
    console.error('Fetch error:', err);
    return null;
  }
}

function extractRecipeSchema(html) {
  try {
    const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        let data = JSON.parse(match[1]);
        if (data['@graph']) {
          data = data['@graph'].find(item => item['@type'] === 'Recipe' || item['@type']?.includes('Recipe'));
        }
        if (Array.isArray(data)) {
          data = data.find(item => item['@type'] === 'Recipe' || item['@type']?.includes('Recipe'));
        }
        if (data && (data['@type'] === 'Recipe' || data['@type']?.includes('Recipe'))) {
          return data;
        }
      } catch (e) {}
    }
    return null;
  } catch (err) {
    return null;
  }
}

function convertSchemaToRecipe(schema, sourceUrl) {
  const ingredients = schema.recipeIngredient || [];
  let steps = [];
  const instructions = schema.recipeInstructions || [];
  
  if (typeof instructions === 'string') {
    steps = instructions.split(/\.|\n/).filter(s => s.trim()).map(s => ({
      instruction: s.trim() + '.', ingredients: []
    }));
  } else if (Array.isArray(instructions)) {
    steps = instructions.map(step => {
      if (typeof step === 'string') return { instruction: step, ingredients: [] };
      if (step['@type'] === 'HowToStep') return { instruction: step.text || step.name || '', ingredients: [] };
      if (step['@type'] === 'HowToSection') {
        return (step.itemListElement || []).map(item => ({ instruction: item.text || item.name || '', ingredients: [] }));
      }
      return { instruction: String(step), ingredients: [] };
    }).flat();
  }
  
  const parseDuration = (d) => {
    if (!d) return null;
    const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
    if (!m) return d;
    const h = parseInt(m[1] || 0), min = parseInt(m[2] || 0);
    if (h && min) return `${h}h ${min}min`;
    if (h) return `${h}h`;
    if (min) return `${min} min`;
    return null;
  };
  
  let imageUrl = typeof schema.image === 'string' ? schema.image : schema.image?.url || schema.image?.[0]?.url || schema.image?.[0] || null;
  let author = typeof schema.author === 'string' ? schema.author : schema.author?.name || schema.author?.[0]?.name || null;
  
  return {
    title: schema.name || 'Recipe',
    servings: parseInt(schema.recipeYield?.[0] || schema.recipeYield) || 4,
    prepTime: parseDuration(schema.prepTime),
    cookTime: parseDuration(schema.cookTime),
    imageUrl, ingredients, steps, tips: [],
    source: new URL(sourceUrl).hostname.replace('www.', ''),
    sourceUrl, author, _needsDualUnits: true,
  };
}

function validateAndFixRecipe(recipe) {
  const issues = [];
  if (!recipe.title) recipe.title = 'Recipe';
  if (!recipe.servings) recipe.servings = 4;
  if (!recipe.ingredients || !Array.isArray(recipe.ingredients)) recipe.ingredients = [];
  if (!recipe.steps || !Array.isArray(recipe.steps)) recipe.steps = [];
  
  const MAX_STEP_LENGTH = 400;
  if (recipe.steps.some(s => (typeof s === 'string' ? s : s.instruction)?.length > MAX_STEP_LENGTH)) {
    issues.push('steps_too_long');
  }
  if (recipe.ingredients.length > 5 && recipe.steps.length < 3) {
    issues.push('too_few_steps');
  }
  
  recipe.steps = recipe.steps.map(s => typeof s === 'string' ? { instruction: s, ingredients: [] } : { ...s, ingredients: s.ingredients || [] });
  recipe.steps = recipe.steps.filter(s => s.instruction?.trim().length > 10);
  
  return { recipe, issues };
}

async function enhanceRecipeWithDualUnits(recipe, targetLanguage = 'en') {
  const langInstr = {
    en: 'Output in English.', es: 'Output in Spanish.', fr: 'Output in French.',
    pt: 'Output in Portuguese.', zh: 'Output in Simplified Chinese.',
    hi: 'Output in Hindi.', ar: 'Output in Arabic. Keep JSON keys in English.',
  };
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `Convert this recipe to have dual units. Return ONLY valid JSON.\n\nINPUT:\n${JSON.stringify(recipe)}\n\nRULES:\n- Dual units: "500g / 1.1 lb", "1 cup / 240ml", "400°F / 200°C"\n- Each step needs "ingredients" array with EXACT strings from main ingredients\n- ${langInstr[targetLanguage] || langInstr.en}\n- Return complete recipe JSON`
      }]
    });
    
    let text = response.content?.map(c => c.text || '').join('') || '';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return recipe;
    
    const enhanced = JSON.parse(match[0]);
    delete enhanced._needsDualUnits;
    return enhanced;
  } catch (err) {
    console.error('Enhance error:', err);
    return recipe;
  }
}

async function fixRecipeIssues(recipe, issues, targetLanguage = 'en') {
  if (!issues.length) return recipe;
  
  const langInstr = {
    en: 'Output in English.', es: 'Output in Spanish.', fr: 'Output in French.',
    pt: 'Output in Portuguese.', zh: 'Output in Simplified Chinese.',
    hi: 'Output in Hindi.', ar: 'Output in Arabic. Keep JSON keys in English.',
  };
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `Fix this recipe. Issues: ${issues.join(', ')}\n\nRECIPE:\n${JSON.stringify(recipe)}\n\nFIXES:\n${issues.includes('steps_too_long') ? '- Split long steps (max 300 chars each)' : ''}\n${issues.includes('too_few_steps') ? '- Break into more steps' : ''}\n\nRULES:\n- One action per step\n- Each step needs "ingredients" array\n- Dual units\n- ${langInstr[targetLanguage] || langInstr.en}\n- Return ONLY valid JSON`
      }]
    });
    
    let text = response.content?.map(c => c.text || '').join('') || '';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : recipe;
  } catch (err) {
    console.error('Fix error:', err);
    return recipe;
  }
}

function stripHtml(html) {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 15000);
}

// =============================================================================
// RECIPE ENDPOINTS
// =============================================================================
app.post('/api/recipe/clean-url', async (req, res) => {
  const { url, language, fingerprint } = req.body;
  const targetLanguage = ['en', 'es', 'fr', 'pt', 'zh', 'hi', 'ar'].includes(language) ? language : 'en';
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const ip = req.ip || req.headers['x-forwarded-for'];
  
  try {
    const session = await validateSession(token);
    const user = session ? await resetMonthlyUsageIfNeeded(session) : null;
    
    const canClean = await canCleanRecipe(user, fingerprint, ip);
    if (!canClean.allowed) {
      return res.status(402).json({ 
        error: canClean.reason, 
        requiresSignup: canClean.requiresSignup,
        upgrade: canClean.upgrade,
        message: canClean.message || 'Upgrade for more recipes!'
      });
    }
    
    console.log(`📥 Recipe request for: ${url}`);
    const html = await fetchWebpage(url);
    if (!html) return res.status(400).json({ error: 'Could not fetch recipe page.' });
    
    const schema = extractRecipeSchema(html);
    let recipe;
    
    if (schema) {
      console.log('⚡ Fast path');
      recipe = convertSchemaToRecipe(schema, url);
      const { recipe: validated, issues } = validateAndFixRecipe(recipe);
      recipe = validated;
      if (issues.length) recipe = await fixRecipeIssues(recipe, issues, targetLanguage);
      recipe = await enhanceRecipeWithDualUnits(recipe, targetLanguage);
      trackSpending(CONFIG.COST_PER_URL_RECIPE * 0.5);
    } else {
      console.log('🐢 Slow path');
      const langInstr = { en: 'Output in English.', es: 'Output in Spanish.', fr: 'Output in French.', pt: 'Output in Portuguese.', zh: 'Output in Simplified Chinese.', hi: 'Output in Hindi.', ar: 'Output in Arabic.' };
      
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        messages: [{
          role: 'user',
          content: `Extract recipe from this webpage. Return ONLY valid JSON:\n{"title":"","servings":4,"prepTime":"","cookTime":"","imageUrl":null,"ingredients":["500g / 1.1 lb item"],"steps":[{"instruction":"","ingredients":[]}],"tips":[],"source":"","sourceUrl":"${url}","author":null}\n\nRULES:\n- Dual units always\n- Each step has ingredients array with EXACT strings from main ingredients\n- ${langInstr[targetLanguage] || langInstr.en}\n\nWEBPAGE:\n${stripHtml(html)}`
        }]
      });
      
      let text = response.content?.map(c => c.text || '').join('') || '';
      text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON');
      
      recipe = JSON.parse(match[0]);
      recipe.sourceUrl = url;
      const { recipe: validated, issues } = validateAndFixRecipe(recipe);
      recipe = validated;
      if (issues.length) recipe = await fixRecipeIssues(recipe, issues, targetLanguage);
      trackSpending(CONFIG.COST_PER_URL_RECIPE);
    }
    
    // Track usage
    if (user) {
      await incrementUserUsage(user);
    } else if (fingerprint) {
      await incrementAnonymousUsage(fingerprint);
    }
    
    const remaining = user ? getRemainingRecipes({ ...user, recipes_used_this_month: user.recipes_used_this_month + 1 }) 
                          : Math.max(0, (canClean.remaining || 0) - 1);
    
    console.log(`✅ Recipe: ${recipe.title}`);
    res.json({ recipe, recipesRemaining: remaining });
  } catch (err) {
    console.error('Recipe error:', err);
    res.status(500).json({ error: 'Failed to clean recipe.' });
  }
});

app.post('/api/recipe/clean-photo', async (req, res) => {
  const { photos, language, fingerprint } = req.body;
  const targetLanguage = ['en', 'es', 'fr', 'pt', 'zh', 'hi', 'ar'].includes(language) ? language : 'en';
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const ip = req.ip || req.headers['x-forwarded-for'];
  
  try {
    const session = await validateSession(token);
    const user = session ? await resetMonthlyUsageIfNeeded(session) : null;
    
    const canClean = await canCleanRecipe(user, fingerprint, ip);
    if (!canClean.allowed) {
      return res.status(402).json({ 
        error: canClean.reason, 
        requiresSignup: canClean.requiresSignup,
        upgrade: canClean.upgrade,
        message: canClean.message || 'Upgrade for more recipes!'
      });
    }
    
    const langInstr = { en: 'Output in English.', es: 'Output in Spanish.', fr: 'Output in French.', pt: 'Output in Portuguese.', zh: 'Output in Simplified Chinese.', hi: 'Output in Hindi.', ar: 'Output in Arabic.' };
    
    const photosToProcess = photos.slice(0, 4);
    const content = photosToProcess.map(p => {
      const m = p.match(/^data:(.+);base64,(.+)$/);
      return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null;
    }).filter(Boolean);
    
    content.push({
      type: 'text',
      text: `Extract recipe from photos. Return ONLY valid JSON:\n{"title":"","servings":4,"prepTime":"","cookTime":"","imageUrl":null,"ingredients":["500g / 1.1 lb item"],"steps":[{"instruction":"","ingredients":[]}],"tips":[],"source":"Cookbook","sourceUrl":null,"author":null}\n\nRULES:\n- Dual units\n- Each step has ingredients array\n- ${langInstr[targetLanguage] || langInstr.en}`
    });
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content }]
    });
    
    let text = response.content?.map(c => c.text || '').join('') || '';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON');
    
    let recipe = JSON.parse(match[0]);
    const { recipe: validated, issues } = validateAndFixRecipe(recipe);
    recipe = validated;
    if (issues.length) recipe = await fixRecipeIssues(recipe, issues, targetLanguage);
    
    trackSpending(CONFIG.COST_PER_PHOTO_RECIPE);
    
    if (user) await incrementUserUsage(user);
    else if (fingerprint) await incrementAnonymousUsage(fingerprint);
    
    const remaining = user ? getRemainingRecipes({ ...user, recipes_used_this_month: user.recipes_used_this_month + 1 }) 
                          : Math.max(0, (canClean.remaining || 0) - 1);
    
    res.json({ recipe, recipesRemaining: remaining });
  } catch (err) {
    console.error('Photo error:', err);
    res.status(500).json({ error: 'Failed to read recipe from photos.' });
  }
});

app.post('/api/recipe/clean-youtube', async (req, res) => {
  const { url, language, fingerprint } = req.body;
  const targetLanguage = ['en', 'es', 'fr', 'pt', 'zh', 'hi', 'ar'].includes(language) ? language : 'en';
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const ip = req.ip || req.headers['x-forwarded-for'];
  
  try {
    const session = await validateSession(token);
    const user = session ? await resetMonthlyUsageIfNeeded(session) : null;
    
    const canClean = await canCleanRecipe(user, fingerprint, ip);
    if (!canClean.allowed) {
      return res.status(402).json({ 
        error: canClean.reason, 
        requiresSignup: canClean.requiresSignup,
        upgrade: canClean.upgrade,
        message: canClean.message || 'Upgrade for more recipes!'
      });
    }
    
    // Extract video ID
    const videoIdMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&\n?#]+)/);
    if (!videoIdMatch) return res.status(400).json({ error: 'Invalid YouTube URL.' });
    const videoId = videoIdMatch[1];
    
    // Get transcript (simplified - in production use youtube-transcript API)
    const videoPage = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = await videoPage.text();
    
    // Try to extract captions URL
    let transcript = '';
    const baseUrlMatch = html.match(/"baseUrl":\s*"([^"]+timedtext[^"]+)"/);
    if (baseUrlMatch) {
      const captionUrl = baseUrlMatch[1].replace(/\\u0026/g, '&');
      const captionRes = await fetch(captionUrl);
      const captionData = await captionRes.text();
      const textMatches = captionData.matchAll(/<text[^>]*>([^<]+)<\/text>/g);
      transcript = [...textMatches].map(m => m[1]).join(' ');
    }
    
    // Fallback to description
    if (!transcript || transcript.length < 100) {
      const descMatch = html.match(/"description":\s*\{"simpleText":\s*"([^"]+)"/);
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      transcript = `Title: ${titleMatch?.[1] || ''}\nDescription: ${descMatch?.[1]?.replace(/\\n/g, '\n') || ''}`;
    }
    
    if (!transcript || transcript.length < 50) {
      return res.status(400).json({ error: 'Could not extract transcript. Video may not have captions.' });
    }
    
    const langInstr = { en: 'Output in English.', es: 'Output in Spanish.', fr: 'Output in French.', pt: 'Output in Portuguese.', zh: 'Output in Simplified Chinese.', hi: 'Output in Hindi.', ar: 'Output in Arabic.' };
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `Extract recipe from this cooking video transcript. Return ONLY valid JSON:\n{"title":"","servings":4,"prepTime":"","cookTime":"","imageUrl":null,"ingredients":["500g / 1.1 lb item"],"steps":[{"instruction":"","ingredients":[]}],"tips":[],"source":"YouTube","sourceUrl":"${url}","author":null}\n\nRULES:\n- Estimate amounts if not stated\n- Dual units\n- Each step has ingredients array\n- ${langInstr[targetLanguage] || langInstr.en}\n\nTRANSCRIPT:\n${transcript.slice(0, 12000)}`
      }]
    });
    
    let text = response.content?.map(c => c.text || '').join('') || '';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON');
    
    let recipe = JSON.parse(match[0]);
    recipe.sourceUrl = url;
    const { recipe: validated, issues } = validateAndFixRecipe(recipe);
    recipe = validated;
    if (issues.length) recipe = await fixRecipeIssues(recipe, issues, targetLanguage);
    
    trackSpending(CONFIG.COST_PER_URL_RECIPE * 1.5);
    
    if (user) await incrementUserUsage(user);
    else if (fingerprint) await incrementAnonymousUsage(fingerprint);
    
    const remaining = user ? getRemainingRecipes({ ...user, recipes_used_this_month: user.recipes_used_this_month + 1 }) 
                          : Math.max(0, (canClean.remaining || 0) - 1);
    
    res.json({ recipe, recipesRemaining: remaining });
  } catch (err) {
    console.error('YouTube error:', err);
    res.status(500).json({ error: 'Failed to extract recipe from video.' });
  }
});

// =============================================================================
// SAVED RECIPES
// =============================================================================
app.get('/api/recipes/saved', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const session = await validateSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  
  const result = await pool.query(
    'SELECT * FROM saved_recipes WHERE user_id = $1 ORDER BY saved_at DESC',
    [session.user_id]
  );
  
  const recipes = result.rows.map(r => ({
    id: r.id,
    title: r.title,
    servings: r.servings,
    prepTime: r.prep_time,
    cookTime: r.cook_time,
    imageUrl: r.image_url,
    ingredients: r.ingredients,
    steps: r.steps,
    tips: r.tips,
    source: r.source,
    sourceUrl: r.source_url,
    author: r.author,
    savedAt: r.saved_at
  }));
  
  res.json({ recipes });
});

app.post('/api/recipes/save', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const session = await validateSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  
  const { recipe } = req.body;
  
  await pool.query(
    `INSERT INTO saved_recipes (user_id, title, servings, prep_time, cook_time, image_url, ingredients, steps, tips, source, source_url, author)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [session.user_id, recipe.title, recipe.servings, recipe.prepTime, recipe.cookTime, recipe.imageUrl, 
     JSON.stringify(recipe.ingredients), JSON.stringify(recipe.steps), JSON.stringify(recipe.tips),
     recipe.source, recipe.sourceUrl, recipe.author]
  );
  
  res.json({ success: true });
});

app.delete('/api/recipes/:id', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const session = await validateSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  
  await pool.query('DELETE FROM saved_recipes WHERE id = $1 AND user_id = $2', [req.params.id, session.user_id]);
  res.json({ success: true });
});

// =============================================================================
// PAYMENTS
// =============================================================================
app.post('/api/payments/create-checkout', async (req, res) => {
  const { plan } = req.body;
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const session = await validateSession(token);
  if (!session) return res.status(401).json({ error: 'Login required' });
  
  const prices = { 
    basic: process.env.STRIPE_BASIC_PRICE_ID, 
    pro: process.env.STRIPE_PRO_PRICE_ID || process.env.STRIPE_UNLIMITED_PRICE_ID 
  };
  if (!prices[plan]) return res.status(400).json({ error: 'Invalid plan' });
  
  let stripeCustomerId = session.stripe_customer_id;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({ email: session.email });
    stripeCustomerId = customer.id;
    await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomerId, session.user_id]);
  }
  
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    line_items: [{ price: prices[plan], quantity: 1 }],
    mode: 'subscription',
    success_url: `${process.env.FRONTEND_URL}?success=true&plan=${plan}`,
    cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
    metadata: { userId: session.user_id.toString(), plan },
  });
  
  res.json({ url: checkoutSession.url });
});

app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  if (event.type === 'checkout.session.completed') {
    const { userId, plan } = event.data.object.metadata;
    await pool.query('UPDATE users SET subscription = $1, recipes_used_this_month = 0 WHERE id = $2', [plan, userId]);
    console.log(`✅ User ${userId} → ${plan}`);
  }
  
  if (event.type === 'customer.subscription.deleted') {
    const customerId = event.data.object.customer;
    await pool.query('UPDATE users SET subscription = NULL WHERE stripe_customer_id = $1', [customerId]);
  }
  
  res.json({ received: true });
});

app.get('/api/payments/plans', (req, res) => {
  res.json({
    free: { 
      name: 'Free', price: 0, 
      features: ['10 recipes to start', '3/month after signup', 'URL, photo & video', 'Cooking mode'] 
    },
    basic: { 
      name: 'Basic', price: 1.99, yearlyPrice: 14.99, recipes: 20,
      features: ['20 recipes/month', 'URL, photo & video', 'Cooking mode', 'Save recipes', 'Save 37% yearly'] 
    },
    pro: { 
      name: 'Pro', price: 4.99, yearlyPrice: 39.99, recipes: 'Unlimited',
      features: ['Unlimited recipes', 'URL, photo & video', 'Cooking mode', 'Save recipes', 'Support indie dev ❤️', 'Save 33% yearly'] 
    },
  });
});

// =============================================================================
// FEEDBACK & RATINGS
// =============================================================================
app.post('/api/feedback', async (req, res) => {
  const { message, type } = req.body;
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const session = await validateSession(token);
  
  await pool.query(
    'INSERT INTO feedback (user_id, email, message, type) VALUES ($1, $2, $3, $4)',
    [session?.user_id || null, session?.email || null, message, type || 'idea']
  );
  
  res.json({ success: true });
});

app.post('/api/rating', async (req, res) => {
  const { stars } = req.body;
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const session = await validateSession(token);
  const identifier = session?.user_id?.toString() || req.ip;
  
  await pool.query(
    `INSERT INTO ratings (user_id, identifier, stars) VALUES ($1, $2, $3)
     ON CONFLICT (identifier) DO UPDATE SET stars = $3, updated_at = NOW()`,
    [session?.user_id || null, identifier, stars]
  );
  
  res.json({ success: true });
});

app.get('/api/ratings/summary', async (req, res) => {
  const result = await pool.query('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings');
  const { avg, count } = result.rows[0];
  
  if (count < 5) return res.json({ average: 0, count: 0, display: null });
  
  res.json({
    average: parseFloat(avg),
    count: parseInt(count),
    display: { average: parseFloat(avg).toFixed(1), count: parseInt(count), text: `${parseFloat(avg).toFixed(1)} ★ from ${count} cooks` }
  });
});

// =============================================================================
// START
// =============================================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🍳 mise running on ${PORT}`);
});
