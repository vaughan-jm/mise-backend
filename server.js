import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// =============================================================================
// COST PROTECTION CONFIGURATION
// =============================================================================
const COST_PROTECTION = {
  COST_PER_URL_RECIPE: 0.03,
  COST_PER_PHOTO_RECIPE: 0.06,
  DAILY_SPENDING_LIMIT: 10,
  MONTHLY_SPENDING_LIMIT: 100,
  FREE_RECIPES_PER_MONTH: 3,
  MAX_FREE_USERS_PER_DAY: 100,
  ALERT_THRESHOLD: 0.7,
};

const spendingTracker = {
  today: { date: new Date().toDateString(), amount: 0, freeRecipes: 0, newFreeUsers: 0 },
  month: { month: new Date().toISOString().slice(0, 7), amount: 0 },
  paused: false,
  pauseReason: null,
};

function checkAndResetDaily() {
  const today = new Date().toDateString();
  if (spendingTracker.today.date !== today) {
    console.log(`📊 Yesterday's spending: $${spendingTracker.today.amount.toFixed(2)} | Free recipes: ${spendingTracker.today.freeRecipes}`);
    spendingTracker.today = { date: today, amount: 0, freeRecipes: 0, newFreeUsers: 0 };
    if (spendingTracker.pauseReason === 'daily_limit') {
      spendingTracker.paused = false;
      spendingTracker.pauseReason = null;
    }
  }
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (spendingTracker.month.month !== currentMonth) {
    spendingTracker.month = { month: currentMonth, amount: 0 };
    if (spendingTracker.pauseReason === 'monthly_limit') {
      spendingTracker.paused = false;
      spendingTracker.pauseReason = null;
    }
  }
}

function trackSpending(amount, isFreeUser) {
  checkAndResetDaily();
  spendingTracker.today.amount += amount;
  spendingTracker.month.amount += amount;
  if (isFreeUser) spendingTracker.today.freeRecipes++;
  
  if (spendingTracker.today.amount >= COST_PROTECTION.DAILY_SPENDING_LIMIT) {
    spendingTracker.paused = true;
    spendingTracker.pauseReason = 'daily_limit';
  }
  if (spendingTracker.month.amount >= COST_PROTECTION.MONTHLY_SPENDING_LIMIT) {
    spendingTracker.paused = true;
    spendingTracker.pauseReason = 'monthly_limit';
  }
}

function canFreeUserProceed() {
  checkAndResetDaily();
  if (spendingTracker.paused) return { allowed: false, reason: spendingTracker.pauseReason };
  if (spendingTracker.today.newFreeUsers >= COST_PROTECTION.MAX_FREE_USERS_PER_DAY) {
    return { allowed: false, reason: 'max_free_users' };
  }
  return { allowed: true };
}

// =============================================================================
// DATABASE (Use PostgreSQL in production)
// =============================================================================
const users = new Map();
const savedRecipes = new Map();

function getUser(email) {
  if (!users.has(email)) {
    const freeCheck = canFreeUserProceed();
    if (!freeCheck.allowed && !email.startsWith('anon_')) return null;
    
    users.set(email, {
      email,
      recipesUsedThisMonth: 0,
      monthStarted: new Date().toISOString().slice(0, 7),
      subscription: null,
      stripeCustomerId: null,
    });
    if (!email.startsWith('anon_')) spendingTracker.today.newFreeUsers++;
  }
  
  const user = users.get(email);
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (user.monthStarted !== currentMonth) {
    user.recipesUsedThisMonth = 0;
    user.monthStarted = currentMonth;
  }
  return user;
}

function canCleanRecipe(user) {
  if (user.subscription === 'unlimited') return { allowed: true };
  if (user.subscription === 'basic') return { allowed: user.recipesUsedThisMonth < 30 };
  
  const freeCheck = canFreeUserProceed();
  if (!freeCheck.allowed) return { allowed: false, reason: freeCheck.reason };
  return { allowed: user.recipesUsedThisMonth < COST_PROTECTION.FREE_RECIPES_PER_MONTH };
}

function getRemainingRecipes(user) {
  if (user.subscription === 'unlimited') return Infinity;
  const limit = user.subscription === 'basic' ? 30 : COST_PROTECTION.FREE_RECIPES_PER_MONTH;
  return Math.max(0, limit - user.recipesUsedThisMonth);
}

// =============================================================================
// MIDDLEWARE
// =============================================================================
app.use(cors({ 
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    // Allow any origin for now (you can restrict this later)
    return callback(null, true);
  },
  credentials: true 
}));
app.use(express.json({ limit: '50mb' }));

// =============================================================================
// STATUS
// =============================================================================
app.get('/api/status', (req, res) => {
  checkAndResetDaily();
  res.json({
    status: spendingTracker.paused ? 'limited' : 'operational',
    pauseReason: spendingTracker.pauseReason,
  });
});

// =============================================================================
// AUTH
// =============================================================================
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (users.has(email)) return res.status(400).json({ error: 'Account already exists' });
  
  const user = getUser(email);
  if (!user) {
    return res.status(503).json({ 
      error: 'Free signups temporarily paused',
      upgrade: true,
      message: 'High demand! Upgrade for instant access.',
    });
  }
  user.password = password;
  res.json({ user: { email: user.email, subscription: user.subscription, recipesRemaining: getRemainingRecipes(user) } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!users.has(email)) return res.status(401).json({ error: 'Account not found' });
  const user = users.get(email);
  if (user.password !== password) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ user: { email: user.email, subscription: user.subscription, recipesRemaining: getRemainingRecipes(user) } });
});

app.get('/api/auth/me', async (req, res) => {
  const email = req.headers['x-user-email'];
  if (!email || !users.has(email)) return res.status(401).json({ error: 'Not authenticated' });
  const user = getUser(email);
  res.json({ user: { email: user.email, subscription: user.subscription, recipesRemaining: getRemainingRecipes(user) } });
});

// =============================================================================
// HELPER: Fetch webpage content
// =============================================================================
async function fetchWebpage(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    const html = await response.text();
    // Strip HTML tags and get text content (simple extraction)
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 15000); // Limit to ~15k chars to avoid token limits
    return text;
  } catch (err) {
    console.error('Failed to fetch webpage:', err);
    return null;
  }
}

// =============================================================================
// RECIPES
// =============================================================================
app.post('/api/recipe/clean-url', async (req, res) => {
  const { url } = req.body;
  const email = req.headers['x-user-email'];
  
  console.log(`📥 Recipe request for: ${url}`);
  
  const user = email ? getUser(email) : getUser(`anon_${req.ip}`);
  if (!user) return res.status(503).json({ error: 'Service limited', upgrade: true, message: 'Upgrade for instant access!' });
  
  const canClean = canCleanRecipe(user);
  if (!canClean.allowed) {
    return res.status(402).json({ error: 'Limit reached', upgrade: true, message: 'Upgrade to continue!' });
  }
  
  const isFreeUser = !user.subscription;
  
  try {
    // Fetch the webpage content first
    console.log('🌐 Fetching webpage...');
    const pageContent = await fetchWebpage(url);
    
    if (!pageContent) {
      return res.status(400).json({ error: 'Could not fetch recipe page. Please check the URL.' });
    }
    
    console.log('🤖 Calling Claude API...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `Extract the recipe from this webpage content and return a cleaned version.

WEBPAGE CONTENT:
${pageContent}

RESPOND WITH ONLY VALID JSON (no markdown, no backticks, no explanation):
{"title":"Recipe name","servings":4,"prepTime":"15 min","cookTime":"30 min","imageUrl":null,"ingredients":["500g / 1.1 lb ingredient","2 tbsp / 30ml oil"],"steps":[{"instruction":"Step description here.","ingredients":["relevant ingredient"]}],"tips":["optional tip"],"source":"Website name","sourceUrl":"${url}","author":"Author name or null"}

RULES:
- Every measurement MUST have dual units: "500g / 1.1 lb" or "1 cup / 240ml"
- Temperatures in both: "400°F / 200°C"
- Each step has "instruction" and "ingredients" array (ingredients used in that step)
- One clear action per step
- Extract tips if mentioned
- Return ONLY the JSON, nothing else`
      }]
    });

    console.log('✅ Claude responded');
    
    let text = response.content?.map(c => c.text || '').join('') || '';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('No JSON found in response:', text.slice(0, 200));
      throw new Error('No JSON found in response');
    }
    
    const recipe = JSON.parse(jsonMatch[0]);
    if (!recipe.sourceUrl) recipe.sourceUrl = url;
    
    user.recipesUsedThisMonth++;
    trackSpending(COST_PROTECTION.COST_PER_URL_RECIPE, isFreeUser);
    
    console.log(`✅ Recipe cleaned: ${recipe.title}`);
    res.json({ recipe, recipesRemaining: getRemainingRecipes(user) });
  } catch (err) {
    console.error('Recipe clean error:', err);
    res.status(500).json({ error: 'Failed to clean recipe. Please try again.' });
  }
});

app.post('/api/recipe/clean-photo', async (req, res) => {
  const { photos } = req.body;
  const email = req.headers['x-user-email'];
  
  console.log(`📷 Photo recipe request with ${photos?.length || 0} photos`);
  
  const user = email ? getUser(email) : getUser(`anon_${req.ip}`);
  if (!user) return res.status(503).json({ error: 'Service limited', upgrade: true });
  
  const canClean = canCleanRecipe(user);
  if (!canClean.allowed) return res.status(402).json({ error: 'Limit reached', upgrade: true });
  
  const isFreeUser = !user.subscription;
  
  try {
    const content = photos.map(photo => {
      const matches = photo.match(/^data:(.+);base64,(.+)$/);
      return matches ? { type: 'image', source: { type: 'base64', media_type: matches[1], data: matches[2] } } : null;
    }).filter(Boolean);
    
    content.push({
      type: 'text',
      text: `Extract the recipe from these cookbook photos.

RESPOND WITH ONLY VALID JSON (no markdown, no backticks):
{"title":"Recipe name","servings":4,"prepTime":"15 min","cookTime":"30 min","imageUrl":null,"ingredients":["500g / 1.1 lb ingredient"],"steps":[{"instruction":"Step text","ingredients":[]}],"tips":[],"source":"Cookbook name or 'Cookbook'","sourceUrl":null,"author":"Author or null"}

RULES:
- Dual units always: "500g / 1.1 lb", "1 cup / 240ml", "400°F / 200°C"
- One action per step
- Return ONLY the JSON`
    });

    console.log('🤖 Calling Claude API for photos...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      messages: [{ role: 'user', content }]
    });

    let text = response.content?.map(c => c.text || '').join('') || '';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');
    
    const recipe = JSON.parse(jsonMatch[0]);
    user.recipesUsedThisMonth++;
    trackSpending(COST_PROTECTION.COST_PER_PHOTO_RECIPE, isFreeUser);
    
    console.log(`✅ Photo recipe cleaned: ${recipe.title}`);
    res.json({ recipe, recipesRemaining: getRemainingRecipes(user) });
  } catch (err) {
    console.error('Photo clean error:', err);
    res.status(500).json({ error: 'Failed to read recipe from photos' });
  }
});

// =============================================================================
// PAYMENTS
// =============================================================================
app.post('/api/payments/create-checkout', async (req, res) => {
  const { plan, email } = req.body;
  
  const prices = { basic: process.env.STRIPE_BASIC_PRICE_ID, unlimited: process.env.STRIPE_UNLIMITED_PRICE_ID };
  if (!prices[plan]) return res.status(400).json({ error: 'Invalid plan' });
  
  let user = users.get(email);
  if (!user) {
    user = { email, stripeCustomerId: null, recipesUsedThisMonth: 0, monthStarted: new Date().toISOString().slice(0, 7), subscription: null };
    users.set(email, user);
  }
  
  if (!user.stripeCustomerId) {
    const customer = await stripe.customers.create({ email });
    user.stripeCustomerId = customer.id;
  }
  
  const session = await stripe.checkout.sessions.create({
    customer: user.stripeCustomerId,
    line_items: [{ price: prices[plan], quantity: 1 }],
    mode: 'subscription',
    success_url: `${process.env.FRONTEND_URL}?success=true&plan=${plan}`,
    cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
    metadata: { email, plan },
    billing_address_collection: 'auto',
    allow_promotion_codes: true,
    payment_method_types: ['card'],
  });

  res.json({ url: session.url });
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
    const { email, plan } = event.data.object.metadata;
    const user = getUser(email);
    if (user) {
      user.subscription = plan;
      user.recipesUsedThisMonth = 0;
      console.log(`✅ ${email} → ${plan}`);
    }
  }
  
  if (event.type === 'customer.subscription.deleted') {
    const customer = await stripe.customers.retrieve(event.data.object.customer);
    const user = users.get(customer.email);
    if (user) user.subscription = null;
  }

  res.json({ received: true });
});

app.get('/api/payments/plans', (req, res) => {
  res.json({
    free: { name: 'Free', price: 0, recipes: COST_PROTECTION.FREE_RECIPES_PER_MONTH, features: [`${COST_PROTECTION.FREE_RECIPES_PER_MONTH} recipes/month`, 'URL & photo', 'Cooking mode'] },
    basic: { name: 'Basic', price: 2.99, recipes: 30, features: ['30 recipes/month', 'URL & photo', 'Cooking mode', 'Save recipes'] },
    unlimited: { name: 'Unlimited', price: 5.99, recipes: 'Unlimited', features: ['Unlimited recipes', 'URL & photo', 'Cooking mode', 'Save recipes', 'Support indie dev ❤️'] },
  });
});

app.post('/api/payments/portal', async (req, res) => {
  const email = req.headers['x-user-email'];
  const user = users.get(email);
  if (!user?.stripeCustomerId) return res.status(400).json({ error: 'No subscription' });
  const session = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: process.env.FRONTEND_URL });
  res.json({ url: session.url });
});

// =============================================================================
// FEEDBACK & RATINGS
// =============================================================================
const feedback = [];
const ratings = [];

app.post('/api/feedback', (req, res) => {
  const { message, type } = req.body;
  const email = req.headers['x-user-email'] || null;
  
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
  
  feedback.unshift({
    id: Date.now(),
    message: message.trim(),
    type: type || 'idea',
    email,
    createdAt: new Date().toISOString(),
    status: 'new',
    notified: false,
  });
  
  console.log(`💬 Feedback from ${email || 'anonymous'}: ${message.slice(0, 50)}...`);
  res.json({ success: true, message: 'Thanks! We read every suggestion.' });
});

app.post('/api/rating', (req, res) => {
  const { stars } = req.body;
  const email = req.headers['x-user-email'] || null;
  
  if (!stars || stars < 1 || stars > 5) return res.status(400).json({ error: 'Invalid rating' });
  
  const identifier = email || req.ip;
  const existing = ratings.find(r => r.identifier === identifier);
  
  if (existing) {
    existing.stars = stars;
    existing.updatedAt = new Date().toISOString();
  } else {
    ratings.push({ id: Date.now(), stars, identifier, email, createdAt: new Date().toISOString() });
  }
  
  res.json({ success: true });
});

app.get('/api/ratings/summary', (req, res) => {
  if (ratings.length === 0) return res.json({ average: 0, count: 0, display: null });
  
  const sum = ratings.reduce((acc, r) => acc + r.stars, 0);
  const average = sum / ratings.length;
  const count = ratings.length;
  
  const display = count >= 5 ? {
    average: Math.round(average * 10) / 10,
    count,
    text: `${average.toFixed(1)} ★ from ${count} cooks`,
  } : null;
  
  res.json({ average, count, display });
});

// =============================================================================
// SAVED RECIPES
// =============================================================================
app.get('/api/recipes/saved', (req, res) => {
  const email = req.headers['x-user-email'];
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ recipes: savedRecipes.get(email) || [] });
});

app.post('/api/recipes/save', (req, res) => {
  const email = req.headers['x-user-email'];
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const userRecipes = savedRecipes.get(email) || [];
  userRecipes.unshift({ ...req.body.recipe, id: Date.now(), savedAt: Date.now() });
  savedRecipes.set(email, userRecipes);
  res.json({ success: true });
});

app.delete('/api/recipes/:id', (req, res) => {
  const email = req.headers['x-user-email'];
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const userRecipes = savedRecipes.get(email) || [];
  savedRecipes.set(email, userRecipes.filter(r => r.id !== parseInt(req.params.id)));
  res.json({ success: true });
});

// =============================================================================
// ADMIN
// =============================================================================
app.get('/api/admin/feedback', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ total: feedback.length, new: feedback.filter(f => f.status === 'new').length, items: feedback });
});

app.get('/api/admin/stats', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  
  const paidUsers = Array.from(users.values()).filter(u => u.subscription).length;
  const basicUsers = Array.from(users.values()).filter(u => u.subscription === 'basic').length;
  const unlimitedUsers = Array.from(users.values()).filter(u => u.subscription === 'unlimited').length;
  
  res.json({
    users: { total: users.size, paid: paidUsers, basic: basicUsers, unlimited: unlimitedUsers },
    spending: spendingTracker,
    mrr: (basicUsers * 2.99) + (unlimitedUsers * 5.99),
    limits: COST_PROTECTION,
  });
});

app.post('/api/admin/limits', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { dailyLimit, monthlyLimit, freeRecipes, pause } = req.body;
  if (dailyLimit !== undefined) COST_PROTECTION.DAILY_SPENDING_LIMIT = dailyLimit;
  if (monthlyLimit !== undefined) COST_PROTECTION.MONTHLY_SPENDING_LIMIT = monthlyLimit;
  if (freeRecipes !== undefined) COST_PROTECTION.FREE_RECIPES_PER_MONTH = freeRecipes;
  if (pause !== undefined) { spendingTracker.paused = pause; spendingTracker.pauseReason = pause ? 'manual' : null; }
  res.json({ success: true, limits: COST_PROTECTION, paused: spendingTracker.paused });
});

// =============================================================================
// START
// =============================================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🍳 mise running on ${PORT} | Daily limit: $${COST_PROTECTION.DAILY_SPENDING_LIMIT} | Monthly: $${COST_PROTECTION.MONTHLY_SPENDING_LIMIT}`);
});
