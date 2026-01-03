import { shopifyApi, ApiVersion } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  scopes: process.env.SHOPIFY_SCOPES!.split(','),
  hostName: process.env.HOST!.replace(/https?:\/\//, ''),
  hostScheme: 'https',
  apiVersion: ApiVersion.July25,
  isEmbeddedApp: true,
});

export default shopify;