const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Connection, clusterApiUrl, PublicKey } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

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

// Path for persistent storage
const DATA_FILE = path.join(__dirname, 'pixel_data.json');
const BACKUP_FILE = path.join(__dirname, 'pixel_data_backup.json');

// Initialize in-memory pixel storage
let pixelData = {};
let totalBurned = 0;

// Load pixel data from file if it exists
function loadPixelData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            pixelData = data.pixels || {};
            totalBurned = data.totalBurned || 0;
            console.log(`Loaded ${Object.keys(pixelData).length} pixels from storage`);
            console.log(`Loaded total burned: ${totalBurned}`);
            
            // Fill in any missing pixels with white
            for (let y = 0; y < CANVAS_SIZE; y++) {
                for (let x = 0; x < CANVAS_SIZE; x++) {
                    const key = `${x},${y}`;
                    if (!pixelData[key]) {
                        pixelData[key] = {
                            color: '#ffffff',
                            wallet: null,
                            timestamp: Date.now()
                        };
                    }
                }
            }
        } else {
            console.log('No pixel data file found, initializing with default values');
            initializeEmptyCanvas();
        }
    } catch (error) {
        console.error('Error loading pixel data:', error);
        console.log('Initializing with default values');
        initializeEmptyCanvas();
        
        // Try to load from backup
        try {
            if (fs.existsSync(BACKUP_FILE)) {
                const backupData = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
                pixelData = backupData.pixels || {};
                totalBurned = backupData.totalBurned || 0;
                console.log(`Restored ${Object.keys(pixelData).length} pixels from backup`);
            }
        } catch (backupError) {
            console.error('Error loading backup data:', backupError);
        }
    }
}

// Initialize empty canvas with white pixels
function initializeEmptyCanvas() {
    pixelData = {};
    totalBurned = 0;
    
    for (let y = 0; y < CANVAS_SIZE; y++) {
        for (let x = 0; x < CANVAS_SIZE; x++) {
            pixelData[`${x},${y}`] = {
                color: '#ffffff',
                wallet: null,
                timestamp: Date.now()
            };
        }
    }
}

// Save pixel data to file
function savePixelData() {
    try {
        // Create a backup of the current file if it exists
        if (fs.existsSync(DATA_FILE)) {
            fs.copyFileSync(DATA_FILE, BACKUP_FILE);
        }
        
        // Save the current state
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            pixels: pixelData,
            totalBurned: totalBurned,
            lastUpdate: Date.now()
        }, null, 2));
        
        console.log('Pixel data saved to file');
    } catch (error) {
        console.error('Error saving pixel data:', error);
    }
}

// Set up auto-save every 5 minutes
const SAVE_INTERVAL = 5 * 60 * 1000; // 5 minutes
setInterval(savePixelData, SAVE_INTERVAL);

// Initialize Solana connection to mainnet
const connection = new Connection(clusterApiUrl('mainnet-beta'));
console.log('Connected to Solana mainnet');

// Load pixel data on startup
loadPixelData();

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
        pixels: pixelData,
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
        
        console.log('Transaction found, details:', transaction);
        
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
            
            console.log('Token changes found:', tokenChanges);
            
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
        
        // Update pixel with complete information
        pixelData[`${x},${y}`] = {
            color: color,
            wallet: walletAddress,
            timestamp: Date.now()
        };
        
        console.log(`Updated pixel (${x},${y}) to ${color} by ${walletAddress}`);
        
        // Update burned total
        totalBurned += COST_PER_PIXEL;
        
        // Save data immediately after a change
        savePixelData();
        
        // Broadcast update to all connected clients
        broadcast({
            type: 'pixel_update',
            x,
            y,
            color,
            walletAddress,
            timestamp: Date.now()
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
        pixels: pixelData,
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
                    pixels: pixelData,
                    totalBurned: totalBurned
                }));
            } else if (data.type === 'pixel_update') {
                // This is already handled by the HTTP endpoint
                // but we could add direct WebSocket updates for testing
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
    console.log(`Using token: ${SPLACE_TOKEN}`);
    console.log(`Burning to: ${BURN_ADDRESS}`);
    console.log(`Cost per pixel: ${COST_PER_PIXEL} tokens`);
});

// Graceful shutdown - save data before exiting
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    savePixelData();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Shutting down server...');
    savePixelData();
    process.exit(0);
});

module.exports = app;
