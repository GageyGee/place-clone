const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { Connection, clusterApiUrl, PublicKey } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { MongoClient } = require('mongodb');

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

// MongoDB connection string - Replace with your MongoDB connection string
// For example: mongodb+srv://username:password@cluster.mongodb.net/solplace
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/solplace';
let db;
let pixelCollection;
let statsCollection;

// In-memory cache for pixels and total burned
let pixelState = {};
let totalBurned = 0;

// Initialize MongoDB connection
async function connectToDatabase() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        console.log('Connected to MongoDB');
        
        db = client.db();
        pixelCollection = db.collection('pixels');
        statsCollection = db.collection('stats');
        
        // Load initial data
        await loadPixelData();
    } catch (error) {
        console.error('MongoDB connection error:', error);
        console.log('Starting with empty canvas as fallback');
        initializeEmptyCanvas();
    }
}

// Load pixel data from MongoDB
async function loadPixelData() {
    try {
        // Load all pixels
        const pixels = await pixelCollection.find({}).toArray();
        
        console.log(`Loaded ${pixels.length} pixels from database`);
        
        // Convert array to object with coordinates as keys
        pixelState = {};
        for (const pixel of pixels) {
            const key = `${pixel.x},${pixel.y}`;
            pixelState[key] = {
                color: pixel.color,
                wallet: pixel.wallet,
                timestamp: pixel.timestamp
            };
        }
        
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
        
        // Load total burned tokens
        const stats = await statsCollection.findOne({ type: 'global' });
        if (stats) {
            totalBurned = stats.totalBurned || 0;
            console.log(`Loaded total burned: ${totalBurned}`);
        } else {
            // Initialize stats if not exist
            await statsCollection.insertOne({
                type: 'global',
                totalBurned: 0,
                lastUpdate: Date.now()
            });
        }
    } catch (error) {
        console.error('Error loading pixel data from database:', error);
        initializeEmptyCanvas();
    }
}

// Initialize empty canvas with white pixels
function initializeEmptyCanvas() {
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

// Save pixel data to MongoDB
async function savePixel(x, y, color, wallet, timestamp) {
    try {
        const key = `${x},${y}`;
        
        // Update or insert the pixel in MongoDB
        await pixelCollection.updateOne(
            { x, y },
            {
                $set: {
                    x,
                    y,
                    color,
                    wallet,
                    timestamp
                }
            },
            { upsert: true }
        );
        
        console.log(`Saved pixel at (${x},${y}) to database`);
        return true;
    } catch (error) {
        console.error('Error saving pixel to database:', error);
        return false;
    }
}

// Update the total burned tokens in database
async function updateTotalBurned(amount) {
    try {
        await statsCollection.updateOne(
            { type: 'global' },
            {
                $inc: { totalBurned: amount },
                $set: { lastUpdate: Date.now() }
            },
            { upsert: true }
        );
        
        console.log(`Updated total burned: +${amount}, new total: ${totalBurned}`);
        return true;
    } catch (error) {
        console.error('Error updating total burned:', error);
        return false;
    }
}

// Initialize Solana connection to mainnet
const connection = new Connection(clusterApiUrl('mainnet-beta'));
console.log('Connected to Solana mainnet');

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

// Verify transaction
async function verifyTransaction(signature, expectedAmount) {
    try {
        console.log('Verifying transaction:', signature);
        
        // Get transaction details with commitment level
        const transaction = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });
        
        if (!transaction) {
            console.log('Transaction not found');
            return false;
        }
        
        console.log('Transaction found');
        
        // Verify this transaction includes a token transfer to the burn address
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
                        return true;
                    }
                }
            }
        }
        
        console.log('Transaction verification failed - no valid token burn found');
        return false;
    } catch (error) {
        console.error('Transaction verification error:', error);
        return false;
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
        // Verify transaction
        const isValid = await verifyTransaction(signature, COST_PER_PIXEL);
        
        if (!isValid) {
            console.log('Transaction verification failed');
            return res.status(400).json({ error: 'Invalid transaction or insufficient token burn' });
        }
        
        const timestamp = Date.now();
        
        // Update pixel with complete information in memory
        pixelState[`${x},${y}`] = {
            color: color,
            wallet: walletAddress,
            timestamp: timestamp
        };
        
        console.log(`Updated pixel (${x},${y}) to ${color} by ${walletAddress}`);
        
        // Update burned total
        totalBurned += COST_PER_PIXEL;
        
        // Save to database
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

// Start the server after connecting to the database
async function startServer() {
    await connectToDatabase();
    
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
