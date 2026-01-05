import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import shopify from './config/shopify';
import prisma from './config/database';
import x402Service from './services/x402Service';
import shopifyOrderService from './services/shopifyOrderService';


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Add this after the express setup
app.use(express.static('public'));

// Health check
app.get('/', (req, res) => {
  res.send('Shopify x402 Payment Bridge - Running');
});

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
// SHOPIFY APP PROXY ROUTES
// ============================================

// Helper function to extract shop from Shopify proxy request
function getShopFromProxy(req: any): string | null {
  // Shopify sends shop in the query string with the key 'shop'
  // But it's in the format: ?shop=testnow-4.myshopify.com&other_params

  // First try query parameter
  if (req.query.shop) {
    return req.query.shop as string;
  }

  // Try path_prefix which Shopify includes
  if (req.query.path_prefix) {
    // Extract shop from path like /apps/x402-checkout
    // We need to get it from the request itself
    const shopifyShop = req.headers['x-shopify-shop-domain'];
    if (shopifyShop) {
      return shopifyShop as string;
    }
  }

  // Check if it's in the logged_in_customer_id format
  const timestamp = req.query.timestamp;
  if (timestamp) {
    // This is a Shopify proxy request
    // Extract from signature verification
    const shopDomain = req.query.shop || req.headers['x-shopify-shop-domain'];
    return shopDomain as string;
  }

  return null;
}


// ============================================
// SHOPIFY APP PROXY ROUTES
// ============================================


/// IMPORTANT: API routes MUST come before the HTML route

// Proxy API - Get shop config
app.get('/shopify-proxy/api/config', async (req, res) => {
  const shop = req.query.shop as string || getShopFromProxy(req);

  console.log('Config request for shop:', shop);
  console.log('Query params:', req.query);
  console.log('Headers:', req.headers['x-shopify-shop-domain']);

  if (!shop) {
    console.error('No shop parameter found');
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
      console.error('Shop not found in database:', shop);
      return res.status(404).json({
        error: 'Shop not found. Please install and configure the app first.',
        success: false,
        enabled: false
      });
    }

    if (!shopData.isX402Enabled) {
      console.log('x402 not enabled for shop:', shop);
      return res.status(400).json({
        error: 'x402 payments not enabled. Please enable in app settings.',
        success: false,
        enabled: false
      });
    }

    console.log('Config found for shop:', shop);
    res.json({
      success: true,
      enabled: true,
      config: shopData,
    });
  } catch (error: any) {
    console.error('Proxy config error:', error);
    res.status(500).json({
      error: error.message,
      success: false,
      enabled: false
    });
  }
});

// Proxy API - Get products
app.get('/shopify-proxy/api/products', async (req, res) => {
  const shop = req.query.shop as string || getShopFromProxy(req);

  console.log('Products request for shop:', shop);

  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter', success: false });
  }

  try {
    const products = await shopifyOrderService.fetchProducts(shop);
    console.log(`Found ${products.length} products for shop:`, shop);
    res.json({ success: true, products });
  } catch (error: any) {
    console.error('Proxy products error:', error);
    res.status(500).json({ error: error.message, success: false });
  }
});

// Proxy API - Get single product
app.get('/shopify-proxy/api/products/:productId', async (req, res) => {
  const shop = req.query.shop as string || getShopFromProxy(req);
  const { productId } = req.params;

  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter', success: false });
  }

  try {
    const product = await shopifyOrderService.getProduct(shop, productId);
    res.json({ success: true, product });
  } catch (error: any) {
    console.error('Proxy product error:', error);
    res.status(500).json({ error: error.message, success: false });
  }
});

// Proxy API - Create payment request
app.post('/shopify-proxy/api/payment/request', async (req, res) => {
  const shop = req.query.shop as string || getShopFromProxy(req);
  const { productId, productTitle, amount } = req.body;

  console.log('Payment request for shop:', shop);

  if (!shop || !productId || !amount) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const shopData = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopData || !shopData.isX402Enabled) {
      return res.status(400).json({ error: 'x402 payments not enabled' });
    }

    const paymentRequest = x402Service.generatePaymentRequest(
      shopData.walletAddress!,
      shopData.acceptedToken!,
      amount,
      shopData.acceptedNetwork!,
      productId,
      productTitle
    );

    res.json(paymentRequest);
  } catch (error: any) {
    console.error('Proxy payment request error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Proxy API - Verify payment and create order
app.post('/shopify-proxy/api/payment/verify', async (req, res) => {
  const shop = req.query.shop as string || getShopFromProxy(req);
  const {
    txHash,
    fromAddress,
    amount,
    productId,
    productTitle,
    productPrice
  } = req.body;

  console.log('Payment verification for shop:', shop);

  if (!shop || !txHash || !fromAddress || !amount) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const shopData = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopData) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    // Verify payment using x402 v2 facilitator
    const verification = await x402Service.verifyPayment({
      txHash,
      network: shopData.acceptedNetwork!,
      fromAddress,
      toAddress: shopData.walletAddress!,
      tokenAddress: shopData.acceptedToken!,
      amount,
    });

    if (!verification.verified) {
      return res.status(400).json({
        error: 'Payment verification failed',
        verified: false
      });
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
        verificationData: verification as any,
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
      verified: true,
      paymentId: payment.id,
      order: order,
      transaction: verification.transaction,
    });
  } catch (error: any) {
    console.error('Proxy payment verification error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Main proxy handler - serves the x402 checkout page
// THIS MUST BE LAST - it's a catch-all route
app.get('/shopify-proxy', async (req, res) => {
  console.log('Proxy HTML request received');
  console.log('Query:', req.query);
  console.log('Headers:', req.headers['x-shopify-shop-domain']);

  const shop = req.query.shop as string || getShopFromProxy(req);

  if (!shop) {
    console.error('No shop found in proxy HTML request');
  } else {
    console.log('Serving storefront HTML for shop:', shop);
  }

  // Serve the x402 checkout page
  res.sendFile('x402-storefront.html', { root: './public' });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Shopify x402 Bridge running on port ${PORT}`);
  console.log(`📍 App URL: ${process.env.HOST}`);
});