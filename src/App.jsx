import React, { useState } from 'react';
import { AlertCircle, Key, Lock, ExternalLink, CheckCircle, XCircle, Info } from 'lucide-react';

const CircleFaucet = () => {
  const [mode, setMode] = useState('own-key');
  const [userApiKey, setUserApiKey] = useState('');
  const [password, setPassword] = useState('');
  const [address, setAddress] = useState('');
  const [blockchain, setBlockchain] = useState('ARC-TESTNET');
  const [tokens, setTokens] = useState({ native: false, usdc: true, eurc: false });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const networks = [
    'ARC-TESTNET', 'ETH-SEPOLIA', 'AVAX-FUJI', 'MATIC-AMOY',
    'SOL-DEVNET', 'ARB-SEPOLIA', 'UNI-SEPOLIA', 'BASE-SEPOLIA',
    'OP-SEPOLIA', 'APTOS-TESTNET'
  ];

  const handleClaim = async () => {
    setResult(null);
    
    // Validation
    if (!address.trim()) {
      setResult({ type: 'error', message: 'Please enter a wallet address' });
      return;
    }

    if (!tokens.native && !tokens.usdc && !tokens.eurc) {
      setResult({ type: 'error', message: 'Please select at least one token' });
      return;
    }

    if (mode === 'own-key' && !userApiKey.trim()) {
      setResult({ type: 'error', message: 'Please enter your Circle API key' });
      return;
    }

    if (mode === 'default' && !password.trim()) {
      setResult({ type: 'error', message: 'Please enter the faucet password' });
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: address.trim(),
          blockchain,
          native: tokens.native,
          usdc: tokens.usdc,
          eurc: tokens.eurc,
          apiKey: mode === 'own-key' ? userApiKey : undefined,
          password: mode === 'default' ? password : undefined,
          mode
        })
      });

      const data = await response.json();

      if (response.ok) {
        setResult({
          type: 'success',
          message: '✅ Tokens claimed successfully!',
          details: data.transactionId ? `Transaction ID: ${data.transactionId}` : null
        });
        
        // Clear sensitive fields
        setAddress('');
        if (mode === 'default') setPassword('');
      } else {
        setResult({
          type: 'error',
          message: data.message || 'Claim failed',
          details: data.error
        });
      }
    } catch (error) {
      setResult({
        type: 'error',
        message: 'Connection error',
        details: error.message
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-600 to-indigo-800 p-4 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-2xl w-full">
        <h1 className="text-3xl font-bold text-center text-gray-800 mb-2">
          🚰 Circle Faucet
        </h1>
        <p className="text-center text-gray-600 mb-6">
          Claim testnet tokens on multiple networks
        </p>

        {/* Developer Account CTA */}
        <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="text-blue-600 mt-1 flex-shrink-0" size={20} />
            <div className="flex-1">
              <p className="text-sm text-blue-900 font-semibold mb-2">
                Need an API key? (Recommended)
              </p>
              <p className="text-sm text-blue-800 mb-3">
                Create a free Circle developer account to get your own API key and manage your own quota.
              </p>
              <a
                href="https://developers.circle.com/w3s/circle-developer-account"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
              >
                <Key size={16} />
                Create Developer Account
                <ExternalLink size={14} />
              </a>
            </div>
          </div>
        </div>

        {/* Mode Selection */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <button
            onClick={() => setMode('own-key')}
            className={`p-4 rounded-lg border-2 transition-all ${
              mode === 'own-key'
                ? 'border-purple-600 bg-purple-50'
                : 'border-gray-200 hover:border-purple-300'
            }`}
          >
            <Key className={`mx-auto mb-2 ${mode === 'own-key' ? 'text-purple-600' : 'text-gray-400'}`} size={24} />
            <div className="text-sm font-semibold">Use My API Key</div>
            <div className="text-xs text-gray-600 mt-1">You manage your quota</div>
          </button>
          
          <button
            onClick={() => setMode('default')}
            className={`p-4 rounded-lg border-2 transition-all ${
              mode === 'default'
                ? 'border-purple-600 bg-purple-50'
                : 'border-gray-200 hover:border-purple-300'
            }`}
          >
            <Lock className={`mx-auto mb-2 ${mode === 'default' ? 'text-purple-600' : 'text-gray-400'}`} size={24} />
            <div className="text-sm font-semibold">Use Default Faucet</div>
            <div className="text-xs text-gray-600 mt-1">Password required</div>
          </button>
        </div>

        {/* API Key or Password Input */}
        {mode === 'own-key' ? (
          <div className="mb-6">
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Your Circle API Key *
            </label>
            <input
              type="password"
              value={userApiKey}
              onChange={(e) => setUserApiKey(e.target.value)}
              placeholder="TEST_API_KEY:xxx:xxx"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-purple-600 focus:outline-none transition-colors"
            />
            <div className="mt-2 flex items-start gap-2 text-xs text-gray-600 bg-gray-50 p-3 rounded-lg">
              <Info size={16} className="flex-shrink-0 mt-0.5" />
              <p>
                <strong>Limits:</strong> 1 claim per wallet per network per 24h (basic abuse protection). 
                Circle enforces their own per-key limits separately.
              </p>
            </div>
          </div>
        ) : (
          <div className="mb-6">
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Faucet Password *
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-purple-600 focus:outline-none transition-colors"
            />
            <p className="mt-2 text-xs text-gray-600">
              Contact admin for default faucet password. Limited to 3 claims per IP per 24h + 1 claim per wallet per network per 24h.
            </p>
          </div>
        )}

        {/* Wallet Address */}
        <div className="mb-6">
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Wallet Address *
          </label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x..."
            className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-purple-600 focus:outline-none transition-colors"
          />
        </div>

        {/* Blockchain Network */}
        <div className="mb-6">
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Blockchain Network *
          </label>
          <select
            value={blockchain}
            onChange={(e) => setBlockchain(e.target.value)}
            className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-purple-600 focus:outline-none transition-colors bg-white"
          >
            {networks.map(net => (
              <option key={net} value={net}>{net}</option>
            ))}
          </select>
        </div>

        {/* Token Selection */}
        <div className="mb-6">
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Tokens to Claim *
          </label>
          <div className="flex gap-3 flex-wrap">
            {['native', 'usdc', 'eurc'].map(token => (
              <label
                key={token}
                className={`flex items-center gap-2 px-4 py-3 border-2 rounded-lg cursor-pointer transition-colors ${
                  tokens[token] 
                    ? 'border-purple-600 bg-purple-50' 
                    : 'border-gray-200 hover:border-purple-300'
                }`}
              >
                <input
                  type="checkbox"
                  checked={tokens[token]}
                  onChange={(e) => setTokens({ ...tokens, [token]: e.target.checked })}
                  className="w-4 h-4 accent-purple-600"
                />
                <span className="font-medium text-sm uppercase">{token}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Claim Button */}
        <button
          onClick={handleClaim}
          disabled={loading}
          className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 text-white py-4 rounded-lg font-semibold hover:from-purple-700 hover:to-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              Claiming...
            </span>
          ) : (
            'Claim Tokens'
          )}
        </button>

        {/* Result */}
        {result && (
          <div className={`mt-6 p-4 rounded-lg border-2 ${
            result.type === 'success' 
              ? 'bg-green-50 border-green-200' 
              : 'bg-red-50 border-red-200'
          }`}>
            <div className="flex items-start gap-3">
              {result.type === 'success' ? (
                <CheckCircle className="text-green-600 flex-shrink-0 mt-1" size={20} />
              ) : (
                <XCircle className="text-red-600 flex-shrink-0 mt-1" size={20} />
              )}
              <div className="flex-1 min-w-0">
                <p className={`font-semibold ${
                  result.type === 'success' ? 'text-green-900' : 'text-red-900'
                }`}>
                  {result.message}
                </p>
                {result.details && (
                  <p className="mt-2 text-sm text-gray-700 font-mono bg-black bg-opacity-5 p-2 rounded break-all">
                    {result.details}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Footer Info */}
        <div className="mt-6 pt-6 border-t border-gray-200">
          <div className="text-xs text-gray-600 space-y-2">
            <p>
              <strong>Security:</strong> API keys are never stored. All requests are server-validated.
            </p>
            <p>
              <strong>Limits:</strong> User keys: 1 claim per wallet per network per 24h (Circle may enforce additional per-key limits) • 
              Default faucet: 3 claims per IP per 24h + 1 claim per wallet per network per 24h
            </p>
            <p>
              <strong>Need help?</strong> Visit{' '}
              <a 
                href="https://developers.circle.com/w3s/docs" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-purple-600 hover:underline"
              >
                Circle Documentation
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CircleFaucet;
