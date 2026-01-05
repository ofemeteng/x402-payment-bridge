import shopify from '../config/shopify';
import prisma from '../config/database';

interface CreateOrderParams {
  shop: string;
  productId: string;
  productTitle: string;
  productPrice: string;
  customerAddress: string;
  txHash: string;
  paymentAmount: string;
}

export class ShopifyOrderService {
  /**
   * Create a Shopify order after successful x402 payment
   */
  async createOrder(params: CreateOrderParams) {
    const {
      shop,
      productId,
      productTitle,
      productPrice,
      customerAddress,
      txHash,
      paymentAmount,
    } = params;

    try {
      const shopData = await prisma.shop.findUnique({
        where: { shopDomain: shop },
      });

      if (!shopData) {
        throw new Error('Shop not found');
      }

      // Create session for API calls
      const session = shopify.session.customAppSession(shopData.shopDomain);
      session.accessToken = shopData.accessToken;

      const client = new shopify.clients.Rest({ session });

      // Create order in Shopify
      const orderResponse = await client.post({
        path: 'orders',
        data: {
          order: {
            line_items: [
              {
                title: productTitle,
                price: productPrice,
                quantity: 1,
              },
            ],
            customer: {
              email: `${customerAddress.slice(0, 10)}@x402.crypto`,
            },
            financial_status: 'paid',
            transactions: [
              {
                kind: 'sale',
                status: 'success',
                amount: productPrice,
                gateway: 'x402 v2 Protocol',
              },
            ],
            note: `Paid via x402 v2 Protocol\nTransaction: ${txHash}\nWallet: ${customerAddress}`,
            tags: 'x402, crypto, web3',
            source_name: 'x402-payment-bridge',
          },
        },
        // type: shopify.clients.DataType.JSON,
      });

      const order = (orderResponse.body as any).order;

      return {
        success: true,
        orderId: order.id,
        orderNumber: order.order_number,
        orderName: order.name,
        totalPrice: order.total_price,
        createdAt: order.created_at,
      };
    } catch (error: any) {
      console.error('Shopify order creation error:', error);
      throw new Error(`Failed to create order: ${error.message}`);
    }
  }

  /**
   * Fetch products from Shopify store
   */
  async fetchProducts(shop: string, limit: number = 20) {
    try {
      const shopData = await prisma.shop.findUnique({
        where: { shopDomain: shop },
      });

      if (!shopData) {
        throw new Error('Shop not found');
      }

      const session = shopify.session.customAppSession(shopData.shopDomain);
      session.accessToken = shopData.accessToken;

      const client = new shopify.clients.Rest({ session });

      const response = await client.get({
        path: 'products',
        query: { limit: limit.toString(), status: 'active' },
      });

      const products = (response.body as any).products;

      return products.map((product: any) => ({
        id: product.id.toString(),
        title: product.title,
        description: product.body_html?.replace(/<[^>]*>/g, '').slice(0, 150) || '',
        price: product.variants[0]?.price || '0',
        compareAtPrice: product.variants[0]?.compare_at_price,
        image: product.images[0]?.src || null,
        variantId: product.variants[0]?.id,
        available: product.variants[0]?.inventory_quantity > 0,
      }));
    } catch (error: any) {
      console.error('Shopify products fetch error:', error);
      throw new Error(`Failed to fetch products: ${error.message}`);
    }
  }

  /**
   * Get a single product by ID
   */
  async getProduct(shop: string, productId: string) {
    try {
      const shopData = await prisma.shop.findUnique({
        where: { shopDomain: shop },
      });

      if (!shopData) {
        throw new Error('Shop not found');
      }

      const session = shopify.session.customAppSession(shopData.shopDomain);
      session.accessToken = shopData.accessToken;

      const client = new shopify.clients.Rest({ session });

      const response = await client.get({
        path: `products/${productId}`,
      });

      const product = (response.body as any).product;

      return {
        id: product.id.toString(),
        title: product.title,
        description: product.body_html?.replace(/<[^>]*>/g, '') || '',
        price: product.variants[0]?.price || '0',
        compareAtPrice: product.variants[0]?.compare_at_price,
        image: product.images[0]?.src || null,
        variantId: product.variants[0]?.id,
        available: product.variants[0]?.inventory_quantity > 0,
      };
    } catch (error: any) {
      console.error('Shopify product fetch error:', error);
      throw new Error(`Failed to fetch product: ${error.message}`);
    }
  }
}

export default new ShopifyOrderService();