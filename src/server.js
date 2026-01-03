import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Import middleware
import { errorHandler } from './middleware/errorHandler.js';
import { apiRateLimiter } from './middleware/rateLimiter.js';

// Import routes
import authRoutes from './routes/auth.js';
import recipeRoutes from './routes/recipes.js';
import paymentRoutes from './routes/payments.js';
import feedbackRoutes from './routes/feedback.js';
import statusRoutes from './routes/status.js';

// Import services for initialization
import { initSpendingTable } from './services/spending.js';

// Initialize Express app
const app = express();

// =============================================================================
// MIDDLEWARE
// =============================================================================

// CORS configuration
app.use(cors({
  origin: true,
  credentials: true
}));

// JSON parsing with limit for photo uploads
app.use(express.json({ limit: '50mb' }));

// Apply general rate limiting to all routes
app.use(apiRateLimiter);

// =============================================================================
// ROUTES
// =============================================================================

// Status endpoint (no auth required)
app.use('/api/status', statusRoutes);

// Authentication routes
app.use('/api/auth', authRoutes);

// Recipe routes (handles both /api/recipe/* and /api/recipes/*)
app.use('/api/recipe', recipeRoutes);
app.use('/api/recipes', recipeRoutes);

// Payment routes
app.use('/api/payments', paymentRoutes);

// Feedback routes
app.use('/api/feedback', feedbackRoutes);
app.use('/api/rating', feedbackRoutes);  // Legacy path for rating endpoint
app.use('/api/ratings', feedbackRoutes); // Legacy path for ratings summary

// =============================================================================
// ERROR HANDLING
// =============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use(errorHandler);

// =============================================================================
// SERVER INITIALIZATION
// =============================================================================

const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    // Initialize database tables
    await initSpendingTable();
    console.log('Database tables initialized');

    // Start the server
    app.listen(PORT, () => {
      console.log(`mise running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
