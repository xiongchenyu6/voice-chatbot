# 🎤 Voice Chatbot - Quick Start Guide

## What You Built

A **realtime voice chatbot** running on **Cloudflare AI Workers** with these AI models:

- **🎤 ASR**: `@cf/openai/whisper-large-v3-turbo` (Speech-to-Text)
- **🧠 LLM**: `@cf/zai-org/glm-4.7-flash` (Chat Responses) 
- **🔊 TTS**: Aura 2 plus MeloTTS (language-aware speech output)

## 🚀 Quick Start

### 1. Prerequisites
```bash
# Install Wrangler CLI globally
npm install -g wrangler

# Login to Cloudflare
wrangler login
```

### 2. Development
```bash
# Start local development server
npm run dev

# Or use wrangler directly
wrangler dev
```

### 3. Deploy
```bash
# Deploy to Cloudflare Workers
npm run deploy

# Or use the deployment script
./deploy.sh
```

## 🌐 Usage

1. **Open the deployed URL** in your browser
2. **Grant microphone permissions** when prompted
3. **Voice Chat**: Click "Start Recording" → Speak → Click "Stop Recording"
4. **Text Chat**: Type in the input field and press Enter
5. **Adjust Volume**: Use the volume slider for audio responses

## 🏗️ Architecture

```
Browser Audio → WebSocket → Cloudflare Worker → Durable Object
                                    ↓
Audio → Whisper → Text → GLM → Response → Language-aware TTS → Audio
                                    ↓
Browser Audio ← WebSocket ← Cloudflare Worker ← Durable Object
```

## 📁 Project Structure

```
voice-chatbot/
├── src/
│   └── index.js          # Main worker with WebSocket handling
├── wrangler.toml         # Cloudflare configuration
├── package.json          # Dependencies and scripts
├── README.md             # Detailed documentation
├── deploy.sh            # Deployment script
├── validate.sh          # Setup validation
└── QUICKSTART.md        # This file
```

## 🔧 Key Features

- **Real-time WebSocket communication**
- **Voice recording with browser MediaRecorder API**
- **Audio processing with Web Audio API**
- **Durable Objects for session management**
- **Three AI models integrated seamlessly**
- **Responsive web interface**
- **Error handling and status updates**

## 🎯 AI Model Details

### Whisper Large V3 Turbo (`@cf/openai/whisper-large-v3-turbo`)
- Converts recorded audio to text
- Handles multilingual speech more reliably
- Better fit for mixed-language voice chat

### GLM 4.7 Flash (`@cf/zai-org/glm-4.7-flash`)
- Generates conversational responses
- Optimized for multilingual dialogue
- Faster response profile for voice interactions

### Aura 2 + MeloTTS
- Uses Aura 2 for high-quality English and Spanish speech
- Uses MeloTTS for supported multilingual fallback voices
- Keeps spoken output closer to the user's language

## 🛠️ Customization

### Change AI Models
Edit `src/index.js` and replace model identifiers:

```javascript
// ASR
await this.env.AI.run('@cf/openai/whisper-large-v3-turbo', {...});

// LLM
await this.env.AI.run('@cf/zai-org/glm-4.7-flash', {...});

// TTS
await this.env.AI.run('@cf/deepgram/aura-2-en', {...});
```

### Modify System Prompt
Update the LLM system message:

```javascript
messages: [
  { role: 'system', content: 'Your custom prompt here' },
  { role: 'user', content: inputText }
]
```

### Styling
Update CSS in the HTML template within `src/index.js`.

## 🔍 Troubleshooting

- **Microphone not working**: Check browser permissions
- **Audio not playing**: Ensure volume is up, check autoplay policy
- **Connection issues**: Verify Cloudflare Workers deployment
- **AI errors**: Ensure Cloudflare AI is enabled on your account

## 📊 Monitoring

Use Cloudflare Workers dashboard to monitor:
- Request volume
- Error rates
- AI model usage
- Durable Object invocations

## 💡 Next Steps

- Add conversation history
- Implement user authentication
- Add more AI models
- Support multiple languages
- Add conversation summaries
- Integrate with external APIs

## 🤝 Support

For issues or questions:
1. Check Cloudflare Workers documentation
2. Review AI model documentation
3. Test with browser developer tools
4. Check Cloudflare dashboard logs

---

**🎉 Your voice chatbot is ready to use!**
