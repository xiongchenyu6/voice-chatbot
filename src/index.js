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
      // Handle different message types
      if (typeof message === 'string') {
        // JSON message with different types
        const data = JSON.parse(message);
        
        if (data.type === 'turn_detection') {
          await this.handleTurnDetection(ws, data);
          return;
        } else if (data.type === 'audio_processing') {
          // Process complete audio for ASR - convert base64 back to proper audio format
          console.log('Received audio_processing request, base64 length:', data.audio.length);
          
          try {
            // Decode base64 to get the 16-bit PCM data
            const binaryString = atob(data.audio);
            const audioBytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              audioBytes[i] = binaryString.charCodeAt(i);
            }
            
            console.log('Decoded audio bytes length:', audioBytes.length);
            
            // Convert back to Int16Array (since we encoded 16-bit PCM)
            const pcm16Array = new Int16Array(audioBytes.buffer);
            console.log('PCM16 samples count:', pcm16Array.length);
            
            // Convert 16-bit PCM back to Float32 for Whisper (-1.0 to 1.0 range)
            const float32Audio = new Float32Array(pcm16Array.length);
            for (let i = 0; i < pcm16Array.length; i++) {
              float32Audio[i] = pcm16Array[i] / 32767.0; // Convert back to -1.0 to 1.0 range
            }
            
            console.log('Float32 audio samples:', float32Audio.length);
            console.log('Audio sample values:', Array.from(float32Audio.slice(0, 10)));
            
            await this.handleAudioInput(ws, float32Audio);
            return;
            
          } catch (decodeError) {
            console.error('Audio decode error:', decodeError);
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to decode audio: ' + decodeError.message }));
            return;
          }
        } else if (data.type === 'audio' && data.audio) {
          // Legacy audio handling
          const audioBuffer = Uint8Array.from(atob(data.audio), c => c.charCodeAt(0));
          await this.handleAudioInput(ws, audioBuffer);
          return;
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Expected audio data or turn detection' }));
          return;
        }
      } else {
        // Direct binary audio data (legacy)
        const audioBuffer = new Uint8Array(message);
        await this.handleAudioInput(ws, audioBuffer);
      }
      
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  }

  async handleTurnDetection(ws, data) {
    try {
      console.log('Processing turn detection request');
      
      // Use the smart turn detection model
      const turnResult = await this.env.AI.run('@cf/pipecat-ai/smart-turn-v2', {
        audio: data.audio,
        dtype: data.dtype || 'float32'
      });

      console.log('Turn detection result:', turnResult);
      
      // Send result back to client
      ws.send(JSON.stringify({
        type: 'turn_detection_result',
        result: turnResult
      }));

    } catch (error) {
      console.error('Turn detection error:', error);
      ws.send(JSON.stringify({ 
        type: 'turn_detection_result', 
        result: { is_complete: false, probability: 0 }
      }));
    }
  }

  async handleAudioInput(ws, audioBuffer) {
    try {
      // Send processing status (optional - could remove for pure audio stream)
      ws.send(JSON.stringify({ type: 'status', message: 'Processing...' }));

      console.log('Processing audio input, buffer size:', audioBuffer.length);

      // ASR: Convert speech to text using Whisper
      try {
        console.log('Running Whisper ASR...');
        
        // Whisper expects an array of numbers (Float32 audio data)
        // Let's ensure we pass the right format
        const audioArray = Array.from(audioBuffer);
        console.log('Audio array length:', audioArray.length);
        console.log('Audio sample values (first 10):', audioArray.slice(0, 10));
        console.log('Audio range - min:', Math.min(...audioArray), 'max:', Math.max(...audioArray));
        
        const transcriptionResult = await this.env.AI.run('@cf/openai/whisper-tiny-en', {
          audio: audioArray
        });

        console.log('Whisper result:', transcriptionResult);

        const transcribedText = transcriptionResult.text || '';
        console.log('Transcribed text:', transcribedText);
        
        if (!transcribedText.trim()) {
          console.log('No speech detected in audio');
          ws.send(JSON.stringify({ type: 'error', message: 'No speech detected' }));
          return;
        }

        // Process the transcribed text and respond with audio
        await this.processAndRespondWithAudio(ws, transcribedText);

      } catch (asrError) {
        console.error('ASR (Whisper) error:', asrError);
        ws.send(JSON.stringify({ type: 'error', message: 'Speech recognition failed: ' + asrError.message }));
      }

    } catch (error) {
      console.error('Audio processing error:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Audio processing failed: ' + error.message }));
    }
  }

  async processAndRespondWithAudio(ws, inputText) {
    try {
      // LLM: Generate response using GPT OSS 120B
      let chatResponse;
      try {
        console.log('Generating response with GPT OSS 120B');
        chatResponse = await this.env.AI.run('@cf/openai/gpt-oss-120b', {
          instructions: 'You are a helpful AI voice assistant. Keep your responses concise, natural, and conversational for speech. Respond in a friendly, engaging manner suitable for voice interaction.',
          input: inputText
        });
      } catch (llmError) {
        console.log('GPT OSS 120B failed, trying Llama fallback:', llmError.message);
        // Fallback to Llama if GPT OSS fails
        try {
          chatResponse = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              { role: 'system', content: 'You are a helpful AI voice assistant. Keep your responses concise, natural, and conversational for speech.' },
              { role: 'user', content: inputText }
            ]
          });
        } catch (fallbackError) {
          console.log('Llama fallback also failed:', fallbackError.message);
          chatResponse = { response: 'I apologize, but I could not generate a response at this time.' };
        }
      }

      const responseText = chatResponse.response || chatResponse.output || 'I apologize, but I could not generate a response.';
      console.log('LLM Response:', responseText);

      // TTS: Use Deepgram Aura with returnRawResponse option
      let ttsResult = null;
      try {
        console.log('Using TTS model: @cf/deepgram/aura-1');
        ttsResult = await this.env.AI.run("@cf/deepgram/aura-1", {
          text: responseText
        }, {
          returnRawResponse: true
        });
        console.log('TTS success with @cf/deepgram/aura-1');
      } catch (ttsError) {
        console.log('TTS failed with @cf/deepgram/aura-1:', ttsError.message);
        ws.send(JSON.stringify({ type: 'error', message: 'TTS failed: ' + ttsError.message }));
        return;
      }

      // Send the raw response directly
      console.log('TTS result type:', typeof ttsResult, 'instanceof Response:', ttsResult instanceof Response);
      
      if (ttsResult instanceof Response) {
        // If it's a Response object, get the arrayBuffer
        console.log('Getting arrayBuffer from Response object');
        const audioBuffer = await ttsResult.arrayBuffer();
        console.log('Audio buffer size:', audioBuffer.byteLength);
        ws.send(audioBuffer);
      } else if (ttsResult instanceof ArrayBuffer) {
        // Direct ArrayBuffer
        console.log('Sending direct ArrayBuffer, size:', ttsResult.byteLength);
        ws.send(ttsResult);
      } else {
        // Try to handle other formats
        console.log('Unknown TTS result format, attempting conversion');
        try {
          const audioArray = new Uint8Array(ttsResult);
          ws.send(audioArray.buffer);
        } catch (conversionError) {
          console.error('Failed to convert TTS result:', conversionError);
          ws.send(JSON.stringify({ type: 'error', message: 'TTS response format not supported: ' + conversionError.message }));
          return;
        }
      }

    } catch (error) {
      console.error('Response generation error:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to generate response: ' + error.message }));
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
        .status-indicator {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            background-color: #f8f9fa;
            border-radius: 5px;
            border: 1px solid #dee2e6;
        }
        .listening {
            background-color: #d1ecf1 !important;
            color: #0c5460 !important;
            animation: pulse 2s infinite;
        }
        .processing {
            background-color: #fff3cd !important;
            color: #856404 !important;
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
        <h1>🎤 Real-Time Voice Chatbot</h1>
        <p>Powered by Cloudflare AI Workers with Smart Turn Detection - Just start listening and speak naturally!</p>
        
        <div id="connectionStatus" class="connection-status connecting">Connecting...</div>
        
        <div id="chatArea" class="chat-area"></div>
        
        <div class="controls">
            <button id="toggleBtn" class="record-btn">🎤 Start Listening</button>
            <button id="testBtn" class="record-btn" style="background-color: #6c757d;">🎯 Process Audio</button>
            <div class="status-indicator">
                <span id="listeningStatus">Ready to listen</span>
            </div>
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
                this.audioStream = null;
                this.audioChunks = [];
                this.isListening = false;
                this.audioContext = null;
                this.volume = 0.8;
                this.processorNode = null;
                this.isProcessingTurn = false;
                this.silenceTimeout = null;
                this.audioBuffer = [];
                this.turnDetectionThreshold = 0.7; // Probability threshold for turn completion
                this.lastTurnDetectionTime = 0; // Throttling for turn detection
                this.turnDetectionInterval = 5000; // Minimum 5 seconds between turn detections (increased)
                this.pendingTurnDetection = false; // Flag to prevent multiple pending detections
                
                this.initializeElements();
                this.initializeWebSocket();
                this.initializeEventListeners();
            }

            initializeElements() {
                this.chatArea = document.getElementById('chatArea');
                this.toggleBtn = document.getElementById('toggleBtn');
                this.testBtn = document.getElementById('testBtn');
                this.listeningStatus = document.getElementById('listeningStatus');
                this.volumeSlider = document.getElementById('volumeSlider');
                this.volumeValue = document.getElementById('volumeValue');
                this.connectionStatus = document.getElementById('connectionStatus');
            }

            initializeWebSocket() {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = protocol + '//' + window.location.host + '/websocket';
                
                this.ws = new WebSocket(wsUrl);
                
                // Set binary type to handle audio data properly
                this.ws.binaryType = 'arraybuffer';
                
                this.ws.onopen = () => {
                    this.updateConnectionStatus('connected', 'Connected');
                    this.addMessage('system', 'Connected! Click "Start Listening" then "Process Audio" to chat.');
                };
                
                this.ws.onmessage = (event) => {
                    this.handleWebSocketMessage(event.data);
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
                this.toggleBtn.addEventListener('click', () => this.toggleListening());
                this.testBtn.addEventListener('click', () => this.testProcessAudio());
                this.volumeSlider.addEventListener('input', (e) => {
                    this.volume = parseFloat(e.target.value);
                    this.volumeValue.textContent = Math.round(this.volume * 100) + '%';
                });
            }

            async testProcessAudio() {
                if (this.audioBuffer.length === 0) {
                    this.addMessage('error', 'No audio data to process. Start listening first.');
                    return;
                }
                
                this.addMessage('system', 'Processing ' + this.audioBuffer.length + ' audio samples directly...');
                
                try {
                    // Process audio directly without turn detection
                    const maxSamples = Math.min(16000, this.audioBuffer.length);
                    const audioData = new Float32Array(this.audioBuffer.slice(0, maxSamples));
                    
                    console.log('Audio data sample:', audioData.slice(0, 10));
                    
                    // Check if audio contains actual sound (not just silence)
                    const audioLevel = this.calculateAudioLevel(audioData);
                    console.log('Audio level (RMS):', audioLevel);
                    
                    if (audioLevel < 0.001) {
                        this.addMessage('error', 'Audio level too low (' + audioLevel.toFixed(6) + '). Please speak louder or check microphone.');
                        return;
                    }
                    
                    // Convert Float32 PCM to 16-bit PCM for better compatibility
                    const pcm16 = new Int16Array(audioData.length);
                    for (let i = 0; i < audioData.length; i++) {
                        // Clamp and convert to 16-bit signed integer
                        pcm16[i] = Math.max(-32768, Math.min(32767, audioData[i] * 32767));
                    }
                    
                    // Convert to bytes properly
                    const audioBytes = new Uint8Array(pcm16.buffer);
                    
                    console.log('Audio bytes length:', audioBytes.length);
                    console.log('First 16 bytes:', Array.from(audioBytes.slice(0, 16)));
                    
                    // Check if we have non-zero audio data
                    const nonZeroBytes = audioBytes.filter(b => b !== 0).length;
                    console.log('Non-zero bytes:', nonZeroBytes, '/', audioBytes.length);
                    
                    if (nonZeroBytes < audioBytes.length * 0.1) {
                        this.addMessage('error', 'Audio contains mostly silence. Please speak during recording.');
                        return;
                    }
                    
                    // Use modern approach with FileReader for reliable base64 conversion
                    const base64Audio = await new Promise((resolve, reject) => {
                        const blob = new Blob([audioBytes]);
                        const reader = new FileReader();
                        reader.onload = () => {
                            const dataUrl = reader.result;
                            // Remove data:application/octet-stream;base64, prefix
                            const base64 = dataUrl.split(',')[1];
                            resolve(base64);
                        };
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                    
                    console.log('Base64 audio length:', base64Audio.length);
                    console.log('Base64 sample (first 100 chars):', base64Audio.substring(0, 100));
                    
                    // Validate base64 before sending
                    try {
                        const decoded = atob(base64Audio);
                        console.log('Base64 validation passed, decoded length:', decoded.length);
                    } catch (validateError) {
                        throw new Error('Generated invalid base64: ' + validateError.message);
                    }
                    
                    // Send for ASR processing
                    this.sendAudioForProcessing(base64Audio);
                    this.addMessage('system', 'Audio sent for processing (level: ' + audioLevel.toFixed(4) + ')...');
                    
                    // Clear processed samples
                    this.audioBuffer = this.audioBuffer.slice(maxSamples);
                    
                } catch (error) {
                    console.error('Processing error:', error);
                    this.addMessage('error', 'Test processing failed: ' + error.message);
                }
            }

            calculateAudioLevel(audioData) {
                // Calculate RMS (Root Mean Square) level
                let sum = 0;
                for (let i = 0; i < audioData.length; i++) {
                    sum += audioData[i] * audioData[i];
                }
                return Math.sqrt(sum / audioData.length);
            }

            updateConnectionStatus(status, text) {
                this.connectionStatus.className = 'connection-status ' + status;
                this.connectionStatus.textContent = text;
            }

            async toggleListening() {
                if (this.isListening) {
                    this.stopListening();
                } else {
                    await this.startListening();
                }
            }

            async startListening() {
                try {
                    // Initialize AudioContext on user interaction
                    if (!this.audioContext) {
                        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                        console.log('Created AudioContext for real-time processing');
                    }
                    
                    if (this.audioContext.state === 'suspended') {
                        await this.audioContext.resume();
                        console.log('Resumed AudioContext for real-time processing');
                    }
                    
                    this.audioStream = await navigator.mediaDevices.getUserMedia({ 
                        audio: {
                            sampleRate: 16000, // Optimized for turn detection
                            channelCount: 1,
                            echoCancellation: true,
                            noiseSuppression: true
                        }
                    });
                    
                    // Set up real-time audio processing using modern approach
                    const source = this.audioContext.createMediaStreamSource(this.audioStream);
                    
                    // Try to use AudioWorkletNode, fallback to ScriptProcessorNode
                    try {
                        // Check if AudioWorklet is supported and we're in browser context
                        if (typeof window !== 'undefined' && 
                            this.audioContext.audioWorklet && 
                            typeof AudioWorkletNode !== 'undefined') {
                            
                            // Load audio worklet processor
                            const workletInfo = this.createAudioWorkletBlob();
                            if (workletInfo && workletInfo.url) {
                                await this.audioContext.audioWorklet.addModule(workletInfo.url);
                                
                                this.processorNode = new AudioWorkletNode(this.audioContext, workletInfo.processorName);
                                this.processorNode.port.onmessage = (event) => {
                                    if (this.isListening && !this.isProcessingTurn) {
                                        this.processAudioData(event.data.audioData);
                                    }
                                };
                                console.log('Using modern AudioWorkletNode with processor:', workletInfo.processorName);
                            } else {
                                throw new Error('Failed to create AudioWorklet blob');
                            }
                        } else {
                            throw new Error('AudioWorklet not supported');
                        }
                        
                    } catch (workletError) {
                        console.log('AudioWorkletNode failed, using ScriptProcessorNode fallback:', workletError.message);
                        // Fallback to ScriptProcessorNode
                        this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
                        this.processorNode.onaudioprocess = (event) => {
                            if (this.isListening && !this.isProcessingTurn) {
                                this.processAudioChunk(event.inputBuffer);
                            }
                        };
                    }
                    
                    source.connect(this.processorNode);
                    this.processorNode.connect(this.audioContext.destination);
                    
                    this.isListening = true;
                    this.isProcessingTurn = false;
                    this.pendingTurnDetection = false;
                    this.audioBuffer = [];
                    this.lastTurnDetectionTime = 0;
                    this.updateListeningStatus('🎧 Listening...', 'listening');
                    this.toggleBtn.textContent = '🛑 Stop Listening';
                    this.toggleBtn.classList.add('recording');
                    
                } catch (error) {
                    console.error('Error starting real-time listening:', error);
                    this.addMessage('error', 'Could not access microphone for real-time listening.');
                }
            }

            createAudioWorkletBlob() {
                // Only create AudioWorklet in browser context
                if (typeof window === 'undefined') return null;
                
                // Generate unique processor name to avoid registration conflicts
                const processorName = 'audio-processor-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
                
                const audioWorkletCode = 
                    'class AudioProcessor extends AudioWorkletProcessor {' +
                    '    constructor() {' +
                    '        super();' +
                    '        this.bufferSize = 4096;' +
                    '        this.buffer = new Float32Array(this.bufferSize);' +
                    '        this.bufferIndex = 0;' +
                    '    }' +
                    '    ' +
                    '    process(inputs, outputs, parameters) {' +
                    '        const input = inputs[0];' +
                    '        if (input && input.length > 0) {' +
                    '            const channelData = input[0];' +
                    '            ' +
                    '            for (let i = 0; i < channelData.length; i++) {' +
                    '                this.buffer[this.bufferIndex] = channelData[i];' +
                    '                this.bufferIndex++;' +
                    '                ' +
                    '                if (this.bufferIndex >= this.bufferSize) {' +
                    '                    this.port.postMessage({' +
                    '                        audioData: new Float32Array(this.buffer)' +
                    '                    });' +
                    '                    this.bufferIndex = 0;' +
                    '                }' +
                    '            }' +
                    '        }' +
                    '        return true;' +
                    '    }' +
                    '}' +
                    '' +
                    'registerProcessor("' + processorName + '", AudioProcessor);';
                
                const blob = new Blob([audioWorkletCode], { type: 'application/javascript' });
                return { url: URL.createObjectURL(blob), processorName: processorName };
            }

            processAudioData(audioData) {
                // Store audio data for later processing
                this.audioBuffer.push(...audioData);
                
                // TEMPORARILY DISABLE automatic turn detection to prevent stack overflow
                // Keep manual testing available via the Test button
                /*
                // Re-enable turn detection with proper throttling
                const now = Date.now();
                const hasEnoughData = this.audioBuffer.length >= 32000;
                const isNotBusy = !this.isProcessingTurn && !this.pendingTurnDetection;
                const hasWaitedEnough = (now - this.lastTurnDetectionTime) >= this.turnDetectionInterval;
                
                if (hasEnoughData && isNotBusy && hasWaitedEnough) {
                    // Immediately set flags to prevent any other calls
                    this.pendingTurnDetection = true;
                    this.lastTurnDetectionTime = now;
                    
                    console.log('Scheduling turn detection check...');
                    
                    // Use a longer delay and ensure proper async handling
                    setTimeout(() => {
                        this.performTurnDetection();
                    }, 200); // Increased delay to prevent rapid firing
                }
                */
                
                // Log audio processing periodically with level check
                if (this.audioBuffer.length % 16000 === 0) {
                    // Calculate current audio level for debugging
                    const recentAudio = new Float32Array(this.audioBuffer.slice(-4000)); // Last 4000 samples
                    const level = this.calculateAudioLevel(recentAudio);
                    console.log('Audio buffer size:', this.audioBuffer.length, '- Recent level:', level.toFixed(6), '- Use Process button to manually process');
                }
                
                // Limit buffer size to prevent memory issues
                if (this.audioBuffer.length > 96000) {
                    this.audioBuffer = this.audioBuffer.slice(-64000);
                    console.log('Audio buffer trimmed to prevent memory issues');
                }
            }

            async performTurnDetection() {
                try {
                    // Double-check flags before proceeding
                    if (!this.pendingTurnDetection || this.isProcessingTurn) {
                        console.log('Turn detection cancelled - flags check failed');
                        return;
                    }
                    
                    console.log('Starting turn detection...');
                    await this.checkTurnCompletion();
                } catch (error) {
                    console.error('Turn detection error in performTurnDetection:', error);
                } finally {
                    this.pendingTurnDetection = false;
                    console.log('Turn detection completed, flags reset');
                }
            }

            stopListening() {
                if (this.audioStream) {
                    this.audioStream.getTracks().forEach(track => track.stop());
                }
                
                if (this.processorNode) {
                    this.processorNode.disconnect();
                    this.processorNode = null;
                }
                
                this.isListening = false;
                this.isProcessingTurn = false;
                this.pendingTurnDetection = false;
                this.audioBuffer = [];
                this.lastTurnDetectionTime = 0;
                this.updateListeningStatus('Ready to listen', '');
                this.toggleBtn.textContent = '🎤 Start Listening';
                this.toggleBtn.classList.remove('recording');
                
                if (this.silenceTimeout) {
                    clearTimeout(this.silenceTimeout);
                }
            }

            processAudioChunk(inputBuffer) {
                // Convert audio buffer to PCM data for turn detection (ScriptProcessorNode fallback)
                const channelData = inputBuffer.getChannelData(0);
                const pcmData = new Float32Array(channelData);
                
                // Use the same logic as processAudioData
                this.processAudioData(pcmData);
            }

            async checkTurnCompletion() {
                console.log('checkTurnCompletion called, flags:', {
                    isProcessingTurn: this.isProcessingTurn,
                    bufferLength: this.audioBuffer.length,
                    pendingTurnDetection: this.pendingTurnDetection
                });
                
                // Strict guard conditions - return immediately if busy or no data
                if (this.isProcessingTurn || this.audioBuffer.length === 0) {
                    console.log('checkTurnCompletion: early return due to flags');
                    return;
                }
                
                // Set processing flag immediately to prevent re-entry
                this.isProcessingTurn = true;
                console.log('Turn detection processing started');
                
                try {
                    // Process audio with proper PCM conversion
                    const maxSamples = Math.min(16000, this.audioBuffer.length);
                    const audioData = new Float32Array(this.audioBuffer.slice(0, maxSamples));
                    
                    // Convert Float32 PCM to 16-bit PCM
                    const pcm16 = new Int16Array(audioData.length);
                    for (let i = 0; i < audioData.length; i++) {
                        pcm16[i] = Math.max(-32768, Math.min(32767, audioData[i] * 32767));
                    }
                    
                    // Convert to bytes properly
                    const audioBytes = new Uint8Array(pcm16.buffer);
                    
                    // Use FileReader for reliable base64 conversion
                    const base64Audio = await new Promise((resolve, reject) => {
                        const blob = new Blob([audioBytes]);
                        const reader = new FileReader();
                        reader.onload = () => {
                            const dataUrl = reader.result;
                            const base64 = dataUrl.split(',')[1];
                            resolve(base64);
                        };
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                    
                    console.log('Sending turn detection request with', maxSamples, 'samples...');
                    
                    // Send to turn detection API with timeout
                    const turnDetectionResult = await Promise.race([
                        this.sendTurnDetection(base64Audio),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Turn detection timeout')), 5000))
                    ]);
                    
                    console.log('Turn detection result:', turnDetectionResult);
                    
                    if (turnDetectionResult && turnDetectionResult.is_complete && 
                        turnDetectionResult.probability >= this.turnDetectionThreshold) {
                        console.log('Turn completion detected with probability:', turnDetectionResult.probability);
                        await this.processTurnCompletion();
                    }
                    
                    // Keep only recent audio data (sliding window)
                    if (this.audioBuffer.length > 64000) {
                        this.audioBuffer = this.audioBuffer.slice(-32000);
                    }
                    
                } catch (error) {
                    console.error('Turn detection error:', error);
                } finally {
                    // Always reset the processing flag
                    this.isProcessingTurn = false;
                    console.log('checkTurnCompletion: processing flag reset');
                }
            }

            async sendTurnDetection(audioBase64) {
                return new Promise((resolve, reject) => {
                    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                        reject(new Error('WebSocket not connected'));
                        return;
                    }
                    
                    const timeoutId = setTimeout(() => {
                        reject(new Error('Turn detection timeout'));
                    }, 3000); // Reduced timeout to 3 seconds
                    
                    const message = JSON.stringify({
                        type: 'turn_detection',
                        audio: audioBase64,
                        dtype: 'float32'
                    });
                    
                    // Set up one-time listener for turn detection response
                    const originalHandler = this.ws.onmessage;
                    const responseHandler = (event) => {
                        try {
                            const data = JSON.parse(event.data);
                            if (data.type === 'turn_detection_result') {
                                clearTimeout(timeoutId);
                                this.ws.onmessage = originalHandler;
                                resolve(data.result);
                                return;
                            }
                        } catch (e) {
                            // Not a turn detection result, pass to original handler
                        }
                        // Pass through to original handler
                        if (originalHandler) {
                            originalHandler(event);
                        }
                    };
                    
                    this.ws.onmessage = responseHandler;
                    this.ws.send(message);
                });
            }

            async processTurnCompletion() {
                if (this.isProcessingTurn) return; // Prevent multiple simultaneous processing
                
                this.isProcessingTurn = true;
                this.updateListeningStatus('🤔 Processing your speech...', 'processing');
                
                try {
                    // Convert collected audio to format suitable for ASR
                    const audioData = new Float32Array(this.audioBuffer.slice(0, 32000));
                    const audioBytes = new Uint8Array(audioData.buffer);
                    const base64Audio = btoa(String.fromCharCode.apply(null, audioBytes));
                    
                    // Send for ASR processing
                    this.sendAudioForProcessing(base64Audio);
                    
                    // Clear the processed audio buffer
                    this.audioBuffer = this.audioBuffer.slice(32000);
                    
                } catch (error) {
                    console.error('Turn completion processing error:', error);
                    this.addMessage('error', 'Failed to process speech turn');
                } finally {
                    // Reset processing flag after a delay to allow ASR to complete
                    setTimeout(() => {
                        this.isProcessingTurn = false;
                        if (this.isListening) {
                            this.updateListeningStatus('🎧 Listening...', 'listening');
                        }
                    }, 1000);
                }
            }

            sendAudioForProcessing(audioBase64) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.addMessage('user', '🎤 [Processing speech...]');
                    
                    const message = JSON.stringify({
                        type: 'audio_processing',
                        audio: audioBase64
                    });
                    this.ws.send(message);
                }
            }

            updateListeningStatus(text, className) {
                this.listeningStatus.textContent = text;
                this.listeningStatus.className = className;
                
                // Add real-time audio level indicator
                if (className === 'listening' && this.audioBuffer.length > 0) {
                    const recentSamples = Math.min(1000, this.audioBuffer.length);
                    const recentAudio = new Float32Array(this.audioBuffer.slice(-recentSamples));
                    const level = this.calculateAudioLevel(recentAudio);
                    const levelPercent = Math.min(100, level * 1000); // Scale for display
                    this.listeningStatus.textContent = text + ' (Level: ' + levelPercent.toFixed(1) + '%)';
                }
            }

            handleWebSocketMessage(data) {
                console.log('Received WebSocket message:', data);
                
                // Handle binary audio data (ArrayBuffer or Blob)
                if (data instanceof ArrayBuffer) {
                    console.log('Received binary audio data (ArrayBuffer), size:', data.byteLength);
                    this.playBinaryAudio(data);
                    this.addMessage('bot', '🔊 [AI Response]');
                    return;
                } else if (data instanceof Blob) {
                    console.log('Received binary audio data (Blob), size:', data.size);
                    // Convert Blob to ArrayBuffer and play
                    data.arrayBuffer().then(arrayBuffer => {
                        this.playBinaryAudio(arrayBuffer);
                        this.addMessage('bot', '🔊 [AI Response]');
                    }).catch(error => {
                        console.error('Error converting Blob to ArrayBuffer:', error);
                        this.addMessage('error', 'Failed to process audio blob');
                    });
                    return;
                }
                
                try {
                    // Parse JSON messages
                    const message = typeof data === 'string' ? JSON.parse(data) : data;
                    console.log('Parsed message:', message);
                    
                    switch (message.type) {
                        case 'audio':
                            console.log('Received base64 audio');
                            this.playAudio(message.audio);
                            this.addMessage('bot', '🔊 [AI Response]');
                            break;
                        case 'text':
                            this.addMessage('bot', message.text);
                            if (message.message) {
                                this.addMessage('status', message.message);
                            }
                            break;
                        case 'status':
                            this.addMessage('status', message.message);
                            break;
                        case 'error':
                            this.addMessage('error', message.message);
                            break;
                        default:
                            console.log('Unknown message type:', message.type);
                    }
                } catch (error) {
                    console.error('Error parsing WebSocket message:', error);
                    this.addMessage('error', 'Failed to process server response');
                }
            }

            async playBinaryAudio(audioBuffer) {
                try {
                    console.log('Starting binary audio playback, buffer size:', audioBuffer.byteLength);
                    
                    if (!this.audioContext) {
                        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                        console.log('Created new AudioContext');
                    }

                    // Resume audio context if suspended (required for many browsers)
                    if (this.audioContext.state === 'suspended') {
                        await this.audioContext.resume();
                        console.log('Resumed AudioContext');
                    }

                    // Decode and play binary audio
                    console.log('Decoding audio data...');
                    const decodedBuffer = await this.audioContext.decodeAudioData(audioBuffer.slice());
                    console.log('Audio decoded successfully, duration:', decodedBuffer.duration);
                    
                    const source = this.audioContext.createBufferSource();
                    const gainNode = this.audioContext.createGain();
                    
                    gainNode.gain.value = this.volume;
                    source.buffer = decodedBuffer;
                    source.connect(gainNode);
                    gainNode.connect(this.audioContext.destination);
                    
                    source.onended = () => {
                        console.log('Audio playback finished');
                    };
                    
                    source.start();
                    console.log('Audio playback started');
                    
                } catch (error) {
                    console.error('Binary audio playback error:', error);
                    this.addMessage('error', 'Could not play audio response: ' + error.message);
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