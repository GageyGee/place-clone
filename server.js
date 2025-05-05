const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { Connection, clusterApiUrl, PublicKey } = require('@solana/web3.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Constants
const TREASURY_ADDRESS = 'YOUR_TREASURY_WALLET_ADDRESS'; // Replace with your devnet wallet
const COST_PER_PIXEL_LAMPORTS = 0.01 * 1e9; // 0.01 SOL
const CANVAS_SIZE = 100; // 100x100 pixel grid

// Initialize in-memory pixel storage
const pixelData = {};

// Initialize all pixels to white
for (let y = 0; y < CANVAS_SIZE; y++) {
    for (let x = 0; x < CANVAS_SIZE; x++) {
        pixelData[`${x},${y}`] = '#ffffff';
    }
}

// Initialize Solana connection to devnet
const connection = new Connection(clusterApiUrl('devnet'));

// WebSocket broadcast function
function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Get current canvas state
app.get('/pixels', (req, res) => {
    res.json(pixelData);
});

// Check SOL balance
app.get('/balance/:address', async (req, res) => {
    try {
        const walletAddress = new PublicKey(req.params.address);
        const balance = await connection.getBalance(walletAddress);
        const solBalance = balance / 1e9; // Convert lamports to SOL
        
        res.json({ balance, formatted: solBalance });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Verify transaction
async function verifyTransaction(signature, expectedAmount) {
    try {
        const transaction = await connection.getTransaction(signature, {
            commitment: 'confirmed'
        });
        
        if (!transaction) {
            throw new Error('Transaction not found');
        }
        
        // Verify transaction details
        const postBalance = transaction.meta.postBalances[1]; // Treasury account
        const preBalance = transaction.meta.preBalances[1];
        const receivedAmount = postBalance - preBalance;
        
        return receivedAmount >= expectedAmount;
    } catch (error) {
        console.error('Transaction verification error:', error);
        return false;
    }
}

// Place pixel endpoint
app.post('/place-pixel', async (req, res) => {
    const { x, y, color, signature, walletAddress } = req.body;
    
    // Validate pixel coordinates
    if (x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE) {
        return res.status(400).json({ error: 'Invalid pixel coordinates' });
    }
    
    // Validate color format
    if (!/^#[0-9A-F]{6}$/i.test(color)) {
        return res.status(400).json({ error: 'Invalid color format' });
    }
    
    try {
        // Verify transaction
        const isValid = await verifyTransaction(signature, COST_PER_PIXEL_LAMPORTS);
        
        if (!isValid) {
            return res.status(400).json({ error: 'Invalid transaction' });
        }
        
        // Update pixel
        pixelData[`${x},${y}`] = color;
        
        // Broadcast update to all connected clients
        broadcast({
            type: 'pixel_update',
            x,
            y,
            color,
            timestamp: Date.now()
        });
        
        res.json({ success: true, x, y, color });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');
    
    // Send initial canvas state
    ws.send(JSON.stringify({
        type: 'canvas_state',
        pixels: pixelData
    }));
    
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
});

module.exports = app;
