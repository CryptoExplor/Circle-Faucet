import https from 'https';

// Get API key from environment variable or use default
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY || "TEST_API_KEY:1ef93a2a482adb58df2c615510b24c61:81b8e96bb7cb449fceba22574630ea0c";

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = req.body;

    // Validate required fields
    if (!data.address) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    if (!data.blockchain) {
      return res.status(400).json({ error: 'Blockchain network required' });
    }

    // Build the request payload with proper format
    // Circle API requires amount objects, not boolean flags
    const payload = {
      address: data.address,
      blockchain: data.blockchain
    };

    // Add token amounts if requested
    if (data.native) {
      payload.native = { amount: "0.01" };
    }
    if (data.usdc) {
      payload.usdc = { amount: "5" };
    }
    if (data.eurc) {
      payload.eurc = { amount: "5" };
    }

    const postData = JSON.stringify(payload);

    // Make request to Circle API
    const options = {
      hostname: 'api.circle.com',
      port: 443,
      path: '/v1/faucets/drips',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CIRCLE_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    // Promisify the HTTPS request
    const circleResponse = await new Promise((resolve, reject) => {
      const apiReq = https.request(options, (apiRes) => {
        let responseData = '';

        apiRes.on('data', (chunk) => {
          responseData += chunk;
        });

        apiRes.on('end', () => {
          try {
            const parsedData = JSON.parse(responseData);
            resolve({
              statusCode: apiRes.statusCode,
              data: parsedData
            });
          } catch (e) {
            resolve({
              statusCode: apiRes.statusCode,
              data: { raw: responseData }
            });
          }
        });
      });

      apiReq.on('error', (error) => {
        reject(error);
      });

      apiReq.write(postData);
      apiReq.end();
    });

    // Return Circle's response
    return res.status(circleResponse.statusCode).json(circleResponse.data);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}
