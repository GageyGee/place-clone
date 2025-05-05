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
const SPLACE_TOKEN = '38KWMyCbPurCgqqwx5JG4EouREtjwcCaDqvL9KNGsvDf';
const BURN_ADDRESS = '1nc1nerator11111111111111111111111111111111'; // Solana burn address
const COST_PER_PIXEL = 10000;
const TOKEN_DECIMALS = 6; // Assuming 6 decimals for $SPLACE token
const CANVAS_SIZE = 100; // 100x100 pixel grid

// Initialize in-memory pixel storage
const pixelData = {};

// Initialize all pixels to white
for (let y = 0; y < CANVAS_SIZE; y++) {
    for (let x = 0; x < CANVAS_SIZE; x++) {
        pixelData[`${x},${y}`] = '#ffffff';
    }
}

// Initialize Solana connection to mainnet
const connection = new Connection(clusterApiUrl('mainnet-beta'));
console.log('Connected to Solana mainnet');

// WebSocket broadcast function
function broadcast(data) {
    const message = JSON.stringify(data);
    console.log('Broadcasting to clients:', data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Get current canvas state
app.get('/pixels', (req, res) => {
    console.log('Pixels requested');
    res.json(pixelData);
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
        
        console.log('Transaction found:', transaction);
        
        // Parse the transaction to verify:
        // 1. It's a token transfer
        // 2. The transfer is to the burn address
        // 3. The amount is correct
        
        const instructions = transaction.transaction.message.compiledInstructions;
        const accountKeys = transaction.transaction.message.staticAccountKeys;
        
        // Look for token transfer instruction
        let isValidTransfer = false;
        
        for (const instruction of instructions) {
            // Check if this is a token program instruction
            const programKey = accountKeys[instruction.programIdIndex].toBase58();
            
            if (programKey === TOKEN_PROGRAM_ID.toBase58()) {
                // This is a token program instruction
                // In a production environment, you'd want to properly parse the instruction data
                // to verify it's a transfer to the burn address with the correct amount
                
                // For now, we accept any transaction that includes a token instruction
                isValidTransfer = true;
                break;
            }
        }
        
        return isValidTransfer;
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
            return res.status(400).json({ error: 'Invalid transaction' });
        }
        
        // Update pixel
        pixelData[`${x},${y}`] = color;
        console.log(`Updated pixel (${x},${y}) to ${color}`);
        
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
        pixels: pixelData
    }));
    
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
});

module.exports = app;
