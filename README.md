# Circle Faucet - Multi-Key Testnet Token Claimer

A secure, serverless web application for claiming testnet tokens from Circle's faucet with support for user-provided API keys and a password-protected default faucet with smart key rotation.

## 🎯 Features

- ✅ **Dual Mode Operation**
  - Use your own Circle API key (unlimited claims, subject to Circle's limits)
  - Use default faucet with password protection (1 claim per wallet/network per 24h)
  
- ✅ **Multi-Network Support**
  - ARC-TESTNET, ETH-SEPOLIA, AVAX-FUJI, MATIC-AMOY
  - SOL-DEVNET, ARB-SEPOLIA, UNI-SEPOLIA, BASE-SEPOLIA
  - OP-SEPOLIA, APTOS-TESTNET

- ✅ **Security Features**
  - API key hashing (never stored in plain text)
  - Password-protected default faucet
  - Rate limiting per wallet/network
  - **Round-robin API key rotation** for load balancing
  - Emergency kill switch

- ✅ **Smart Key Management**
  - Round-robin rotation: Each claim uses the next API key in sequence
  - Automatic cycling when a key reaches the end of the list
  - Load distribution across multiple API keys
  - Maximizes daily claim capacity

- ✅ **Rate Limiting**
  - User API keys: No limit from our side (Circle enforces 5-10 claims/day)
  - Default faucet: 1 claim per wallet per network per 24 hours
  - Infrastructure DoS protection: 100 requests per hour per IP

## 🔄 How Key Rotation Works

The default faucet uses a **round-robin rotation strategy**:

1. **First claim** → Uses API Key #1
2. **Second claim** → Uses API Key #2
3. **Third claim** → Uses API Key #3
4. **Fourth claim** → Cycles back to API Key #1
5. And so on...

**Benefits:**
- Distributes load evenly across all keys
- Maximizes daily claim capacity (if you have 3 keys with 10 claims/day each = 30 total claims/day)
- No single key gets exhausted quickly
- Automatic failover if one key hits Circle's limit

**Example with 3 API keys:**
```
Claim 1: Key A → Claim 4: Key A → Claim 7: Key A
Claim 2: Key B → Claim 5: Key B → Claim 8: Key B
Claim 3: Key C → Claim 6: Key C → Claim 9: Key C
```

## 🚀 Quick Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/CryptoExplor/circle-faucet)

## 📁 Project Structure

```
circle-faucet/
├── api/
│   └── claim.js              # Serverless API with round-robin key rotation
├── public/
│   ├── index.html            # Main UI
│   └── batch.html            # Batch claiming interface
├── .env.example              # Environment variables template
├── vercel.json               # Vercel configuration
├── package.json              # Dependencies
└── README.md                 # This file
```

## 🛠️ Setup Instructions

### 1. Get Your Circle API Keys

1. Visit [Circle Developer Portal](https://developers.circle.com/w3s/circle-developer-account)
2. Create a free developer account
3. Generate **multiple Test API Keys** (recommended: 3-5 keys for better distribution)
4. Copy the keys (format: `TEST_API_KEY:xxx:xxx`)

### 2. Environment Variables Setup

Create a `.env` file in the root directory:

```bash
# Multiple Circle API keys for round-robin rotation (comma-separated)
# More keys = more daily claim capacity!
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

- **Use multiple keys** (3-5 recommended) for better load distribution
- **Never commit API keys** to version control
- Use separate keys for different environments
- Rotate keys periodically
- Monitor usage in Circle dashboard
- Revoke compromised keys immediately

### Rate Limiting Strategy

| Mode | Limit | Window | Identifier | Key Usage |
|------|-------|--------|------------|-----------|
| User API Key | Circle's limit (5-10/day) | 24 hours | User's key | Single key |
| Default Faucet | 1 claim per wallet/network | 24 hours | Wallet + Network | Round-robin rotation |
| Infrastructure | 100 requests | 1 hour | IP address | All modes |

## 📖 Usage Guide

### For End Users

**Option 1: Use Your Own API Key** (Recommended)
1. Create a Circle developer account
2. Generate your test API key
3. Select "Use My API Key" mode
4. Enter your API key
5. Claim unlimited tokens (subject to Circle's per-key limits)

**Option 2: Use Default Faucet**
1. Select "Use Default Faucet" mode
2. Enter the faucet password (provided by admin)
3. Claim tokens (1 time per wallet per network per 24 hours)

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
  "transactionId": "...",
  "data": { ... }
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

### Add More API Keys

Simply add them to your environment variable:

```bash
# Add as many keys as you want (comma-separated)
CIRCLE_API_KEYS="KEY1,KEY2,KEY3,KEY4,KEY5"
```

The system will automatically:
- Detect all keys
- Distribute claims evenly
- Cycle through them in order

### Modify Rate Limits

In `api/claim.js`:

```javascript
// Wallet-based rate limit (default: 1 claim per 24h)
const walletLimit = checkRateLimit(`wallet:${walletHash}`, 1, 24 * 60 * 60 * 1000);

// To allow 3 claims per wallet per 24h:
const walletLimit = checkRateLimit(`wallet:${walletHash}`, 3, 24 * 60 * 60 * 1000);
```

### Emergency Disable

Set environment variable:
```bash
FAUCET_DISABLED=true
```

## 🐛 Troubleshooting

### Common Issues

**1. "Invalid API key format"**
- Ensure your key starts with `TEST_API_KEY:`
- Check for extra spaces or line breaks
- Verify you copied the entire key

**2. "Rate limit exceeded"**
- Default faucet: Wait 24 hours or try a different wallet
- Own key mode: You've hit Circle's per-key limit (5-10 claims/day)
- Solution: Use multiple API keys or wait for reset

**3. "Password incorrect"**
- Verify your password hash is correct
- Regenerate hash if needed
- Check for typos in environment variable

**4. "No API keys configured"**
- Add `CIRCLE_API_KEYS` to Vercel environment
- Ensure keys are comma-separated
- Redeploy after adding variables

### Key Rotation Debugging

Check logs to see which key is being used:

```
[KEY_ROTATION] Using key 0 of 3, next will be 1
[KEY_ROTATION] Using key 1 of 3, next will be 2
[KEY_ROTATION] Using key 2 of 3, next will be 0
```

## 📊 Monitoring

### Track Usage

Monitor your Circle API usage in the [Circle Dashboard](https://console.circle.com/)

**Benefits of Multiple Keys:**
- See usage distributed across all keys
- Know which keys are approaching limits
- Replace exhausted keys without downtime

### Daily Capacity Calculation

```
Total Daily Capacity = Number of Keys × Claims per Key

Example:
- 3 API keys
- Each key allows ~10 claims/day
- Total capacity: 3 × 10 = 30 claims/day
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
- **Rate limits**: Circle enforces per-key limits (5-10 claims/day varies by network)
- **Key rotation**: Each claim uses the next key in sequence for optimal distribution
- **Security**: Never expose API keys in client-side code
- **Monitoring**: Regularly check for abuse and suspicious activity
- **Updates**: Keep dependencies updated for security patches
- **Scalability**: Add more keys to increase daily claim capacity

---

**Built with ❤️ using Circle's Faucet API**

Need help? [Open an issue](https://github.com/yourusername/circle-faucet/issues)
