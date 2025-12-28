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
// COST PROTECTION CONFIGURATION - ADJUST THESE TO YOUR COMFORT LEVEL
// =============================================================================
const COST_PROTECTION = {
  // Estimated cost per recipe (be conservative, estimate high)
  COST_PER_URL_RECIPE: 0.03,      // $0.03 per URL recipe
  COST_PER_PHOTO_RECIPE: 0.06,    // $0.06 per photo recipe
  
  // Spending limits
  DAILY_SPENDING_LIMIT: 10,       // Pause free tier if daily costs exceed $10
  MONTHLY_SPENDING_LIMIT: 100,    // Hard stop if monthly costs exceed $100
  
  // Free tier limits (can be adjusted dynamically)
  FREE_RECIPES_PER_MONTH: 3,
  MAX_FREE_USERS_PER_DAY: 100,    // Cap new free users per day
  
  // Alert thresholds (percentage of limits)
  ALERT_THRESHOLD: 0.7,           // Alert at 70% of limit
};

// Spending tracker (use Redis in production)
const spendingTracker = {
  today: { date: new Date().toDateString(), amount: 0, freeRecipes: 0, newFreeUsers: 0 },
  month: { month: new Date().toISOString().slice(0, 7), amount: 0 },
  paused: false,
  pauseReason: null,
};

// Reset daily tracker at midnight
function checkAndResetDaily() {
  const today = new Date().toDateString();
  if (spendingTracker.today.date !== today) {
    console.log(`📊 Yesterday's spending: $${spendingTracker.today.amount.toFixed(2)} | Free recipes: ${spendingTracker.today.freeRecipes}`);
    spendingTracker.today = { date: today, amount: 0, freeRecipes: 0, newFreeUsers: 0 };
    if (spendingTracker.pauseReason === 'daily_limit') {
      spendingTracker.paused = false;
      spendingTracker.pauseReason = null;
      console.log('✅ Daily limit reset - free tier re-enabled');
    }
  }
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (spendingTracker.month.month !== currentMonth) {
    console.log(`📊 Last month's total spending: $${spendingTracker.month.amount.toFixed(2)}`);
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
    console.log('⚠️ DAILY SPENDING LIMIT REACHED - Free tier paused');
  }
  
  if (spendingTracker.month.amount >= COST_PROTECTION.MONTHLY_SPENDING_LIMIT) {
    spendingTracker.paused = true;
    spendingTracker.pauseReason = 'monthly_limit';
    console.log('🛑 MONTHLY SPENDING LIMIT REACHED - Free tier paused');
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
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
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
// RECIPES
// =============================================================================
app.post('/api/recipe/clean-url', async (req, res) => {
  const { url } = req.body;
  const email = req.headers['x-user-email'];
  
  const user = email ? getUser(email) : getUser(`anon_${req.ip}`);
  if (!user) return res.status(503).json({ error: 'Service limited', upgrade: true, message: 'Upgrade for instant access!' });
  
  const canClean = canCleanRecipe(user);
  if (!canClean.allowed) {
    return res.status(402).json({ error: 'Limit reached', upgrade: true, message: 'Upgrade to continue!' });
  }
  
  const isFreeUser = !user.subscription;
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Find this recipe and return a cleaned version: ${url}

RESPOND WITH ONLY VALID JSON:
{"title":"Recipe name","servings":4,"prepTime":"15 min","cookTime":"30 min","imageUrl":"url or null","ingredients":["500g / 1.1 lb chicken"],"steps":[{"instruction":"Preheat oven to 400°F / 200°C.","ingredients":[]}],"tips":[],"source":"Website","sourceUrl":"${url}","author":null}

Dual units always. One action per step.`
      }]
    });

    let text = response.content?.map(c => c.text || '').join('') || '';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');
    
    const recipe = JSON.parse(jsonMatch[0]);
    if (!recipe.sourceUrl) recipe.sourceUrl = url;
    
    user.recipesUsedThisMonth++;
    trackSpending(COST_PROTECTION.COST_PER_URL_RECIPE, isFreeUser);
    
    res.json({ recipe, recipesRemaining: getRemainingRecipes(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clean recipe' });
  }
});

app.post('/api/recipe/clean-photo', async (req, res) => {
  const { photos } = req.body;
  const email = req.headers['x-user-email'];
  
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
      text: `Extract recipe. Return ONLY JSON: {"title":"","servings":4,"prepTime":"","cookTime":"","imageUrl":null,"ingredients":[],"steps":[{"instruction":"","ingredients":[]}],"tips":[],"source":"Cookbook","sourceUrl":null,"author":null}. Dual units.`
    });

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
    
    res.json({ recipe, recipesRemaining: getRemainingRecipes(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read recipe' });
  }
});

// =============================================================================
// PAYMENTS - Maximum conversion
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
  
  // Create checkout with ALL payment methods enabled
  const session = await stripe.checkout.sessions.create({
    customer: user.stripeCustomerId,
    line_items: [{ price: prices[plan], quantity: 1 }],
    mode: 'subscription',
    success_url: `${process.env.FRONTEND_URL}?success=true&plan=${plan}`,
    cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
    metadata: { email, plan },
    // FRICTION REDUCERS:
    billing_address_collection: 'auto',  // Only ask if needed
    allow_promotion_codes: true,          // Let users enter promo codes
    tax_id_collection: { enabled: false }, // Don't ask for tax ID
    // These enable Apple Pay, Google Pay, Link automatically in Stripe Dashboard
    // Enable in: Dashboard > Settings > Payment methods
    payment_method_types: ['card'],
    // For Link (one-click checkout):
    consent_collection: { terms_of_service: 'none' },
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
// FEEDBACK & RATINGS
// =============================================================================
const feedback = [];
const ratings = [];

app.post('/api/feedback', (req, res) => {
  const { message, type } = req.body; // type: 'idea' | 'bug' | 'other'
  const email = req.headers['x-user-email'] || null;
  
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
  
  const entry = {
    id: Date.now(),
    message: message.trim(),
    type: type || 'idea',
    email,
    createdAt: new Date().toISOString(),
    status: 'new', // 'new' | 'planned' | 'shipped'
    notified: false,
  };
  
  feedback.unshift(entry);
  console.log(`💬 New feedback from ${email || 'anonymous'}: ${message.slice(0, 50)}...`);
  
  res.json({ success: true, message: 'Thanks! We read every suggestion.' });
});

app.post('/api/rating', (req, res) => {
  const { stars } = req.body; // 1-5
  const email = req.headers['x-user-email'] || null;
  
  if (!stars || stars < 1 || stars > 5) return res.status(400).json({ error: 'Invalid rating' });
  
  // Check if user already rated (by email or IP)
  const identifier = email || req.ip;
  const existing = ratings.find(r => r.identifier === identifier);
  
  if (existing) {
    existing.stars = stars;
    existing.updatedAt = new Date().toISOString();
  } else {
    ratings.push({
      id: Date.now(),
      stars,
      identifier,
      email,
      createdAt: new Date().toISOString(),
    });
  }
  
  res.json({ success: true });
});

app.get('/api/ratings/summary', (req, res) => {
  if (ratings.length === 0) {
    return res.json({ average: 0, count: 0, display: null });
  }
  
  const sum = ratings.reduce((acc, r) => acc + r.stars, 0);
  const average = sum / ratings.length;
  const count = ratings.length;
  
  // Only show if we have enough ratings (social proof threshold)
  const display = count >= 5 ? {
    average: Math.round(average * 10) / 10,
    count,
    text: `${average.toFixed(1)} ★ from ${count} cooks`,
  } : null;
  
  res.json({ average, count, display });
});

// =============================================================================
// ADMIN
// =============================================================================

// Get all feedback
app.get('/api/admin/feedback', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  
  res.json({
    total: feedback.length,
    new: feedback.filter(f => f.status === 'new').length,
    planned: feedback.filter(f => f.status === 'planned').length,
    shipped: feedback.filter(f => f.status === 'shipped').length,
    items: feedback,
  });
});

// Update feedback status and optionally notify user
app.patch('/api/admin/feedback/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  
  const { status, notify } = req.body;
  const id = parseInt(req.params.id);
  const item = feedback.find(f => f.id === id);
  
  if (!item) return res.status(404).json({ error: 'Not found' });
  
  if (status) item.status = status;
  
  // Send notification email if requested and status is 'shipped'
  if (notify && status === 'shipped' && item.email && !item.notified) {
    // TODO: Implement email sending (see below for options)
    // For now, just mark as notified and log
    console.log(`📧 Would notify ${item.email}: Your suggestion is now live!`);
    console.log(`   Suggestion: "${item.message.slice(0, 100)}..."`);
    
    // Example with SendGrid (uncomment and configure):
    // await sendNotificationEmail(item.email, item.message);
    
    item.notified = true;
    item.notifiedAt = new Date().toISOString();
  }
  
  res.json({ success: true, item });
});

// Bulk notify all shipped but not notified
app.post('/api/admin/feedback/notify-shipped', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  
  const toNotify = feedback.filter(f => f.status === 'shipped' && f.email && !f.notified);
  
  for (const item of toNotify) {
    console.log(`📧 Notifying ${item.email} about shipped feature`);
    // await sendNotificationEmail(item.email, item.message);
    item.notified = true;
    item.notifiedAt = new Date().toISOString();
  }
  
  res.json({ success: true, notified: toNotify.length });
});

/*
// EMAIL NOTIFICATION SETUP
// Option 1: SendGrid (recommended, free tier available)
// npm install @sendgrid/mail

import sgMail from '@sendgrid/mail';
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendNotificationEmail(to, suggestion) {
  await sgMail.send({
    to,
    from: 'hello@mise.app',
    subject: '🎉 Your mise suggestion is now live!',
    text: `Hey! Remember when you suggested: "${suggestion.slice(0, 100)}..."? We just shipped it! Open mise to check it out. Thanks for making mise better! - The mise team`,
    html: `
      <p>Hey!</p>
      <p>Remember when you suggested:</p>
      <blockquote style="border-left: 3px solid #4ade80; padding-left: 12px; color: #666;">${suggestion.slice(0, 200)}...</blockquote>
      <p><strong>We just shipped it!</strong> 🚀</p>
      <p><a href="https://mise.app" style="color: #4ade80;">Open mise</a> to check it out.</p>
      <p>Thanks for making mise better!</p>
      <p>- The mise team</p>
    `,
  });
}
*/

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
