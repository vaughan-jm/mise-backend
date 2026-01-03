import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { LANGUAGE_INSTRUCTIONS } from '../config/index.js';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function fetchWebpage(url) {
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

export function extractRecipeSchema(html) {
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

export function convertSchemaToRecipe(schema, sourceUrl) {
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

export function validateAndFixRecipe(recipe) {
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

export async function enhanceRecipeWithDualUnits(recipe, targetLanguage = 'en') {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `Convert this recipe to have dual units. Return ONLY valid JSON.\n\nINPUT:\n${JSON.stringify(recipe)}\n\nRULES:\n- Dual units: "500g / 1.1 lb", "1 cup / 240ml", "400°F / 200°C"\n- Each step needs "ingredients" array with EXACT strings from main ingredients\n- ${LANGUAGE_INSTRUCTIONS[targetLanguage] || LANGUAGE_INSTRUCTIONS.en}\n- Return complete recipe JSON`
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

export async function fixRecipeIssues(recipe, issues, targetLanguage = 'en') {
  if (!issues.length) return recipe;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `Fix this recipe. Issues: ${issues.join(', ')}\n\nRECIPE:\n${JSON.stringify(recipe)}\n\nFIXES:\n${issues.includes('steps_too_long') ? '- Split long steps (max 300 chars each)' : ''}\n${issues.includes('too_few_steps') ? '- Break into more steps' : ''}\n\nRULES:\n- One action per step\n- Each step needs "ingredients" array\n- Dual units\n- ${LANGUAGE_INSTRUCTIONS[targetLanguage] || LANGUAGE_INSTRUCTIONS.en}\n- Return ONLY valid JSON`
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

export function stripHtml(html) {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 15000);
}

export async function extractRecipeFromUrl(url, targetLanguage = 'en') {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `Extract recipe from this webpage. Return ONLY valid JSON:\n{"title":"","servings":4,"prepTime":"","cookTime":"","imageUrl":null,"ingredients":["500g / 1.1 lb item"],"steps":[{"instruction":"","ingredients":[]}],"tips":[],"source":"","sourceUrl":"${url}","author":null}\n\nRULES:\n- Dual units always\n- Each step has ingredients array with EXACT strings from main ingredients\n- ${LANGUAGE_INSTRUCTIONS[targetLanguage] || LANGUAGE_INSTRUCTIONS.en}\n\nWEBPAGE:\n`
    }]
  });

  let text = response.content?.map(c => c.text || '').join('') || '';
  text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');

  return JSON.parse(match[0]);
}

export async function extractRecipeFromPhotos(photos, targetLanguage = 'en') {
  const photosToProcess = photos.slice(0, 4);
  const content = photosToProcess.map(p => {
    const m = p.match(/^data:(.+);base64,(.+)$/);
    return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null;
  }).filter(Boolean);

  content.push({
    type: 'text',
    text: `Extract the recipe from these photos. The images may contain:
- Printed cookbook pages
- Handwritten recipes (cursive or print)
- Recipe cards with notes
- Scribbled notes on paper or napkins
- Screenshots of recipes

CAREFULLY READ ALL TEXT including handwritten notes, annotations, and margin scribbles. Handwriting may be messy - do your best to interpret it.

Return ONLY valid JSON:
{"title":"Recipe name","servings":4,"prepTime":"15 min","cookTime":"30 min","imageUrl":null,"ingredients":["500g / 1.1 lb ingredient"],"steps":[{"instruction":"Step description","ingredients":["500g / 1.1 lb ingredient"]}],"tips":[],"source":"Cookbook","sourceUrl":null,"author":null}

RULES:
- If handwriting is unclear, make your best guess based on context (e.g. "1 tsp s___" is probably "1 tsp salt" or "1 tsp sugar")
- Convert vague amounts to standard measurements ("a handful" → "1/2 cup / 60g", "some" → "2 tbsp / 30ml")
- Dual units on ALL measurements: "500g / 1.1 lb", "1 cup / 240ml", "400°F / 200°C"
- Each step needs an "ingredients" array with EXACT strings from main ingredients
- Include any handwritten tips or notes in the "tips" array
- ${LANGUAGE_INSTRUCTIONS[targetLanguage] || LANGUAGE_INSTRUCTIONS.en}`
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content }]
  });

  let text = response.content?.map(c => c.text || '').join('') || '';
  text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');

  return JSON.parse(match[0]);
}

export async function extractRecipeFromYouTube(transcript, url, targetLanguage = 'en') {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `Extract recipe from this cooking video transcript. Return ONLY valid JSON:\n{"title":"","servings":4,"prepTime":"","cookTime":"","imageUrl":null,"ingredients":["500g / 1.1 lb item"],"steps":[{"instruction":"","ingredients":[]}],"tips":[],"source":"YouTube","sourceUrl":"${url}","author":null}\n\nRULES:\n- Estimate amounts if not stated\n- Dual units\n- Each step has ingredients array\n- ${LANGUAGE_INSTRUCTIONS[targetLanguage] || LANGUAGE_INSTRUCTIONS.en}\n\nTRANSCRIPT:\n${transcript.slice(0, 12000)}`
    }]
  });

  let text = response.content?.map(c => c.text || '').join('') || '';
  text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');

  return JSON.parse(match[0]);
}

export async function translateRecipe(recipe, targetLanguage) {
  const { LANGUAGE_NAMES } = await import('../config/index.js');
  const targetLangName = LANGUAGE_NAMES[targetLanguage] || 'English';

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `Translate this recipe to ${targetLangName}. Keep the same JSON structure, translate ALL text values (title, ingredients, instructions, tips). Keep JSON keys in English. Keep measurements with dual units. Return ONLY valid JSON, no explanation.

RECIPE:
${JSON.stringify(recipe)}

IMPORTANT:
- Translate title, all ingredients, all step instructions, all tips
- Keep source, sourceUrl, author unchanged
- Keep imageUrl unchanged
- Keep numeric values (servings, etc) unchanged
- Return complete valid JSON`
    }]
  });

  let text = response.content?.map(c => c.text || '').join('') || '';
  text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const match = text.match(/\{[\s\S]*\}/);

  if (!match) throw new Error('No valid JSON in response');

  const translatedRecipe = JSON.parse(match[0]);

  // Preserve fields that shouldn't change
  translatedRecipe.source = recipe.source;
  translatedRecipe.sourceUrl = recipe.sourceUrl;
  translatedRecipe.imageUrl = recipe.imageUrl;

  return translatedRecipe;
}

export async function getYouTubeTranscript(videoId) {
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

  return transcript;
}
