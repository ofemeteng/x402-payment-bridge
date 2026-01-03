import axios from 'axios';

interface VerifyPaymentRequest {
  txHash: string;
  network: string;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string;
  amount: string;
}

interface VerifyPaymentResponse {
  verified: boolean;
  transaction: {
    hash: string;
    from: string;
    to: string;
    value: string;
    token: string;
    blockNumber: number;
    timestamp: number;
  };
  status: string;
}

export class X402Service {
  private facilitatorUrl: string;

  constructor() {
    this.facilitatorUrl = process.env.X402_FACILITATOR_URL || 'https://facilitator.x402.org/v2/verify';
  }

  /**
   * Verify a payment transaction using x402 v2 protocol
   */
  async verifyPayment(request: VerifyPaymentRequest): Promise<VerifyPaymentResponse> {
    try {
      const response = await axios.post(this.facilitatorUrl, {
        transaction_hash: request.txHash,
        network: request.network,
        expected_from: request.fromAddress,
        expected_to: request.toAddress,
        expected_token: request.tokenAddress,
        expected_amount: request.amount,
        version: '2.0'
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Protocol-Version': '2.0'
        },
        timeout: 30000 // 30 second timeout
      });

      return {
        verified: response.data.verified === true,
        transaction: response.data.transaction,
        status: response.data.status || 'verified'
      };
    } catch (error: any) {
      console.error('x402 verification error:', error.response?.data || error.message);
      
      return {
        verified: false,
        transaction: {
          hash: request.txHash,
          from: request.fromAddress,
          to: request.toAddress,
          value: request.amount,
          token: request.tokenAddress,
          blockNumber: 0,
          timestamp: Date.now()
        },
        status: 'failed'
      };
    }
  }

  /**
   * Generate payment request metadata for x402 v2
   */
  generatePaymentRequest(
    merchantWallet: string,
    tokenAddress: string,
    amount: string,
    network: string,
    productId: string,
    productTitle: string
  ) {
    return {
      protocol: 'x402',
      version: '2.0',
      recipient: merchantWallet,
      token: tokenAddress,
      amount: amount,
      network: network,
      metadata: {
        productId,
        productTitle,
        timestamp: Date.now()
      }
    };
  }
}

export default new X402Service();