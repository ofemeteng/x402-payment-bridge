import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import shopify from './config/shopify';
import prisma from './config/database';
import x402Service from './services/x402Service';


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
// PAYMENT ROUTES (x402 v2)
// ============================================

app.post('/api/payment/request', async (req, res) => {
  const { shop, productId, productTitle, amount } = req.body;

  if (!shop || !productId || !amount) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const shopData = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopData || !shopData.isX402Enabled) {
      return res.status(400).json({ error: 'x402 payments not enabled for this shop' });
    }

    if (!shopData.walletAddress || !shopData.acceptedToken || !shopData.acceptedNetwork) {
      return res.status(400).json({ error: 'Shop payment configuration incomplete' });
    }

    const paymentRequest = x402Service.generatePaymentRequest(
      shopData.walletAddress,
      shopData.acceptedToken,
      amount,
      shopData.acceptedNetwork,
      productId,
      productTitle
    );

    res.json(paymentRequest);
  } catch (error) {
    console.error('Payment request error:', error);
    res.status(500).json({ error: 'Failed to generate payment request' });
  }
});

app.post('/api/payment/verify', async (req, res) => {
  const { shop, txHash, fromAddress, amount, productId, productTitle } = req.body;

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
        facilitatorStatus: verification.verified ? 'verified' : 'failed',
        verificationData: verification as any,
        status: verification.verified ? 'completed' : 'failed',
      },
    });

    res.json({
      verified: verification.verified,
      paymentId: payment.id,
      status: payment.status,
      transaction: verification.transaction,
    });
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

app.get('/api/payments', async (req, res) => {
  const shop = req.query.shop as string;

  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter' });
  }

  try {
    const shopData = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopData) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const payments = await prisma.payment.findMany({
      where: { shopId: shopData.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({ payments });
  } catch (error) {
    console.error('Payments fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// ============================================
// SHOPIFY PRODUCT INTEGRATION
// ============================================

// app.get('/api/shopify/products', async (req, res) => {
//   const shop = req.query.shop as string;

//   if (!shop) {
//     return res.status(400).json({ error: 'Missing shop parameter' });
//   }

//   try {
//     const shopData = await prisma.shop.findUnique({
//       where: { shopDomain: shop },
//     });

//     if (!shopData) {
//       return res.status(404).json({ error: 'Shop not found' });
//     }

//     // Create proper Shopify session
//     const session = shopify.session.customAppSession(shopData.shopDomain);
//     session.accessToken = shopData.accessToken;

//     // Create Shopify REST client
//     const client = new shopify.clients.Rest({ session });

//     // Fetch products
//     const response = await client.get({
//       path: 'products',
//       query: { limit: '10' },
//     });

//     const products = (response.body as any).products.map((product: any) => ({
//       id: product.id,
//       title: product.title,
//       price: product.variants[0]?.price || '0',
//       image: product.images[0]?.src || null,
//     }));

//     res.json({ products });
//   } catch (error: any) {
//     console.error('Shopify products fetch error:', error);
//     res.status(500).json({ error: 'Failed to fetch products' });
//   }
// });

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Shopify x402 Bridge running on port ${PORT}`);
  console.log(`📍 App URL: ${process.env.HOST}`);
});