const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { Connection, clusterApiUrl, PublicKey } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Constants
const PLACE_TOKEN_ADDRESS = 'EAJmFSndFCa429pQLKJyci3RyJcPDB5WoB1ENBovpump';
const TREASURY_ADDRESS = 'EVx4g9TLyQsH9pbvPYDe7tymsEpu7E6NfhfEE6bER96';
const COST_PER_PIXEL = 10000;
const CANVAS_SIZE = 1000;

// Initialize in-memory pixel storage (in production, use a database)
const pixelData = {};

// Initialize Solana connection
const connection = new Connection(clusterApiUrl('mainnet-beta'));

// Initialize all pixels to white
for (let y = 0; y < CANVAS_SIZE; y++) {
    for (let x = 0; x < CANVAS_SIZE; x++) {
        pixelData[`${x},${y}`] = '#ffffff';
    }
}

// WebSocket broadcast function
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Get current canvas state
app.get('/pixels', (req, res) => {
    res.json(pixelData);
});

// Check token balance
app.get('/balance/:address', async (req, res) => {
    try {
        const walletAddress = new PublicKey(req.params.address);
        const tokenMint = new PublicKey(PLACE_TOKEN_ADDRESS);
        
        const associatedTokenAddress = await getAssociatedTokenAddress(
            tokenMint,
            walletAddress,
            false,
            TOKEN_PROGRAM_ID
        );
        
        const tokenAccount = await getAccount(connection, associatedTokenAddress);
        const balance = Number(tokenAccount.amount);
        
        res.json({ balance, formatted: balance / Math.pow(10, 9) });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

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
        // Verify transaction signature
        // In production, you would verify the transaction on-chain
        // For demo purposes, we'll trust the client
        
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
});

module.exports = app;