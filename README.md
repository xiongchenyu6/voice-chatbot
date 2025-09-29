# Voice Chatbot with Cloudflare AI Workers

A realtime voice chatbot built with Cloudflare AI Workers and WebSockets, featuring:

- **ASR (Automatic Speech Recognition)**: `@cf/openai/whisper-tiny-en`
- **LLM (Large Language Model)**: `@cf/openai/gpt-oss-120b`
- **TTS (Text-to-Speech)**: `@cf/deepgram/aura-1`

## Features

- 🎤 **Voice Input**: Record audio directly in the browser
- 💬 **Text Input**: Type messages as an alternative to voice
- 🔊 **Audio Output**: Hear AI responses with adjustable volume
- ⚡ **Real-time**: WebSocket-based communication for instant responses
- 🌐 **Web-based**: No installation required, runs in any modern browser

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure Cloudflare**:
   - Make sure you have a Cloudflare account with Workers AI enabled
   - Update `wrangler.toml` with your account details if needed

3. **Development**:
   ```bash
   npm run dev
   ```

4. **Deploy**:
   ```bash
   npm run deploy
   ```

## How it Works

### Architecture

```
Browser (WebRTC Audio) 
    ↓ WebSocket
Cloudflare Worker (WebSocket Handler)
    ↓ Durable Object
Voice Processing Pipeline:
    1. Audio → ASR (Whisper) → Text
    2. Text → LLM (GPT) → Response
    3. Response → TTS (Aura) → Audio
    ↓ WebSocket
Browser (Audio Playback)
```

### AI Models Used

1. **Whisper Tiny EN** (`@cf/openai/whisper-tiny-en`)
   - Converts spoken audio to text
   - Optimized for English language
   - Fast processing for real-time applications

2. **GPT OSS 120B** (`@cf/openai/gpt-oss-120b`)
   - Generates conversational responses
   - Large context window for coherent conversations
   - Instruction-tuned for helpful responses

3. **Deepgram Aura** (`@cf/deepgram/aura-1`)
   - Converts text responses to natural speech
   - High-quality voice synthesis
   - Low latency for real-time conversations

### WebSocket Message Types

**Client → Server:**
```json
{
  "type": "audio",
  "audio": "base64-encoded-audio-data"
}
```

```json
{
  "type": "text", 
  "text": "user message"
}
```

**Server → Client:**
```json
{
  "type": "transcription",
  "text": "transcribed speech"
}
```

```json
{
  "type": "response",
  "text": "AI response"
}
```

```json
{
  "type": "audio",
  "audio": "base64-encoded-response-audio",
  "format": "wav"
}
```

```json
{
  "type": "status",
  "message": "Processing..."
}
```

## Usage

1. **Voice Chat**:
   - Click "Start Recording" button
   - Speak your message
   - Click "Stop Recording"
   - Wait for transcription, AI response, and audio playback

2. **Text Chat**:
   - Type your message in the input field
   - Press Enter or click Send
   - Wait for AI response and audio playback

3. **Volume Control**:
   - Use the volume slider to adjust audio response volume

## Browser Requirements

- Modern browser with WebSocket support
- Microphone access permission for voice input
- Audio playback capability

## Deployment Notes

- Uses Cloudflare Durable Objects for WebSocket session management
- Requires Cloudflare Workers AI binding
- All AI models run on Cloudflare's edge network for low latency

## Customization

### Modify AI Models

Update the model identifiers in `src/index.js`:

```javascript
// ASR Model
const transcriptionResult = await this.env.AI.run('@cf/openai/whisper-tiny-en', {
  audio: [...audioBuffer]
});

// LLM Model  
const chatResponse = await this.env.AI.run('@cf/openai/gpt-oss-120b', {
  messages: [...]
});

// TTS Model
const ttsResult = await this.env.AI.run('@cf/deepgram/aura-1', {
  text: responseText
});
```

### Adjust System Prompt

Modify the system message in the LLM call:

```javascript
messages: [
  { role: 'system', content: 'Your custom system prompt here' },
  { role: 'user', content: inputText }
]
```

### Styling

Update the CSS in the HTML template to customize the appearance.

## Troubleshooting

- **Microphone not working**: Check browser permissions
- **Audio not playing**: Ensure volume is up and browser allows autoplay
- **Connection issues**: Check Cloudflare Workers deployment status
- **AI model errors**: Verify Cloudflare AI is enabled on your account