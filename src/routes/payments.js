import { Router } from 'express';
import Stripe from 'stripe';
import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { authenticateToken, requireAuth } from '../middleware/auth.js';
import pool from '../db/index.js';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Create checkout session
router.post('/create-checkout', authenticateToken, requireAuth, asyncHandler(async (req, res) => {
  const { plan } = req.body;

  const prices = {
    basic: process.env.STRIPE_BASIC_PRICE_ID,
    pro: process.env.STRIPE_PRO_PRICE_ID || process.env.STRIPE_UNLIMITED_PRICE_ID
  };
  if (!prices[plan]) return res.status(400).json({ error: 'Invalid plan' });

  let stripeCustomerId = req.user.stripe_customer_id;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({ email: req.user.email });
    stripeCustomerId = customer.id;
    await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomerId, req.user.user_id]);
  }

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    line_items: [{ price: prices[plan], quantity: 1 }],
    mode: 'subscription',
    success_url: `${process.env.FRONTEND_URL}?success=true&plan=${plan}`,
    cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
    metadata: { userId: req.user.user_id.toString(), plan },
  });

  res.json({ url: checkoutSession.url });
}));

// Stripe webhook - needs raw body
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const { userId, plan } = event.data.object.metadata;
      await pool.query('UPDATE users SET subscription = $1, recipes_used_this_month = 0 WHERE id = $2', [plan, userId]);
      console.log(`User ${userId} upgraded to ${plan}`);
    }

    if (event.type === 'customer.subscription.deleted') {
      const customerId = event.data.object.customer;
      await pool.query('UPDATE users SET subscription = NULL WHERE stripe_customer_id = $1', [customerId]);
      console.log(`Subscription canceled for customer ${customerId}`);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
});

// Get available plans
router.get('/plans', (req, res) => {
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
      features: ['Unlimited recipes', 'URL, photo & video', 'Cooking mode', 'Save recipes', 'Support indie dev', 'Save 33% yearly']
    },
  });
});

export default router;
