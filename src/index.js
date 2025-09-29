export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (url.pathname === '/') {
      return new Response(HTML_CONTENT, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    if (url.pathname === '/websocket') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }

      const id = env.WEBSOCKET_HIBERNATION_SERVER.newUniqueId();
      const stub = env.WEBSOCKET_HIBERNATION_SERVER.get(id);
      
      return stub.fetch(request);
    }
    
    return new Response('Not found', { status: 404 });
  }
};

export class WebSocketHibernationServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws, message) {
    try {
      // Expect raw audio data or JSON with audio
      let audioBuffer;
      
      if (typeof message === 'string') {
        // JSON message with base64 audio
        const data = JSON.parse(message);
        if (data.type === 'audio' && data.audio) {
          audioBuffer = Uint8Array.from(atob(data.audio), c => c.charCodeAt(0));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Expected audio data' }));
          return;
        }
      } else {
        // Direct binary audio data
        audioBuffer = new Uint8Array(message);
      }
      
      await this.handleAudioInput(ws, audioBuffer);
      
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  }

  async handleAudioInput(ws, audioBuffer) {
    try {
      // Send processing status (optional - could remove for pure audio stream)
      ws.send(JSON.stringify({ type: 'status', message: 'Processing...' }));

      // ASR: Convert speech to text using Whisper
      const transcriptionResult = await this.env.AI.run('@cf/openai/whisper-tiny-en', {
        audio: [...audioBuffer]
      });

      const transcribedText = transcriptionResult.text || '';
      
      if (!transcribedText.trim()) {
        ws.send(JSON.stringify({ type: 'error', message: 'No speech detected' }));
        return;
      }

      // Process the transcribed text and respond with audio
      await this.processAndRespondWithAudio(ws, transcribedText);

    } catch (error) {
      console.error('Audio processing error:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Audio processing failed' }));
    }
  }

  async processAndRespondWithAudio(ws, inputText) {
    try {
      // LLM: Generate response using GPT
      const chatResponse = await this.env.AI.run('@cf/openai/gpt-oss-120b', {
        messages: [
          { role: 'system', content: 'You are a helpful AI voice assistant. Keep your responses concise, natural, and conversational for speech.' },
          { role: 'user', content: inputText }
        ],
        max_tokens: 256
      });

      const responseText = chatResponse.response || 'I apologize, but I could not generate a response.';

      // TTS: Convert response to speech
      const ttsResult = await this.env.AI.run('@cf/deepgram/aura-1', {
        text: responseText
      });

      // Send audio response directly
      if (ttsResult instanceof ArrayBuffer) {
        ws.send(ttsResult);
      } else {
        // Fallback: send as base64 JSON
        const audioArray = new Uint8Array(ttsResult);
        const audioBase64 = btoa(String.fromCharCode(...audioArray));
        ws.send(JSON.stringify({ 
          type: 'audio', 
          audio: audioBase64
        }));
      }

    } catch (error) {
      console.error('Response generation error:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to generate response' }));
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    console.log('WebSocket closed:', code, reason, wasClean);
  }

  webSocketError(ws, error) {
    console.error('WebSocket error:', error);
  }
}

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Voice Chatbot</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background-color: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .chat-area {
            height: 400px;
            overflow-y: auto;
            border: 1px solid #ddd;
            padding: 15px;
            margin: 20px 0;
            background-color: #fafafa;
            border-radius: 5px;
        }
        .message {
            margin: 10px 0;
            padding: 10px;
            border-radius: 5px;
        }
        .user-message {
            background-color: #007bff;
            color: white;
            margin-left: 50px;
        }
        .bot-message {
            background-color: #e9ecef;
            color: #333;
            margin-right: 50px;
        }
        .status-message {
            background-color: #fff3cd;
            color: #856404;
            font-style: italic;
            text-align: center;
        }
        .error-message {
            background-color: #f8d7da;
            color: #721c24;
            text-align: center;
        }
        .controls {
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
        }
        button {
            padding: 12px 24px;
            font-size: 16px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            transition: background-color 0.3s;
        }
        .record-btn {
            background-color: #28a745;
            color: white;
        }
        .record-btn:hover {
            background-color: #218838;
        }
        .record-btn.recording {
            background-color: #dc3545;
            animation: pulse 1s infinite;
        }
        .record-btn.recording:hover {
            background-color: #c82333;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.7; }
            100% { opacity: 1; }
        }
        .text-input {
            flex: 1;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 5px;
            font-size: 16px;
        }
        .send-btn {
            background-color: #007bff;
            color: white;
        }
        .send-btn:hover {
            background-color: #0056b3;
        }
        .volume-control {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .volume-slider {
            width: 100px;
        }
        .connection-status {
            padding: 10px;
            border-radius: 5px;
            margin-bottom: 20px;
            text-align: center;
            font-weight: bold;
        }
        .connected {
            background-color: #d4edda;
            color: #155724;
        }
        .disconnected {
            background-color: #f8d7da;
            color: #721c24;
        }
        .connecting {
            background-color: #fff3cd;
            color: #856404;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎤 Voice Chatbot</h1>
        <p>Powered by Cloudflare AI Workers - Speak or type to chat!</p>
        
        <div id="connectionStatus" class="connection-status connecting">Connecting...</div>
        
        <div id="chatArea" class="chat-area"></div>
        
        <div class="controls">
            <button id="recordBtn" class="record-btn">🎤 Start Recording</button>
        </div>
        
        <div class="volume-control">
            <label for="volumeSlider">🔊 Volume:</label>
            <input type="range" id="volumeSlider" class="volume-slider" min="0" max="1" step="0.1" value="0.8">
            <span id="volumeValue">80%</span>
        </div>
    </div>

    <script>
        class VoiceChatbot {
            constructor() {
                this.ws = null;
                this.mediaRecorder = null;
                this.audioChunks = [];
                this.isRecording = false;
                this.audioContext = null;
                this.volume = 0.8;
                
                this.initializeElements();
                this.initializeWebSocket();
                this.initializeEventListeners();
            }

            initializeElements() {
                this.chatArea = document.getElementById('chatArea');
                this.recordBtn = document.getElementById('recordBtn');
                this.volumeSlider = document.getElementById('volumeSlider');
                this.volumeValue = document.getElementById('volumeValue');
                this.connectionStatus = document.getElementById('connectionStatus');
            }

            initializeWebSocket() {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = \`\${protocol}//\${window.location.host}/websocket\`;
                
                this.ws = new WebSocket(wsUrl);
                
                this.ws.onopen = () => {
                    this.updateConnectionStatus('connected', 'Connected');
                    this.addMessage('system', 'Connected! Press and hold the microphone to speak.');
                };
                
                this.ws.onmessage = (event) => {
                    if (event.data instanceof ArrayBuffer) {
                        this.handleWebSocketMessage(event.data);
                    } else {
                        this.handleWebSocketMessage(event.data);
                    }
                };
                
                this.ws.onclose = () => {
                    this.updateConnectionStatus('disconnected', 'Disconnected');
                    this.addMessage('system', 'Connection lost. Please refresh the page.');
                };
                
                this.ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                    this.updateConnectionStatus('disconnected', 'Connection Error');
                };
            }

            initializeEventListeners() {
                this.recordBtn.addEventListener('click', () => this.toggleRecording());
                this.volumeSlider.addEventListener('input', (e) => {
                    this.volume = parseFloat(e.target.value);
                    this.volumeValue.textContent = Math.round(this.volume * 100) + '%';
                });
            }

            updateConnectionStatus(status, text) {
                this.connectionStatus.className = \`connection-status \${status}\`;
                this.connectionStatus.textContent = text;
            }

            async toggleRecording() {
                if (this.isRecording) {
                    this.stopRecording();
                } else {
                    await this.startRecording();
                }
            }

            async startRecording() {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    
                    this.mediaRecorder = new MediaRecorder(stream, {
                        mimeType: 'audio/webm;codecs=opus'
                    });
                    
                    this.audioChunks = [];
                    
                    this.mediaRecorder.ondataavailable = (event) => {
                        if (event.data.size > 0) {
                            this.audioChunks.push(event.data);
                        }
                    };
                    
                    this.mediaRecorder.onstop = () => {
                        this.processRecording();
                    };
                    
                    this.mediaRecorder.start();
                    this.isRecording = true;
                    this.recordBtn.textContent = '🛑 Stop Recording';
                    this.recordBtn.classList.add('recording');
                    
                } catch (error) {
                    console.error('Error starting recording:', error);
                    this.addMessage('error', 'Could not access microphone. Please check permissions.');
                }
            }

            stopRecording() {
                if (this.mediaRecorder && this.isRecording) {
                    this.mediaRecorder.stop();
                    this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
                    this.isRecording = false;
                    this.recordBtn.textContent = '🎤 Start Recording';
                    this.recordBtn.classList.remove('recording');
                }
            }

            async processRecording() {
                if (this.audioChunks.length === 0) return;

                const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm;codecs=opus' });
                
                // Convert to base64
                const reader = new FileReader();
                reader.onload = () => {
                    const base64Audio = reader.result.split(',')[1];
                    this.sendAudioMessage(base64Audio);
                };
                reader.readAsDataURL(audioBlob);
            }

            sendAudioMessage(audioBase64) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.addMessage('user', '🎤 [Speaking...]');
                    
                    // Send as binary or JSON - try binary first for efficiency
                    try {
                        const binaryString = atob(audioBase64);
                        const bytes = new Uint8Array(binaryString.length);
                        for (let i = 0; i < binaryString.length; i++) {
                            bytes[i] = binaryString.charCodeAt(i);
                        }
                        this.ws.send(bytes.buffer);
                    } catch (error) {
                        // Fallback to JSON
                        this.ws.send(JSON.stringify({
                            type: 'audio',
                            audio: audioBase64
                        }));
                    }
                }
            }

            handleWebSocketMessage(data) {
                // Handle both binary audio and JSON messages
                if (data instanceof ArrayBuffer) {
                    this.playBinaryAudio(data);
                    this.addMessage('bot', '🔊 [AI Response]');
                    return;
                }
                
                // Parse JSON messages
                const message = typeof data === 'string' ? JSON.parse(data) : data;
                
                switch (message.type) {
                    case 'audio':
                        this.playAudio(message.audio);
                        this.addMessage('bot', '🔊 [AI Response]');
                        break;
                    case 'status':
                        this.addMessage('status', message.message);
                        break;
                    case 'error':
                        this.addMessage('error', message.message);
                        break;
                }
            }

            async playBinaryAudio(audioBuffer) {
                try {
                    if (!this.audioContext) {
                        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    }

                    // Decode and play binary audio
                    const decodedBuffer = await this.audioContext.decodeAudioData(audioBuffer);
                    const source = this.audioContext.createBufferSource();
                    const gainNode = this.audioContext.createGain();
                    
                    gainNode.gain.value = this.volume;
                    source.buffer = decodedBuffer;
                    source.connect(gainNode);
                    gainNode.connect(this.audioContext.destination);
                    source.start();
                    
                } catch (error) {
                    console.error('Binary audio playback error:', error);
                    this.addMessage('error', 'Could not play audio response');
                }
            }

            async playAudio(audioBase64) {
                try {
                    if (!this.audioContext) {
                        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    }

                    // Convert base64 to ArrayBuffer
                    const binaryString = atob(audioBase64);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }

                    // Decode and play audio
                    const audioBuffer = await this.audioContext.decodeAudioData(bytes.buffer);
                    const source = this.audioContext.createBufferSource();
                    const gainNode = this.audioContext.createGain();
                    
                    gainNode.gain.value = this.volume;
                    source.buffer = audioBuffer;
                    source.connect(gainNode);
                    gainNode.connect(this.audioContext.destination);
                    source.start();
                    
                } catch (error) {
                    console.error('Audio playback error:', error);
                    this.addMessage('error', 'Could not play audio response');
                }
            }

            addMessage(type, content) {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message';
                
                switch (type) {
                    case 'user':
                        messageDiv.className += ' user-message';
                        messageDiv.textContent = content;
                        break;
                    case 'bot':
                        messageDiv.className += ' bot-message';
                        messageDiv.textContent = content;
                        break;
                    case 'status':
                        messageDiv.className += ' status-message';
                        messageDiv.textContent = '⏳ ' + content;
                        break;
                    case 'error':
                        messageDiv.className += ' error-message';
                        messageDiv.textContent = '❌ ' + content;
                        break;
                    case 'system':
                        messageDiv.className += ' status-message';
                        messageDiv.textContent = '💡 ' + content;
                        break;
                }
                
                this.chatArea.appendChild(messageDiv);
                this.chatArea.scrollTop = this.chatArea.scrollHeight;
            }
        }

        // Initialize the chatbot when the page loads
        document.addEventListener('DOMContentLoaded', () => {
            new VoiceChatbot();
        });
    </script>
</body>
</html>
`;