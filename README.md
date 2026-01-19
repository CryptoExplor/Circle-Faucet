# Circle Faucet - Multi-Key Testnet Token Claimer

A secure, serverless web application for claiming testnet tokens from Circle's faucet with support for user-provided API keys and a password-protected default faucet.

## 🎯 Features

- ✅ **Dual Mode Operation**
  - Use your own Circle API key (5 claims/24h)
  - Use default faucet with password protection (3 claims/24h)
  
- ✅ **Multi-Network Support**
  - ARC-TESTNET, ETH-SEPOLIA, AVAX-FUJI, MATIC-AMOY
  - SOL-DEVNET, ARB-SEPOLIA, UNI-SEPOLIA, BASE-SEPOLIA
  - OP-SEPOLIA, APTOS-TESTNET

- ✅ **Security Features**
  - API key hashing (never stored in plain text)
  - Password-protected default faucet
  - Rate limiting per API key/IP/wallet
  - Multiple API key rotation for default mode
  - Emergency kill switch

- ✅ **Rate Limiting**
  - User API keys: 5 claims per 24 hours
  - Default faucet: 3 claims per 24 hours per IP/wallet
  - Client-side tracking with localStorage
  - Server-side validation

## 🚀 Quick Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/CryptoExplor/circle-faucet)

## 📁 Project Structure

```
circle-faucet/
├── api/
│   └── claim.js              # Serverless API endpoint with multi-key support
├── public/
│   ├── index.html            # Main UI (use React version instead)
│   └── batch.html            # Batch claiming interface
├── src/
│   └── App.jsx               # React UI component
├── .env.example              # Environment variables template
├── vercel.json               # Vercel configuration
├── package.json              # Dependencies
└── README.md                 # This file
```

## 🛠️ Setup Instructions

### 1. Get Your Circle API Key

1. Visit [Circle Developer Portal](https://developers.circle.com/w3s/circle-developer-account)
2. Create a free developer account
3. Generate a **Test API Key**
4. Copy the key (format: `TEST_API_KEY:xxx:xxx`)

### 2. Environment Variables Setup

Create a `.env` file in the root directory:

```bash
# Multiple Circle API keys for default faucet (comma-separated)
CIRCLE_API_KEYS="TEST_API_KEY:xxx:xxx,TEST_API_KEY:yyy:yyy,TEST_API_KEY:zzz:zzz"

# Default faucet password (hashed with SHA-256)
# To generate: echo -n "your_password" | sha256sum
DEFAULT_PASSWORD_HASH="your_password_hash_here"

# Emergency kill switch (optional)
FAUCET_DISABLED=false
```

### 3. Deploy to Vercel

**Option A: One-Click Deploy**
1. Click the "Deploy with Vercel" button above
2. Add environment variables in Vercel dashboard
3. Deploy!

**Option B: Manual Deploy**
```bash
# Clone the repository
git clone https://github.com/CryptoExplor/circle-faucet.git
cd circle-faucet

# Install Vercel CLI
npm install -g vercel

# Deploy
vercel --prod
```

### 4. Configure Vercel Environment Variables

1. Go to your Vercel project dashboard
2. Settings → Environment Variables
3. Add the following variables:
   - `CIRCLE_API_KEYS`: Your comma-separated API keys
   - `DEFAULT_PASSWORD_HASH`: SHA-256 hash of your password
   - `FAUCET_DISABLED`: (optional) Set to `true` to disable faucet

## 🔐 Security Best Practices

### Password Hashing

Generate a secure password hash:

```bash
# Linux/Mac
echo -n "your_secure_password" | sha256sum

# Or use Node.js
node -e "console.log(require('crypto').createHash('sha256').update('your_password').digest('hex'))"
```

### API Key Management

- **Never commit API keys** to version control
- Use separate keys for different environments
- Rotate keys periodically
- Monitor usage in Circle dashboard
- Revoke compromised keys immediately

### Rate Limiting Strategy

| Mode | Limit | Window | Identifier |
|------|-------|--------|------------|
| User API Key | 5 claims | 24 hours | Hashed API key |
| Default Faucet | 3 claims | 24 hours | IP + Wallet |

## 📖 Usage Guide

### For End Users

**Option 1: Use Your Own API Key** (Recommended)
1. Create a Circle developer account
2. Generate your test API key
3. Select "Use My API Key" mode
4. Enter your API key
5. Claim tokens (5 times per 24 hours)

**Option 2: Use Default Faucet**
1. Select "Use Default Faucet" mode
2. Enter the faucet password (provided by admin)
3. Claim tokens (3 times per 24 hours)

### For Developers

**Local Development**
```bash
# Install dependencies
npm install

# Run locally
vercel dev

# Test the API
curl -X POST http://localhost:3000/api/claim \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x...",
    "blockchain": "ARC-TESTNET",
    "native": true,
    "usdc": true,
    "mode": "own-key",
    "apiKey": "TEST_API_KEY:xxx:xxx"
  }'
```

## 🔧 API Documentation

### Endpoint: `POST /api/claim`

**Request Body (Own Key Mode)**
```json
{
  "address": "0x1234...",
  "blockchain": "ARC-TESTNET",
  "native": true,
  "usdc": true,
  "eurc": false,
  "mode": "own-key",
  "apiKey": "TEST_API_KEY:xxx:xxx"
}
```

**Request Body (Default Faucet Mode)**
```json
{
  "address": "0x1234...",
  "blockchain": "ETH-SEPOLIA",
  "native": false,
  "usdc": true,
  "eurc": false,
  "mode": "default",
  "password": "your_password"
}
```

**Success Response (200)**
```json
{
  "success": true,
  "message": "Tokens claimed successfully",
  "data": { ... },
  "remaining": 4
}
```

**Error Responses**

| Code | Error | Description |
|------|-------|-------------|
| 400 | Bad Request | Missing or invalid parameters |
| 401 | Unauthorized | Invalid password |
| 429 | Too Many Requests | Rate limit exceeded |
| 503 | Service Unavailable | Faucet disabled |

## 🎨 Customization

### Update Supported Networks

Edit the networks array in the UI:

```javascript
const networks = [
  'ARC-TESTNET',
  'ETH-SEPOLIA',
  // Add more networks here
];
```

### Modify Rate Limits

In `api/claim.js`:

```javascript
// User API key limit
const rateCheck = checkRateLimit(rateLimitIdentifier, 5, 24);

// Default faucet limit
const rateCheck = checkRateLimit(rateLimitIdentifier, 3, 24);
```

### Emergency Disable

Set environment variable:
```bash
FAUCET_DISABLED=true
```

Or programmatically in `api/claim.js`:
```javascript
if (process.env.FAUCET_DISABLED === 'true') {
  return res.status(503).json({ 
    error: 'Faucet temporarily disabled'
  });
}
```

## 🐛 Troubleshooting

### Common Issues

**1. "Invalid API key format"**
- Ensure your key starts with `TEST_API_KEY:`
- Check for extra spaces or line breaks
- Verify you copied the entire key

**2. "Rate limit exceeded"**
- Wait 24 hours for the limit to reset
- Use a different API key
- Try a different wallet address

**3. "Password incorrect"**
- Verify your password hash is correct
- Regenerate hash if needed
- Check for typos in environment variable

**4. "No API keys configured"**
- Add `CIRCLE_API_KEYS` to Vercel environment
- Ensure keys are comma-separated
- Redeploy after adding variables

### Debug Mode

Enable logging in `api/claim.js`:

```javascript
console.log('Request:', req.body);
console.log('Rate limit check:', rateCheck);
console.log('Circle response:', circleResponse);
```

View logs:
```bash
vercel logs <deployment-url>
```

## 📊 Monitoring

### Track Usage

Monitor your Circle API usage in the [Circle Dashboard](https://console.circle.com/)

### Analytics

Track claims with the built-in localStorage system:

```javascript
const history = JSON.parse(localStorage.getItem('circleFaucetHistory'));
console.log('Total claims:', Object.keys(history).length);
```

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

## 🔗 Links

- [Circle Developer Docs](https://developers.circle.com/)
- [Circle API Reference](https://developers.circle.com/w3s/reference)
- [Vercel Documentation](https://vercel.com/docs)
- [Support](https://github.com/yourusername/circle-faucet/issues)

## ⚠️ Important Notes

- **Test API keys only**: This faucet is for testnet tokens only
- **Rate limits**: Respect Circle's rate limits to avoid suspension
- **Security**: Never expose API keys in client-side code
- **Monitoring**: Regularly check for abuse and suspicious activity
- **Updates**: Keep dependencies updated for security patches

---

**Built with ❤️ using Circle's Faucet API**

Need help? [Open an issue](https://github.com/yourusername/circle-faucet/issues)
