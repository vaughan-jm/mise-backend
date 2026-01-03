// Application configuration
export const CONFIG = {
  COST_PER_URL_RECIPE: 0.03,
  COST_PER_PHOTO_RECIPE: 0.06,
  DAILY_SPENDING_LIMIT: 10,
  MONTHLY_SPENDING_LIMIT: 100,
  INITIAL_FREE_RECIPES: 10,
  FREE_RECIPES_PER_MONTH: 3,
  SESSION_DURATION_DAYS: 30,
  BASIC_RECIPES_PER_MONTH: 20,
};

export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'pt', 'zh', 'hi', 'ar'];

export const LANGUAGE_INSTRUCTIONS = {
  en: 'Output in English.',
  es: 'Output in Spanish.',
  fr: 'Output in French.',
  pt: 'Output in Portuguese.',
  zh: 'Output in Simplified Chinese.',
  hi: 'Output in Hindi.',
  ar: 'Output in Arabic. Keep JSON keys in English.',
};

export const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  pt: 'Portuguese (Português)',
  zh: 'Simplified Chinese (简体中文)',
  hi: 'Hindi (हिन्दी)',
  ar: 'Arabic (العربية)',
};
