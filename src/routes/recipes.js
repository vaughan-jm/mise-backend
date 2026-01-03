import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { authenticateToken, requirePaidSubscription } from '../middleware/auth.js';
import { recipeRateLimiter } from '../middleware/rateLimiter.js';
import { resetMonthlyUsageIfNeeded } from '../services/auth.js';
import {
  canCleanRecipe,
  incrementAnonymousUsage,
  incrementUserUsage,
  getRemainingRecipes
} from '../services/usage.js';
import { trackSpending } from '../services/spending.js';
import {
  fetchWebpage,
  extractRecipeSchema,
  convertSchemaToRecipe,
  validateAndFixRecipe,
  enhanceRecipeWithDualUnits,
  fixRecipeIssues,
  stripHtml,
  extractRecipeFromPhotos,
  getYouTubeTranscript,
  extractRecipeFromYouTube,
  translateRecipe
} from '../services/recipes.js';
import { CONFIG, SUPPORTED_LANGUAGES, LANGUAGE_INSTRUCTIONS } from '../config/index.js';
import pool from '../db/index.js';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Apply auth middleware to all routes
router.use(authenticateToken);

// Clean recipe from URL
router.post('/clean-url', recipeRateLimiter, asyncHandler(async (req, res) => {
  const { url, language, fingerprint } = req.body;
  const targetLanguage = SUPPORTED_LANGUAGES.includes(language) ? language : 'en';
  const ip = req.ip || req.headers['x-forwarded-for'];

  const user = req.user ? await resetMonthlyUsageIfNeeded(req.user) : null;

  const canClean = await canCleanRecipe(user, fingerprint, ip);
  if (!canClean.allowed) {
    return res.status(402).json({
      error: canClean.reason,
      requiresSignup: canClean.requiresSignup,
      upgrade: canClean.upgrade,
      message: canClean.message || 'Upgrade for more recipes!'
    });
  }

  console.log(`Recipe request for: ${url}`);
  const html = await fetchWebpage(url);
  if (!html) return res.status(400).json({ error: 'Could not fetch recipe page.' });

  const schema = extractRecipeSchema(html);
  let recipe;

  if (schema) {
    console.log('Fast path - using schema');
    recipe = convertSchemaToRecipe(schema, url);
    const { recipe: validated, issues } = validateAndFixRecipe(recipe);
    recipe = validated;
    if (issues.length) recipe = await fixRecipeIssues(recipe, issues, targetLanguage);
    recipe = await enhanceRecipeWithDualUnits(recipe, targetLanguage);
    await trackSpending(CONFIG.COST_PER_URL_RECIPE * 0.5);
  } else {
    console.log('Slow path - using AI extraction');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `Extract recipe from this webpage. Return ONLY valid JSON:\n{"title":"","servings":4,"prepTime":"","cookTime":"","imageUrl":null,"ingredients":["500g / 1.1 lb item"],"steps":[{"instruction":"","ingredients":[]}],"tips":[],"source":"","sourceUrl":"${url}","author":null}\n\nRULES:\n- Dual units always\n- Each step has ingredients array with EXACT strings from main ingredients\n- ${LANGUAGE_INSTRUCTIONS[targetLanguage] || LANGUAGE_INSTRUCTIONS.en}\n\nWEBPAGE:\n${stripHtml(html)}`
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
    await trackSpending(CONFIG.COST_PER_URL_RECIPE);
  }

  // Track usage
  if (user) {
    await incrementUserUsage(user.id);
  } else if (fingerprint) {
    await incrementAnonymousUsage(fingerprint);
  }

  const remaining = user ? getRemainingRecipes({ ...user, recipes_used_this_month: user.recipes_used_this_month + 1 })
                        : Math.max(0, (canClean.remaining || 0) - 1);

  console.log(`Recipe extracted: ${recipe.title}`);
  res.json({ recipe, recipesRemaining: remaining });
}));

// Clean recipe from photos
router.post('/clean-photo', recipeRateLimiter, asyncHandler(async (req, res) => {
  const { photos, language, fingerprint } = req.body;
  const targetLanguage = SUPPORTED_LANGUAGES.includes(language) ? language : 'en';
  const ip = req.ip || req.headers['x-forwarded-for'];

  const user = req.user ? await resetMonthlyUsageIfNeeded(req.user) : null;

  const canClean = await canCleanRecipe(user, fingerprint, ip);
  if (!canClean.allowed) {
    return res.status(402).json({
      error: canClean.reason,
      requiresSignup: canClean.requiresSignup,
      upgrade: canClean.upgrade,
      message: canClean.message || 'Upgrade for more recipes!'
    });
  }

  let recipe = await extractRecipeFromPhotos(photos, targetLanguage);
  const { recipe: validated, issues } = validateAndFixRecipe(recipe);
  recipe = validated;
  if (issues.length) recipe = await fixRecipeIssues(recipe, issues, targetLanguage);

  await trackSpending(CONFIG.COST_PER_PHOTO_RECIPE);

  if (user) await incrementUserUsage(user.id);
  else if (fingerprint) await incrementAnonymousUsage(fingerprint);

  const remaining = user ? getRemainingRecipes({ ...user, recipes_used_this_month: user.recipes_used_this_month + 1 })
                        : Math.max(0, (canClean.remaining || 0) - 1);

  res.json({ recipe, recipesRemaining: remaining });
}));

// Clean recipe from YouTube
router.post('/clean-youtube', recipeRateLimiter, asyncHandler(async (req, res) => {
  const { url, language, fingerprint } = req.body;
  const targetLanguage = SUPPORTED_LANGUAGES.includes(language) ? language : 'en';
  const ip = req.ip || req.headers['x-forwarded-for'];

  const user = req.user ? await resetMonthlyUsageIfNeeded(req.user) : null;

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

  const transcript = await getYouTubeTranscript(videoId);

  if (!transcript || transcript.length < 50) {
    return res.status(400).json({ error: 'Could not extract transcript. Video may not have captions.' });
  }

  let recipe = await extractRecipeFromYouTube(transcript, url, targetLanguage);
  recipe.sourceUrl = url;
  const { recipe: validated, issues } = validateAndFixRecipe(recipe);
  recipe = validated;
  if (issues.length) recipe = await fixRecipeIssues(recipe, issues, targetLanguage);

  await trackSpending(CONFIG.COST_PER_URL_RECIPE * 1.5);

  if (user) await incrementUserUsage(user.id);
  else if (fingerprint) await incrementAnonymousUsage(fingerprint);

  const remaining = user ? getRemainingRecipes({ ...user, recipes_used_this_month: user.recipes_used_this_month + 1 })
                        : Math.max(0, (canClean.remaining || 0) - 1);

  res.json({ recipe, recipesRemaining: remaining });
}));

// Translate recipe (paid users only)
router.post('/translate', requirePaidSubscription, asyncHandler(async (req, res) => {
  const { recipe, targetLanguage } = req.body;

  console.log(`Translating recipe to ${targetLanguage}`);

  const translatedRecipe = await translateRecipe(recipe, targetLanguage);

  await trackSpending(0.01);

  console.log(`Recipe translated`);
  res.json({ recipe: translatedRecipe });
}));

// Get saved recipes
router.get('/saved', asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  const result = await pool.query(
    'SELECT * FROM saved_recipes WHERE user_id = $1 ORDER BY saved_at DESC',
    [req.user.user_id]
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
}));

// Save a recipe
router.post('/save', asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  const { recipe } = req.body;

  await pool.query(
    `INSERT INTO saved_recipes (user_id, title, servings, prep_time, cook_time, image_url, ingredients, steps, tips, source, source_url, author)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [req.user.user_id, recipe.title, recipe.servings, recipe.prepTime, recipe.cookTime, recipe.imageUrl,
     JSON.stringify(recipe.ingredients), JSON.stringify(recipe.steps), JSON.stringify(recipe.tips),
     recipe.source, recipe.sourceUrl, recipe.author]
  );

  res.json({ success: true });
}));

// Delete a saved recipe
router.delete('/:id', asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  await pool.query('DELETE FROM saved_recipes WHERE id = $1 AND user_id = $2', [req.params.id, req.user.user_id]);
  res.json({ success: true });
}));

export default router;
