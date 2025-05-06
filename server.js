const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { Connection, PublicKey, ComputeBudgetProgram } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const admin = require('firebase-admin');

// Initialize Firebase Admin (serverless-compatible)
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
    projectId: 'solplace-718d0',
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
// Add transaction cache to reduce RPC calls
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

// RPC Configuration with QuickNode
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'https://radial-chaotic-pool.solana-mainnet.quiknode.pro/192e8e76f0a288f5a32ace0b676f7f34778f219f/';
const RPC_FALLBACK = 'https://api.mainnet-beta.solana.com';

// In-memory cache for pixels and burned total
let pixelState = {};
let totalBurned = 0;
let connection = null;

// RPC connection with retries
async function initConnection() {
  try {
    console.log('Connecting to Solana QuickNode RPC:', RPC_ENDPOINT);
    connection = new Connection(RPC_ENDPOINT, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: false,
      httpHeaders: {
        'Content-Type': 'application/json',
      }
    });
    
    // Test connection with a quick call
    const version = await connection.getVersion();
    console.log('QuickNode RPC connection successful, version:', version);
    return connection;
  } catch (error) {
    console.error('QuickNode RPC connection error:', error);
    console.log('Falling back to public endpoint');
    
    // Create fallback connection
    try {
      connection = new Connection(RPC_FALLBACK, 'confirmed');
      const version = await connection.getVersion();
      console.log('Fallback connection successful, version:', version);
      return connection;
    } catch (fallbackError) {
      console.error('Even fallback connection failed:', fallbackError);
      throw new Error('Unable to establish RPC connection');
    }
  }
}

// Enhanced error logging for Firebase operations
function logFirebaseError(operation, error) {
  console.error(`Firebase ${operation} error:`, error);
  console.error(`Error code: ${error.code || 'N/A'}`);
  console.error(`Error message: ${error.message || 'N/A'}`);
  if (error.details) console.error(`Error details: ${error.details}`);
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
      console.log(`Loaded ${cacheSnapshot.size} transaction verification entries from cache`);
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
    
    totalBurned += amount;
    console.log(`Updated total burned: +${amount}, new total: ${totalBurned}`);
    return true;
  } catch (error) {
    logFirebaseError('update total burned', error);
    return false;
  }
}

// Cache transaction verification results
async function cacheTransaction(signature, isValid) {
  try {
    await transactionCache.doc(signature).set({
      signature,
      isValid,
      timestamp: Date.now()
    });
    
    console.log(`Cached transaction verification: ${signature} = ${isValid}`);
    return true;
  } catch (error) {
    console.error('Error caching transaction:', error);
    return false;
  }
}

// Check if transaction is already verified in cache
async function checkTransactionCache(signature) {
  try {
    const doc = await transactionCache.doc(signature).get();
    if (doc.exists) {
      const data = doc.data();
      console.log(`Found cached transaction: ${signature} = ${data.isValid}`);
      return { cached: true, isValid: data.isValid };
    }
    return { cached: false };
  } catch (error) {
    console.error('Error checking transaction cache:', error);
    return { cached: false };
  }
}

// Handle RPC errors with retry
async function withRetry(fn, maxRetries = 3, initialDelay = 1000) {
  let retries = 0;
  let delay = initialDelay;
  
  while (retries < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      if (error.message && (error.message.includes('429') || error.message.includes('Too many requests'))) {
        console.log(`Rate limit detected (${retries}/${maxRetries}), waiting for ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      } else if (retries < maxRetries) {
        console.error(`Error (${retries}/${maxRetries}), retrying:`, error.message);
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        throw error;
      }
    }
  }
}

// Verify transaction with retry logic and transaction caching
async function verifyTransaction(signature, expectedAmount, walletAddress) {
  try {
    console.log('Verifying transaction:', signature);
    
    // First check cache to avoid redundant RPC calls
    const cachedResult = await checkTransactionCache(signature);
    if (cachedResult.cached) {
      return cachedResult.isValid;
    }
    
    // If we hit a rate limit or other issue while fetching the transaction, fall back
    // to assuming the transaction is valid, especially for trusted wallets
    let transaction = null;
    
    try {
      transaction = await withRetry(async () => {
        return await connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });
      }, 3);
    } catch (error) {
      console.error('Failed to verify transaction after retries:', error.message);
      
      // Check if this wallet has a balance or has placed pixels before - if so, trust it
      try {
        const tokenMint = new PublicKey(SPLACE_TOKEN);
        const walletPubkey = new PublicKey(walletAddress);
        
        const associatedTokenAddress = await getAssociatedTokenAddress(
          tokenMint,
          walletPubkey,
          false,
          TOKEN_PROGRAM_ID
        );
        
        try {
          const tokenAccount = await connection.getAccountInfo(associatedTokenAddress);
          if (tokenAccount) {
            console.log('Wallet has token account, allowing pixel placement despite verification failure');
            await cacheTransaction(signature, true);
            return true;
          }
        } catch (accountError) {
          console.log('Error checking token account:', accountError.message);
        }
        
        // Check if wallet has placed pixels before
        const previousPixels = await pixelsCollection.where('wallet', '==', walletAddress).limit(1).get();
        if (!previousPixels.empty) {
          console.log('Wallet has placed valid pixels before, allowing placement');
          await cacheTransaction(signature, true);
          return true;
        }
      } catch (checkError) {
        console.error('Error validating wallet:', checkError.message);
      }
      
      // For development, trust anyway - REMOVE IN PRODUCTION
      console.log('DEVELOPMENT MODE: Allowing pixel placement despite verification failure');
      await cacheTransaction(signature, true);
      return true;
    }
    
    // If we found the transaction, verify it burned tokens
    if (transaction) {
      // Transaction found, extract token burn info
      try {
        if (transaction.meta && transaction.meta.preTokenBalances && transaction.meta.postTokenBalances) {
          const preBalance = transaction.meta.preTokenBalances || [];
          const postBalance = transaction.meta.postTokenBalances || [];
          
          // Find changes related to our token
          const tokenChanges = postBalance.filter(post => {
            const pre = preBalance.find(p => p.accountIndex === post.accountIndex);
            return pre && pre.mint === SPLACE_TOKEN && post.mint === SPLACE_TOKEN;
          });
          
          // Look for transfer to burn address
          for (const change of tokenChanges) {
            if (change.owner === BURN_ADDRESS) {
              const transferred = change.uiTokenAmount.amount - 
                (preBalance.find(p => p.accountIndex === change.accountIndex)?.uiTokenAmount.amount || 0);
              
              console.log('Tokens transferred to burn address:', transferred);
              
              if (transferred >= expectedAmount * Math.pow(10, TOKEN_DECIMALS)) {
                await cacheTransaction(signature, true);
                return true;
              }
            }
          }
        }
        
        // Couldn't find evidence of token burn
        console.log('Transaction verification failed - no valid token burn found');
        await cacheTransaction(signature, false);
        return false;
      } catch (parseError) {
        console.error('Error parsing transaction:', parseError.message);
        
        // In development mode, trust transactions even if we can't parse them
        console.log('DEVELOPMENT MODE: Allowing pixel placement despite parsing failure');
        await cacheTransaction(signature, true);
        return true;
      }
    }
    
    // No transaction found
    console.log('Transaction not found');
    await cacheTransaction(signature, false);
    return false;
  } catch (error) {
    console.error('Transaction verification error:', error);
    return false;
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

// Check $SPLACE token balance
app.get('/balance/:address', async (req, res) => {
  try {
    console.log('Balance requested for:', req.params.address);
    const walletAddress = new PublicKey(req.params.address);
    const tokenMint = new PublicKey(SPLACE_TOKEN);
    
    try {
      const associatedTokenAddress = await getAssociatedTokenAddress(
        tokenMint,
        walletAddress,
        false,
        TOKEN_PROGRAM_ID
      );
      
      const tokenAccount = await withRetry(async () => {
        return await connection.getAccountInfo(associatedTokenAddress);
      });
      
      if (tokenAccount) {
        const accountData = tokenAccount.data;
        // Get amount from SPL token account data structure (at offset 64)
        const dataView = new DataView(accountData.buffer, 64, 8);
        const amount = dataView.getBigUint64(0, true);
        
        console.log('Token balance:', amount);
        res.json({ balance: Number(amount), formatted: Number(amount) });
      } else {
        console.log('Token account not found');
        res.json({ balance: 0, formatted: 0 });
      }
    } catch (error) {
      console.error('Balance check error:', error);
      res.json({ balance: 0, formatted: 0 });
    }
  } catch (error) {
    console.error('Balance check error:', error);
    res.status(400).json({ error: error.message });
  }
});

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
    // Verify transaction
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
    
    // Save to Firebase - retry up to 3 times if needed
    let saveSuccess = false;
    let retries = 0;
    
    while (!saveSuccess && retries < 3) {
      try {
        // Use Promise.all to run both operations in parallel
        await Promise.all([
          savePixel(x, y, color, walletAddress, timestamp),
          updateTotalBurned(COST_PER_PIXEL)
        ]);
        saveSuccess = true;
      } catch (saveError) {
        retries++;
        console.error(`Firebase save error (attempt ${retries}/3):`, saveError);
        
        if (retries >= 3) {
          console.error('Failed to save to Firebase after 3 attempts');
          // Continue, we'll still send a response to the client
          break;
        }
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Broadcast update to all connected clients
    broadcast({
      type: 'pixel_update',
      x,
      y,
      color,
      walletAddress,
      timestamp
    });
    
    // Send success response regardless of Firebase save status
    // This is important - pixel is still valid even if Firebase has temporary issues
    res.json({ 
      success: true, 
      x, 
      y, 
      color,
      warning: !saveSuccess ? 'Pixel may not persist between server restarts due to database error' : undefined
    });
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
  try {
    connection = await initConnection();
    await loadPixelData();
    
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`WebSocket server is ready`);
      console.log(`Using token: ${SPLACE_TOKEN}`);
      console.log(`Burning to: ${BURN_ADDRESS}`);
      console.log(`Cost per pixel: ${COST_PER_PIXEL} tokens`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
