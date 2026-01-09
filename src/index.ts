import dotenv from 'dotenv';
dotenv.config();

import path from 'path';

import express from 'express';
import cors from 'cors';
import { x402Paywall } from 'x402plus';
import shopify from './config/shopify';
import prisma from './config/database';
import shopifyOrderService from './services/shopifyOrderService';


const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "https://nonintelligently-unaccounted-january.ngrok-free.dev";

// app.use(cors());
app.use(cors({
  origin: HOST,
  exposedHeaders: ["X-PAYMENT"]
}));
app.use(express.json());

// Add this after the express setup
// app.use(express.static('public'));
app.use(express.static(path.join(__dirname, '../public')));

// Health check
// app.get('/', (req, res) => {
//   res.send('Shopify x402 Payment Bridge - Running');
// });

// ============================================
// SHOPIFY OAUTH ROUTES
// ============================================

app.get('/api/auth', async (req, res) => {
  const shop = req.query.shop as string;

  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  try {
    await shopify.auth.begin({
      shop: shopify.utils.sanitizeShop(shop, true)!,
      callbackPath: '/api/auth/callback',
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/api/auth/callback', async (req, res) => {
  try {
    const callback = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const { session } = callback;

    // Store shop and access token in database
    await prisma.shop.upsert({
      where: { shopDomain: session.shop },
      update: {
        accessToken: session.accessToken!,
        scope: session.scope,
      },
      create: {
        shopDomain: session.shop,
        accessToken: session.accessToken!,
        scope: session.scope,
      },
    });

    // Redirect to app with shop parameter
    res.redirect(`/?shop=${session.shop}&host=${req.query.host}`);
  } catch (error) {
    console.error('Callback error:', error);
    res.status(500).send('Authentication callback failed');
  }
});



// ============================================
// MERCHANT CONFIGURATION ROUTES
// ============================================

app.get('/api/config', async (req, res) => {
  const shop = req.query.shop as string;

  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter' });
  }

  try {
    const shopData = await prisma.shop.findUnique({
      where: { shopDomain: shop },
      select: {
        walletAddress: true,
        acceptedToken: true,
        acceptedNetwork: true,
        isX402Enabled: true,
      },
    });

    if (!shopData) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    res.json(shopData);
  } catch (error) {
    console.error('Config fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

app.post('/api/config', async (req, res) => {
  const { shop, walletAddress, acceptedToken, acceptedNetwork, isX402Enabled } = req.body;

  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter' });
  }

  try {
    const updated = await prisma.shop.update({
      where: { shopDomain: shop },
      data: {
        walletAddress,
        acceptedToken,
        acceptedNetwork,
        isX402Enabled,
      },
    });

    res.json({
      success: true,
      config: {
        walletAddress: updated.walletAddress,
        acceptedToken: updated.acceptedToken,
        acceptedNetwork: updated.acceptedNetwork,
        isX402Enabled: updated.isX402Enabled,
      },
    });
  } catch (error) {
    console.error('Config update error:', error);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});


// ============================================
// SHOPIFY APP PROXY ROUTES (x402plus ONLY)
// ============================================

function getShopFromProxy(req: any): string | null {
  return req.query.shop as string || req.headers['x-shopify-shop-domain'] as string || null;
}

// Config and products routes (no x402 needed)
app.get('/shopify-proxy/api/config', async (req, res) => {
  const shop = req.query.shop as string || getShopFromProxy(req);
  if (!shop) return res.status(400).json({ error: 'Missing shop parameter' });

  try {
    const shopData = await prisma.shop.findUnique({
      where: { shopDomain: shop },
      select: { walletAddress: true, acceptedToken: true, acceptedNetwork: true, isX402Enabled: true },
    });

    if (!shopData) {
      return res.status(404).json({ error: 'Shop not found', success: false, enabled: false });
    }

    if (!shopData.isX402Enabled) {
      return res.status(400).json({ error: 'x402 not enabled', success: false, enabled: false });
    }

    res.json({ success: true, enabled: true, config: shopData });
  } catch (error: any) {
    res.status(500).json({ error: error.message, success: false, enabled: false });
  }
});

app.get('/shopify-proxy/api/products', async (req, res) => {
  const shop = req.query.shop as string || getShopFromProxy(req);
  if (!shop) return res.status(400).json({ error: 'Missing shop parameter' });

  try {
    const products = await shopifyOrderService.fetchProducts(shop);
    res.json({ success: true, products });
  } catch (error: any) {
    res.status(500).json({ error: error.message, success: false });
  }
});

// x402plus-protected checkout route
app.use(async (req, res, next) => {
  // Only apply x402 to checkout endpoint
  if (!req.path.includes('/shopify-proxy/api/checkout')) {
    return next();
  }

  const shop = req.query.shop as string || getShopFromProxy(req);
  if (!shop) return res.status(400).json({ error: 'Missing shop parameter' });

  try {
    const shopData = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopData || !shopData.isX402Enabled) {
      return res.status(400).json({ error: 'x402 not enabled' });
    }

    // Get product details from request body
    const { amount, productId, productTitle } = req.body;


    // Create x402plus middleware dynamically per shop
    const x402Middleware = x402Paywall(
      shopData.walletAddress!,
      {
        'POST /shopify-proxy/api/checkout': {
          network: shopData.acceptedNetwork!,
          asset: "0x1::aptos_coin::AptosCoin",
          maxAmountRequired: amount || '1000000',
          description: `Purchase: ${productTitle || 'Product'}`,
          mimeType: 'application/json',
          maxTimeoutSeconds: 600
        },
      },
      {
        url: process.env.FACILITATOR_URL || 'https://facilitator.stableyard.fi',
      }
    );


    // x402plus handles everything: 402 response OR verification OR calling next()
    x402Middleware(req, res, next);
  } catch (error: any) {
    console.error('x402 setup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// This handler ONLY runs if x402plus verification succeeds
app.post('/shopify-proxy/api/checkout', async (req, res) => {
  const shop = req.query.shop as string || getShopFromProxy(req);
  const { productId, productTitle, productPrice, amount, fromAddress, txHash } = req.body;

  console.log('Payment verified by x402plus! Creating order...');

  try {
    const shopData = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopData) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    // Store payment record
    const payment = await prisma.payment.create({
      data: {
        shopId: shopData.id,
        productId,
        productTitle: productTitle || 'Unknown Product',
        amount,
        txHash,
        fromAddress,
        toAddress: shopData.walletAddress!,
        tokenAddress: shopData.acceptedToken!,
        network: shopData.acceptedNetwork!,
        facilitatorStatus: 'verified',
        verificationData: { verified: true, facilitator: 'x402plus' } as any,
        status: 'completed',
      },
    });

    // Create Shopify order
    const order = await shopifyOrderService.createOrder({
      shop: shopData.shopDomain,
      productId,
      productTitle,
      productPrice: productPrice || amount,
      customerAddress: fromAddress,
      txHash,
      paymentAmount: amount,
    });

    res.json({
      success: true,
      verified: true,
      paymentId: payment.id,
      order: order,
    });
  } catch (error: any) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// // Index page
// app.get('/', async (req, res) => {
//   res.sendFile('index.html', { root: './public' });
// });

// // Storefront HTML page
// app.get('/shopify-proxy', async (req, res) => {
//   res.sendFile('x402-storefront.html', { root: './public' });
// });

app.get('/', async (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/shopify-proxy', async (req, res) => {
  res.sendFile(path.join(__dirname, '../public/x402-storefront.html'));
});


// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Shopify x402 Bridge running on port ${PORT}`);
  console.log(`📍 App URL: ${HOST}`);
});