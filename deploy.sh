#!/bin/bash

# Voice Chatbot Deployment Script

echo "🚀 Deploying Voice Chatbot to Cloudflare Workers..."

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Wrangler CLI not found. Installing..."
    npm install -g wrangler
fi

# Login to Cloudflare (if not already logged in)
echo "🔑 Checking Cloudflare authentication..."
wrangler whoami || wrangler login

# Deploy the worker
echo "📦 Deploying worker..."
wrangler deploy

echo "✅ Deployment complete!"
echo "🌐 Your voice chatbot should now be available at your Cloudflare Workers domain"
echo ""
echo "📋 Next steps:"
echo "   1. Make sure you have Cloudflare AI enabled on your account"
echo "   2. Visit your worker URL to test the chatbot"
echo "   3. Grant microphone permissions when prompted"
echo ""
echo "🔧 To run locally for development:"
echo "   npm run dev"