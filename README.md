# Circle Faucet Claimer - Vercel Deployment

A serverless web application for claiming testnet tokens from Circle's faucet on various blockchain networks including ARC-TESTNET, ETH-SEPOLIA, AVAX-FUJI, and more.

## 🚀 Quick Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/yourusername/circle-faucet-vercel)

## 📁 Project Structure

```
circle-faucet-vercel/
├── api/
│   └── claim.js          # Serverless API endpoint
├── public/
│   └── index.html        # Frontend UI
├── vercel.json           # Vercel configuration
├── package.json          # Node.js dependencies
└── README.md            # This file
```

## 🛠️ Setup Instructions

### Option 1: Deploy to Vercel (Recommended)

1. **Fork/Clone this repository**
   ```bash
   git clone https://github.com/yourusername/circle-faucet-vercel.git
   cd circle-faucet-vercel
   ```

2. **Push to your GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/yourusername/circle-faucet-vercel.git
   git push -u origin main
   ```

3. **Deploy on Vercel**
   - Go to [vercel.com](https://vercel.com)
   - Click "New Project"
   - Import your GitHub repository
   - Add environment variable (optional but recommended):
     - Name: `CIRCLE_API_KEY`
     - Value: Your Circle API key (format: `TEST_API_KEY:xxx:xxx`)
   - Click "Deploy"

4. **Done!** Your app will be live at `https://your-project.vercel.app`

### Option 2: Local Development

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create `.env` file** (optional)
   ```bash
   CIRCLE_API_KEY=TEST_API_KEY:your_key_here
   ```

3. **Run locally with Vercel CLI**
   ```bash
   npm run dev
   ```

4. **Or run with Node.js**
   ```bash
   # Start the original server.js
   node server.js
   ```

## 🔑 Setting Up Circle API Key

### Get Your API Key:
1. Go to [Circle Developer Portal](https://developers.circle.com)
2. Create an account or sign in
3. Generate a test API key
4. Copy the full key (format: `TEST_API_KEY:xxx:xxx`)

### Add to Vercel:
1. Go to your Vercel project
2. Settings → Environment Variables
3. Add `CIRCLE_API_KEY` with your key
4. Redeploy

**Note:** The app includes a default test key for quick testing, but you should replace it with your own key for production use.

## 📝 Features

- ✅ Claim testnet tokens on 10+ blockchain networks
- ✅ Support for Native, USDC, and EURC tokens
- ✅ Rate limit tracking (24-hour cooldown per wallet/network)
- ✅ Beautiful gradient UI with loading states
- ✅ Detailed error messages and solutions
- ✅ Fully serverless (no backend to maintain)
- ✅ CORS-enabled API endpoint
- ✅ Mobile responsive design

## 🌐 Supported Networks

- ARC-TESTNET
- ETH-SEPOLIA
- AVAX-FUJI
- MATIC-AMOY
- SOL-DEVNET
- ARB-SEPOLIA
- UNI-SEPOLIA
- BASE-SEPOLIA
- OP-SEPOLIA
- APTOS-TESTNET

## 🎯 Usage

1. Enter your wallet address
2. Select blockchain network
3. Choose tokens to claim (Native, USDC, EURC)
4. Click "Claim Tokens"
5. Wait for confirmation

**Rate Limits:**
- 1 claim per 24 hours per wallet/network combination
- IP-based rate limits may apply
- The app tracks claims locally to prevent unnecessary API calls

## 🔧 API Endpoint

### `POST /api/claim`

**Request Body:**
```json
{
  "address": "0x...",
  "blockchain": "ARC-TESTNET",
  "native": true,
  "usdc": true,
  "eurc": false
}
```

**Success Response:**
```json
{
  "status": "success",
  "transactionId": "...",
  "nextClaimTime": "..."
}
```

**Error Response:**
```json
{
  "code": 5,
  "message": "API rate limit error"
}
```

## 🐛 Troubleshooting

### Rate Limit Errors
- Wait 24 hours before claiming again with the same wallet
- Try a different wallet address
- Try a different blockchain network

### Connection Errors
- Check if your API key is set correctly
- Verify the API endpoint is accessible
- Check Vercel function logs for errors

### CORS Errors
- The API is configured with CORS headers
- Make sure you're using the correct endpoint
- Check `vercel.json` configuration

## 📦 Dependencies

- Node.js built-in `https` module (no external dependencies)
- Vercel for serverless deployment
- Modern browser with localStorage support

## 🔒 Security Notes

- API keys are stored as environment variables (never committed to git)
- Frontend makes requests to your own API endpoint
- Rate limiting prevents abuse
- All requests go through your Vercel serverless function

## 📄 License

MIT License - feel free to use and modify for your projects!

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📞 Support

For issues related to:
- Circle API: [Circle Developer Docs](https://developers.circle.com)
- Vercel Deployment: [Vercel Documentation](https://vercel.com/docs)
- This App: Open an issue on GitHub

## 🎉 Credits

Built with Circle's Faucet API for testnet token distribution.

---

**Happy Testing! 🚀**
