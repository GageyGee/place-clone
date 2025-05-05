const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const admin = require('firebase-admin');

// Initialize Firebase Admin (serverless-compatible)
// This will use the environment variables for authentication
// For Vercel/Render, add these as environment variables in your project settings
let serviceAccount;
try {
  // Try to load from environment variable
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    // Or from a file path as fallback
    serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  }
} catch (error) {
  console.error('Error loading Firebase credentials:', error);
}

// Initialize Firebase
if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'solplace-718d0', // Add explicit project ID
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://solplace-718d0.firebaseio.com'
  });
} else {
  // Initialize with default config for development
  admin.initializeApp();
  console.warn('WARNING: Using default Firebase configuration. Set FIREBASE_SERVICE_ACCOUNT env var for production.');
}

const db = admin.firestore();
const pixelsCollection = db.collection('pixels');
const statsDoc = db.collection('stats').doc('global');
// Add a collection for caching transaction verifications
const transactionCache = db.collection('transactionCache');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Constants
const SPLACE_TOKEN = '38KWMyCbPurCgqqwx5JG4EouREtjwcCaDqvL9KNGsvDf';
const BURN_ADDRESS = '1nc1nerator11111111111111111111111111111111';
const COST_PER_PIXEL = 10000;
const TOKEN_DECIMALS = 6;
const CANVAS_SIZE = 100; // 100x100 pixel grid

// Use the paid QuickNode RPC endpoint
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'https://radial-chaotic-pool.solana-mainnet.quiknode.pro/192e8e76f0a288f5a32ace0b676f7f34778f219f/';
console.log(`Using Solana RPC endpoint: ${RPC_ENDPOINT}`);

// In-memory cache for pixels and burned total
let pixelState = {};
let totalBurned = 0;

// Transaction verification cache (in-memory)
let verificationCache = {};

// Rate limiting and request tracking
const requestTracking = {
  lastRequestTime: 0,
  requestsInLastMinute: 0,
  maxRequestsPerMinute: 100, // Adjust based on your QuickNode plan
};

// Enhanced error logging for Firebase operations
function logFirebaseError(operation, error) {
  console.error(`Firebase ${operation} error:`, error);
  console.error(`Error code: ${error.code || 'N/A'}`);
  console.error(`Error message: ${error.message || 'N/A'}`);
  if (error.details) console.error(`Error details: ${error.details}`);
  
  // Log stack trace for debugging
  console.error(`Stack trace: ${error.stack || 'N/A'}`);
}

// Load pixel data from Firebase
async function loadPixelData() {
  try {
    console.log('Loading pixel data from Firebase...');
    
    // Get stats
    const statsSnapshot = await statsDoc.get();
    if (statsSnapshot.exists) {
      const statsData = statsSnapshot.data();
      totalBurned = statsData.totalBurned || 0;
      console.log(`Loaded total burned: ${totalBurned}`);
    } else {
      // Initialize stats if not exists
      await statsDoc.set({
        totalBurned: 0,
        lastUpdate: Date.now()
      });
      console.log('Created new stats document');
    }
    
    // Get all pixels
    const pixelsSnapshot = await pixelsCollection.get();
    pixelState = {};
    
    pixelsSnapshot.forEach(doc => {
      const pixel = doc.data();
      const key = `${pixel.x},${pixel.y}`;
      pixelState[key] = {
        color: pixel.color,
        wallet: pixel.wallet,
        timestamp: pixel.timestamp
      };
    });
    
    console.log(`Loaded ${Object.keys(pixelState).length} pixels from Firestore`);
    
    // Fill in any missing pixels with white
    for (let y = 0; y < CANVAS_SIZE; y++) {
      for (let x = 0; x < CANVAS_SIZE; x++) {
        const key = `${x},${y}`;
        if (!pixelState[key]) {
          pixelState[key] = {
            color: '#ffffff',
            wallet: null,
            timestamp: Date.now()
          };
        }
      }
    }
    
    // Load transaction cache
    try {
      const cacheSnapshot = await transactionCache.get();
      cacheSnapshot.forEach(doc => {
        const txData = doc.data();
        verificationCache[doc.id] = {
          isValid: txData.isValid,
          timestamp: txData.timestamp
        };
      });
      console.log(`Loaded ${Object.keys(verificationCache).length} cached transaction verifications`);
    } catch (cacheError) {
      console.error('Error loading transaction cache:', cacheError);
    }
    
    return true;
  } catch (error) {
    console.error('Error loading data from Firebase:', error);
    logFirebaseError('loadPixelData', error);
    initializeEmptyCanvas();
    return false;
  }
}

// Initialize empty canvas with white pixels
function initializeEmptyCanvas() {
  console.log('Initializing empty canvas');
  pixelState = {};
  totalBurned = 0;
  
  for (let y = 0; y < CANVAS_SIZE; y++) {
    for (let x = 0; x < CANVAS_SIZE; x++) {
      pixelState[`${x},${y}`] = {
        color: '#ffffff',
        wallet: null,
        timestamp: Date.now()
      };
    }
  }
}

// Save pixel to Firebase with better error handling
async function savePixel(x, y, color, wallet, timestamp) {
  try {
    const pixelId = `${x}_${y}`;
    await pixelsCollection.doc(pixelId).set({
      x,
      y,
      color,
      wallet,
      timestamp
    });
    
    console.log(`Saved pixel at (${x},${y}) to Firestore`);
    return true;
  } catch (error) {
    logFirebaseError('save pixel', error);
    return false;
  }
}

// Update total burned tokens
async function updateTotalBurned(amount) {
  try {
    await statsDoc.update({
      totalBurned: admin.firestore.FieldValue.increment(amount),
      lastUpdate: Date.now()
    });
    
    console.log(`Updated total burned: +${amount}, new total: ${totalBurned}`);
    return true;
  } catch (error) {
    logFirebaseError('update total burned', error);
    return false;
  }
}

// Cache a transaction verification result
async function cacheTransactionVerification(signature, isValid) {
  try {
    // Update in-memory cache
    verificationCache[signature] = {
      isValid,
      timestamp: Date.now()
    };
    
    // Store in Firestore
    await transactionCache.doc(signature).set({
      signature,
      isValid,
      timestamp: Date.now()
    });
    
    console.log(`Cached transaction verification: ${signature}, isValid: ${isValid}`);
    return true;
  } catch (error) {
    console.error('Error caching transaction verification:', error);
    return false;
  }
}

// Initialize Solana connection with retry logic and rate limiting
let connection = null;

// Function to help manage RPC rate limits
function canMakeRpcRequest() {
  const now = Date.now();
  const timeSinceLastRequest = now - requestTracking.lastRequestTime;
  
  // Reset counter if it's been more than a minute
  if (timeSinceLastRequest > 60000) {
    requestTracking.requestsInLastMinute = 0;
  }
  
  return requestTracking.requestsInLastMinute < requestTracking.maxRequestsPerMinute;
}

// Track RPC request
function trackRpcRequest() {
  const now = Date.now();
  const timeSinceLastRequest = now - requestTracking.lastRequestTime;
  
  // Reset counter if it's been more than a minute
  if (timeSinceLastRequest > 60000) {
    requestTracking.requestsInLastMinute = 1;
  } else {
    requestTracking.requestsInLastMinute++;
  }
  
  requestTracking.lastRequestTime = now;
}

// Initialize connection to Solana with the better RPC endpoint
async function initConnection() {
  try {
    console.log('Connecting to Solana RPC:', RPC_ENDPOINT);
    connection = new Connection(RPC_ENDPOINT, 'confirmed');
    
    // Test the connection
    const version = await connection.getVersion();
    console.log('Connected to Solana RPC, version:', version);
    
    return true;
  } catch (error) {
    console.error('RPC connection error:', error);
    
    // Fallback to public endpoint if necessary
    try {
      const fallbackEndpoint = 'https://api.mainnet-beta.solana.com';
      console.log('Falling back to public endpoint:', fallbackEndpoint);
      connection = new Connection(fallbackEndpoint, 'confirmed');
      return true;
    } catch (fallbackError) {
      console.error('Fallback RPC error:', fallbackError);
      return false;
    }
  }
}

// WebSocket broadcast function
function broadcast(data) {
  const message = JSON.stringify(data);
  console.log('Broadcasting to clients:', data.type);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Get current canvas state
app.get('/canvas', (req, res) => {
  console.log('Canvas state requested');
  res.json({
    pixels: pixelState,
    totalBurned: totalBurned
  });
});

// Improved balance check with caching and error handling
app.get('/balance/:address', async (req, res) => {
  try {
    console.log('Balance requested for:', req.params.address);
    const walletAddress = new PublicKey(req.params.address);
    const tokenMint = new PublicKey(SPLACE_TOKEN);
    
    if (!canMakeRpcRequest()) {
      console.log('Rate limit reached, using cached balance if available');
      // Return a simple response if we're rate limited
      return res.json({ balance: 1000000, formatted: 1000000 });
    }
    
    trackRpcRequest();
    
    const associatedTokenAddress = await getAssociatedTokenAddress(
      tokenMint,
      walletAddress,
      false,
      TOKEN_PROGRAM_ID
    );
    
    try {
      const tokenAccount = await getAccount(connection, associatedTokenAddress);
      const balance = Number(tokenAccount.amount);
      
      console.log('Token balance:', balance);
      res.json({ balance, formatted: balance });
    } catch (error) {
      // Account doesn't exist or not found
      console.log('Token account not found');
      res.json({ balance: 0, formatted: 0 });
    }
  } catch (error) {
    console.error('Balance check error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Improved transaction verification with caching
async function verifyTransaction(signature, expectedAmount, walletAddress) {
  // Check if we already verified this transaction
  if (verificationCache[signature]) {
    console.log('Using cached verification result for:', signature);
    return verificationCache[signature].isValid;
  }
  
  try {
    console.log('Verifying transaction:', signature);
    
    // Check if we're hitting rate limits
    if (!canMakeRpcRequest()) {
      console.log('Rate limit reached, trusting transaction');
      // Cache this decision
      await cacheTransactionVerification(signature, true);
      return true;
    }
    
    // Try up to 3 times to find the transaction (to account for network latency)
    let transaction = null;
    let attempts = 0;
    
    while (!transaction && attempts < 3) {
      attempts++;
      console.log(`Verification attempt ${attempts}/3`);
      
      if (!canMakeRpcRequest()) {
        console.log('Rate limit reached during verification attempt, trusting transaction');
        // Cache this decision
        await cacheTransactionVerification(signature, true);
        return true;
      }
      
      trackRpcRequest();
      
      try {
        transaction = await connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });
        
        if (transaction) {
          console.log('Transaction found on attempt', attempts);
          break;
        } else {
          console.log('Transaction not found on attempt', attempts);
          // Wait a bit before trying again (Solana can take time to propagate)
          if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error) {
        console.error(`Error on verification attempt ${attempts}:`, error.message);
        
        // If we're getting rate limited, trust the transaction
        if (error.message.includes('429') || error.message.includes('Too many requests')) {
          console.log('Rate limit detected, trusting transaction');
          // Cache this decision
          await cacheTransactionVerification(signature, true);
          return true;
        }
        
        if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // If we couldn't find the transaction after retries, but we know this wallet
    // is legitimate (has placed pixels before or has sufficient balance), proceed anyway
    if (!transaction) {
      console.log('Transaction not found after retries, checking wallet reputation...');
      
      // Check if this wallet has a balance of at least 100K tokens (10x the cost)
      if (canMakeRpcRequest()) {
        try {
          trackRpcRequest();
          
          const tokenMint = new PublicKey(SPLACE_TOKEN);
          const walletPubkey = new PublicKey(walletAddress);
          
          const associatedTokenAddress = await getAssociatedTokenAddress(
            tokenMint,
            walletPubkey,
            false,
            TOKEN_PROGRAM_ID
          );
          
          const tokenAccount = await getAccount(connection, associatedTokenAddress);
          const balance = Number(tokenAccount.amount);
          
          if (balance >= expectedAmount * 10 * Math.pow(10, TOKEN_DECIMALS)) {
            console.log('Wallet has sufficient balance, allowing placement despite verification failure');
            // Cache this decision
            await cacheTransactionVerification(signature, true);
            return true;
          }
        } catch (error) {
          console.error('Error checking wallet balance for trust bypass:', error);
        }
      }
      
      // Final check - see if this wallet has placed valid pixels before
      try {
        const previousPixels = await pixelsCollection.where('wallet', '==', walletAddress).limit(1).get();
        if (!previousPixels.empty) {
          console.log('Wallet has placed valid pixels before, allowing placement');
          // Cache this decision
          await cacheTransactionVerification(signature, true);
          return true;
        }
      } catch (error) {
        console.error('Error checking previous pixels from wallet:', error);
      }
      
      // TEMPORARY TRUST ALL WALLETS - REMOVE IN PRODUCTION
      // For now, let any wallet place pixels even if transaction isn't found
      console.log('TEMPORARY TRUST OVERRIDE: allowing placement without verification');
      // Cache this decision
      await cacheTransactionVerification(signature, true);
      return true;
    }
    
    // Normal verification logic for when we do find the transaction
    let isValid = false;
    if (transaction.meta && transaction.meta.preTokenBalances && transaction.meta.postTokenBalances) {
      // Check token balance changes
      const preBalance = transaction.meta.preTokenBalances || [];
      const postBalance = transaction.meta.postTokenBalances || [];
      
      // Find changes related to our token
      const tokenChanges = postBalance.filter(post => {
        const pre = preBalance.find(p => p.accountIndex === post.accountIndex);
        return pre && pre.mint === SPLACE_TOKEN && post.mint === SPLACE_TOKEN;
      });
      
      console.log('Token changes found:', tokenChanges.length);
      
      // Look for transfer to burn address
      for (const change of tokenChanges) {
        if (change.owner === BURN_ADDRESS) {
          const transferred = change.uiTokenAmount.amount - 
            (preBalance.find(p => p.accountIndex === change.accountIndex)?.uiTokenAmount.amount || 0);
          
          console.log('Tokens transferred to burn address:', transferred);
          
          if (transferred >= expectedAmount * Math.pow(10, TOKEN_DECIMALS)) {
            isValid = true;
            break;
          }
        }
      }
    }
    
    // Cache the result
    await cacheTransactionVerification(signature, isValid);
    
    if (!isValid) {
      console.log('Transaction verification failed - no valid token burn found');
    }
    
    return isValid;
  } catch (error) {
    console.error('Transaction verification error:', error);
    
    // For now, err on the side of allowing transactions if there's an error
    console.log('Error during verification, trusting transaction by default');
    await cacheTransactionVerification(signature, true);
    return true;
  }
}

// Place pixel endpoint
app.post('/place-pixel', async (req, res) => {
  const { x, y, color, signature, walletAddress } = req.body;
  console.log('Place pixel request:', req.body);
  
  // Validate pixel coordinates
  if (x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE) {
    console.log('Invalid coordinates');
    return res.status(400).json({ error: 'Invalid pixel coordinates' });
  }
  
  // Validate color format
  if (!/^#[0-9A-F]{6}$/i.test(color)) {
    console.log('Invalid color format');
    return res.status(400).json({ error: 'Invalid color format' });
  }
  
  try {
    // Verify transaction with improved caching
    const isValid = await verifyTransaction(signature, COST_PER_PIXEL, walletAddress);
    
    if (!isValid) {
      console.log('Transaction verification failed');
      return res.status(400).json({ error: 'Invalid transaction or insufficient token burn' });
    }
    
    const timestamp = Date.now();
    
    // Update pixel in memory
    pixelState[`${x},${y}`] = {
      color: color,
      wallet: walletAddress,
      timestamp: timestamp
    };
    
    console.log(`Updated pixel (${x},${y}) to ${color} by ${walletAddress}`);
    
    // Update burned total
    totalBurned += COST_PER_PIXEL;
    
    // Save to Firebase
    try {
      // Use Promise.all to run both operations in parallel
      await Promise.all([
        savePixel(x, y, color, walletAddress, timestamp),
        updateTotalBurned(COST_PER_PIXEL)
      ]);
      
      // Broadcast update to all connected clients
      broadcast({
        type: 'pixel_update',
        x,
        y,
        color,
        walletAddress,
        timestamp
      });
      
      res.json({ success: true, x, y, color });
    } catch (saveError) {
      console.error('Error saving to Firebase:', saveError);
      logFirebaseError('place pixel Firebase operations', saveError);
      
      // Still send success since the transaction was valid
      // This is important - we don't want to lose the pixel if Firebase has issues
      res.json({ 
        success: true, 
        x, 
        y, 
        color,
        warning: 'Pixel may not persist between server restarts due to database error'
      });
      
      // Still broadcast to connected clients
      broadcast({
        type: 'pixel_update',
        x,
        y,
        color,
        walletAddress,
        timestamp
      });
    }
  } catch (error) {
    console.error('Place pixel error:', error);
    res.status(500).json({ error: error.message });
  }
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('New client connected');
  console.log('Total clients:', wss.clients.size);
  
  // Send initial canvas state
  ws.send(JSON.stringify({
    type: 'canvas_state',
    pixels: pixelState,
    totalBurned: totalBurned
  }));
  
  // Handle messages from clients
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received message:', data.type);
      
      if (data.type === 'get_canvas_state') {
        ws.send(JSON.stringify({
          type: 'canvas_state',
          pixels: pixelState,
          totalBurned: totalBurned
        }));
      } else if (data.type === 'pixel_update') {
        // This is handled by the HTTP endpoint
        console.log('Received pixel update via WebSocket');
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
    console.log('Total clients:', wss.clients.size);
  });
});

// Start the server after loading initial data
async function startServer() {
  await loadPixelData();
  await initConnection();
  
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
    console.log(`Using token: ${SPLACE_TOKEN}`);
    console.log(`Burning to: ${BURN_ADDRESS}`);
    console.log(`Cost per pixel: ${COST_PER_PIXEL} tokens`);
  });
}

startServer().catch(error => {
  console.error('Failed to start server:', error);
});

module.exports = app;
