#!/usr/bin/env bash

# Voice Chatbot Setup Validation Script

echo "🔍 Validating Voice Chatbot Setup..."

# Check if all required files exist
FILES=("wrangler.toml" "package.json" "src/index.js" "README.md" ".gitignore")

for file in "${FILES[@]}"; do
    if [[ -f "$file" ]]; then
        echo "✅ $file exists"
    else
        echo "❌ $file missing"
        exit 1
    fi
done

# Validate wrangler.toml structure
echo "🔧 Checking wrangler.toml configuration..."

if grep -q "WEBSOCKET_HIBERNATION_SERVER" wrangler.toml; then
    echo "✅ Durable Object binding configured"
else
    echo "❌ Missing Durable Object binding"
    exit 1
fi

if grep -q '\[ai\]' wrangler.toml; then
    echo "✅ AI binding configured"
else
    echo "❌ Missing AI binding"
    exit 1
fi

# Validate main worker file
echo "📝 Checking main worker file..."

if grep -q "WebSocketHibernationServer" src/index.js; then
    echo "✅ Durable Object class found"
else
    echo "❌ Missing Durable Object class"
    exit 1
fi

# Check for AI model usage
AI_MODELS=(
    "@cf/openai/whisper-large-v3-turbo"
    "@cf/zai-org/glm-4.7-flash"
    "@cf/deepgram/aura-2-en"
    "@cf/myshell-ai/melotts"
    "@cf/pipecat-ai/smart-turn-v2"
)

for model in "${AI_MODELS[@]}"; do
    if grep -q "$model" src/index.js; then
        echo "✅ $model integration found"
    else
        echo "❌ Missing $model integration"
        exit 1
    fi
done

echo ""
echo "🎉 All checks passed! Your voice chatbot setup is ready."
echo ""
echo "📋 Next steps:"
echo "   1. Install dependencies: npm install"
echo "   2. Test locally: npm run dev"
echo "   3. Deploy: ./deploy.sh or npm run deploy"
echo ""
echo "ℹ️  Make sure you have:"
echo "   - Cloudflare account with Workers AI enabled"
echo "   - Wrangler CLI installed and authenticated"
echo "   - Modern browser with microphone access"
