# Place Clone - Pixel Art Canvas

A website similar to Reddit's r/place where users can change pixels by paying $PLACE tokens through Phantom wallet.

## Files Structure

- `index.html` - Frontend application
- `server.js` - Backend server
- `package.json` - Node.js dependencies

## Quick Start Guide

### Step 1: Set Up the Backend on Heroku

1. **Create a Heroku account** at [heroku.com](https://heroku.com)

2. **Install Heroku CLI**:
   ```bash
   # For macOS:
   brew tap heroku/brew && brew install heroku
   
   # For Windows:
   # Download and install from https://devcenter.heroku.com/articles/heroku-cli
   ```

3. **Deploy the backend**:
   ```bash
   # Login to Heroku
   heroku login
   
   # Create a new app
   heroku create place-clone-backend
   
   # Add files to Git
   git init
   git add server.js package.json
   git commit -m "Initial commit"
   
   # Deploy to Heroku
   git push heroku main
   
   # Your backend will be live at https://place-clone-backend.herokuapp.com
   ```

### Step 2: Deploy Frontend on Vercel

1. **Create a Vercel account** at [vercel.com](https://vercel.com)

2. **Install Vercel CLI**:
   ```bash
   npm i -g vercel
   ```

3. **Deploy the frontend**:
   ```bash
   # Login to Vercel
   vercel login
   
   # Create a vercel.json file in your project:
   echo '{"version": 2}' > vercel.json
   
   # Deploy
   vercel
   
   # Follow the prompts and select:
   # - Project name: place-clone
   # - No to framework detection
   # - Keep default settings
   ```

### Step 3: Update Frontend with Backend URL

After deploying the backend, update the `index.html` file:

1. Replace all instances of `localhost:3000` with your Heroku backend URL:
   - Change `ws://localhost:3000` to `wss://place-clone-backend.herokuapp.com`
   - Change `http://localhost:3000` to `https://place-clone-backend.herokuapp.com`

2. Update the API calls in the JavaScript section:
   ```javascript
   const API_URL = 'https://place-clone-backend.herokuapp.com';
   const WS_URL = 'wss://place-clone-backend.herokuapp.com';
   ```

3. Redeploy the frontend:
   ```bash
   vercel
   ```

## How It Works

1. **Connect Wallet**: Users click "Connect Phantom Wallet" to connect their Solana wallet
2. **Select Pixel**: Click on any pixel in the canvas to select it
3. **Choose Color**: Use the color picker to choose a color
4. **Pay & Place**: Click "Place Pixel" to pay 10,000 $PLACE tokens and update the pixel
5. **Real-time Updates**: All users see pixel changes in real-time via WebSocket

## Important Notes

- The backend stores pixels in memory. For production, use a database (MongoDB, PostgreSQL)
- Add proper error handling and security measures
- For better performance, implement caching and rate limiting
- The transaction verification is simplified - implement proper Solana transaction verification

## Token Information

- Token Address: `EAJmFSndFCa429pQLKJyci3RyJcPDB5WoB1ENBovpump`
- Treasury Address: `EVx4g9TLyQsH9pbvPYDe7tymsEpu7E6NfhfEE6bER96`
- Cost per pixel: 10,000 $PLACE tokens

## Troubleshooting

1. **Phantom wallet not connecting**: Make sure you have Phantom extension installed
2. **Transactions failing**: Check token balance and approval permissions
3. **Canvas not updating**: Check WebSocket connection and browser console for errors

## License

MIT