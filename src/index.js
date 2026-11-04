export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(HTML_CONTENT, {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.pathname === "/websocket") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }

      const id = env.WEBSOCKET_HIBERNATION_SERVER.newUniqueId();
      const stub = env.WEBSOCKET_HIBERNATION_SERVER.get(id);

      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

// MiniMax voice IDs per language, used only when an AI Gateway is configured.
// NOTE: these names must be confirmed against the live model once the gateway is
// set up (the docs don't publish the enum). Until then MiniMax is disabled and
// these are inert. en/es never reach MiniMax (they use Aura-2).
const MINIMAX_VOICES = {
  zh: "Chinese (Mandarin)_Warm_Girl",
  ja: "Japanese_CalmLady",
  ko: "Korean_SweetGirl",
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
      if (typeof message === "string") {
        // JSON message with different types
        const data = JSON.parse(message);

        if (data.type === "turn_detection") {
          await this.handleTurnDetection(ws, data);
          return;
        } else if (data.type === "audio_processing") {
          const sampleRate = data.sample_rate || 16000;
          console.log(
            "Received audio_processing request, base64 length:",
            data.audio.length,
            "sample_rate:",
            sampleRate,
          );

          try {
            // Decode base64 to get the 16-bit PCM data
            const binaryString = atob(data.audio);
            const pcm16Bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              pcm16Bytes[i] = binaryString.charCodeAt(i);
            }

            console.log(
              "Decoded 16-bit PCM audio bytes length:",
              pcm16Bytes.length,
            );

            await this.handleAudioInput(ws, pcm16Bytes, sampleRate);
            return;
          } catch (decodeError) {
            console.error("Audio decode error:", decodeError);
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Failed to decode audio: " + decodeError.message,
              }),
            );
            return;
          }
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Expected audio_processing data or turn detection",
            }),
          );
          return;
        }
      } else {
        // Direct binary audio data is not expected in this version
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Unexpected binary message format",
          }),
        );
      }
    } catch (error) {
      console.error("WebSocket message error:", error);
      ws.send(JSON.stringify({ type: "error", message: error.message }));
    }
  }

  createWavHeader(dataLength, sampleRate, channels, bitsPerSample) {
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    // RIFF chunk descriptor
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true); // ChunkSize
    writeString(8, "WAVE");

    // "fmt " sub-chunk
    writeString(12, "fmt ");
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
    view.setUint16(22, channels, true); // NumChannels
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true); // ByteRate
    view.setUint16(32, channels * (bitsPerSample / 8), true); // BlockAlign
    view.setUint16(34, bitsPerSample, true); // BitsPerSample

    // "data" sub-chunk
    writeString(36, "data");
    view.setUint32(40, dataLength, true); // Subchunk2Size

    return new Uint8Array(buffer);
  }

  // MeloTTS supports en/es/fr/zh/ja/ko. We can only reliably distinguish
  // CJK scripts from Latin via Unicode blocks; for Latin text we default
  // to English, which is acceptable since the LLM replies in the user's
  // language and en-voice MeloTTS will still pronounce most Latin text.
  detectLangFromText(text) {
    if (!text) return "en";
    if (/[가-힯]/.test(text)) return "ko";
    if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja";
    if (/[一-鿿]/.test(text)) return "zh";
    return "en";
  }

  // Workers AI returns assistant text in different shapes depending on the
  // model. gpt-oss exposes a normalized `response` string; OpenAI-compatible
  // chat models use choices[0].message.content; the Responses API nests it
  // under output[].content[].text. Try them in order.
  extractLLMText(r) {
    if (!r) return "";
    if (typeof r.response === "string" && r.response.trim()) return r.response;
    const chat = r.choices?.[0]?.message?.content;
    if (typeof chat === "string" && chat.trim()) return chat;
    if (Array.isArray(r.output)) {
      for (const item of r.output) {
        const parts = item?.content;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (typeof p?.text === "string" && p.text.trim()) return p.text;
          }
        }
      }
    }
    return "";
  }

  // TTS router. Returns raw audio bytes to stream to the client, or `null` to
  // signal the caller that no server-side voice exists for this language and the
  // browser should speak the text itself.
  //
  //   en/es     -> Deepgram Aura-2 (high quality, no extra setup)
  //   otherwise -> MiniMax via AI Gateway *if configured*, else browser TTS.
  //                (Cloudflare's MeloTTS produces gibberish for Chinese and
  //                Aura-2 only speaks en/es, so there is no first-party zh/ja/ko TTS.)
  async synthesizeSpeech(text, detectedLang) {
    const AURA_LANGS = {
      en: "@cf/deepgram/aura-2-en",
      es: "@cf/deepgram/aura-2-es",
    };
    const auraModel = AURA_LANGS[detectedLang];

    if (auraModel) {
      console.log("Using TTS model:", auraModel);
      // Aura returns a ReadableStream (or a Response wrapping one) of MP3 audio.
      const out = await this.env.AI.run(auraModel, { text });
      const resp = out instanceof Response ? out : new Response(out);
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    }

    // MiniMax (partner model) — only used once an AI Gateway is configured AND a
    // voice is known for this language. Needs `AI_GATEWAY_ID` in wrangler.toml and
    // partner-model billing enabled. On any failure we fall through to browser TTS
    // so the user is never left without speech.
    const gatewayId = this.env.AI_GATEWAY_ID;
    const voiceId = MINIMAX_VOICES[detectedLang];
    if (gatewayId && voiceId) {
      try {
        console.log("Using MiniMax TTS via gateway, voice:", voiceId);
        const out = await this.env.AI.run(
          "minimax/speech-2.8-hd",
          { text, voice_id: voiceId, format: "mp3" },
          { gateway: { id: gatewayId } },
        );
        const audioUrl = out?.audio ?? out?.result?.audio;
        if (typeof audioUrl === "string" && audioUrl.startsWith("http")) {
          const a = await fetch(audioUrl);
          return new Uint8Array(await a.arrayBuffer());
        }
        console.error("MiniMax returned no audio URL:", out);
      } catch (e) {
        console.log("MiniMax TTS failed, using browser TTS:", e.message);
      }
    }

    // No server-side voice for this language — let the browser speak it.
    return null;
  }

  async handleTurnDetection(ws, data) {
    try {
      console.log("Processing turn detection request");

      // Use the smart turn detection model
      const binaryString = atob(data.audio);
      const audioBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        audioBytes[i] = binaryString.charCodeAt(i);
      }
      const pcm16Array = new Int16Array(audioBytes.buffer);
      const float32Audio = new Float32Array(pcm16Array.length);
      for (let i = 0; i < pcm16Array.length; i++) {
        float32Audio[i] = pcm16Array[i] / 32767.0;
      }

      const turnResult = await this.env.AI.run("@cf/pipecat-ai/smart-turn-v2", {
        audio: Array.from(float32Audio),
        dtype: data.dtype || "float32",
      });

      console.log("Turn detection result:", turnResult);

      // Send result back to client
      ws.send(
        JSON.stringify({
          type: "turn_detection_result",
          result: turnResult,
        }),
      );
    } catch (error) {
      console.error("Turn detection error:", error);
      ws.send(
        JSON.stringify({
          type: "turn_detection_result",
          result: { is_complete: false, probability: 0 },
        }),
      );
    }
  }

  async handleAudioInput(ws, pcm16Data, sampleRate) {
    try {
      // Send processing status (optional - could remove for pure audio stream)
      ws.send(JSON.stringify({ type: "status", message: "Processing..." }));

      const rate = sampleRate || 16000;
      console.log(
        "Processing audio input, 16-bit PCM buffer size:",
        pcm16Data.byteLength,
        "sample_rate:",
        rate,
      );

      // ASR: Whisper Large v3 Turbo — strong multilingual auto-detection,
      // including Chinese/Japanese/Korean. Chosen over Deepgram Nova-3, which
      // mis-handled Chinese audio (transcribed it as English).
      try {
        console.log("Running Whisper ASR (multilingual)...");

        // Create a WAV file using the actual capture rate, not a hardcoded value.
        const wavHeader = this.createWavHeader(
          pcm16Data.byteLength,
          rate,
          1,
          16,
        );
        const wavBytes = new Uint8Array(
          wavHeader.byteLength + pcm16Data.byteLength,
        );
        wavBytes.set(wavHeader, 0);
        wavBytes.set(pcm16Data, wavHeader.byteLength);

        // whisper-large-v3-turbo expects base64-encoded audio. Chunked encoding
        // avoids a stack overflow on large buffers.
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < wavBytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(
            null,
            wavBytes.subarray(i, i + chunkSize),
          );
        }
        const audioBase64 = btoa(binary);

        console.log("Total WAV bytes sent to ASR:", wavBytes.length);

        // Omit `language` to enable auto-detection across all supported languages.
        const transcriptionResult = await this.env.AI.run(
          "@cf/openai/whisper-large-v3-turbo",
          {
            audio: audioBase64,
          },
        );

        console.log("Whisper result:", JSON.stringify(transcriptionResult));

        const transcribedText = (transcriptionResult?.text || "").trim();

        // Language for TTS routing. The transcribed script is the most reliable
        // signal for CJK (Aura can't speak those, so they must route to MeloTTS);
        // otherwise trust Whisper's detected language (it may report a full name
        // like "english", so map the common ones to ISO codes).
        const scriptLang = this.detectLangFromText(transcribedText);
        let detectedLang;
        if (scriptLang !== "en") {
          detectedLang = scriptLang;
        } else {
          const NAME_TO_CODE = {
            english: "en",
            spanish: "es",
            french: "fr",
            german: "de",
            chinese: "zh",
            japanese: "ja",
            korean: "ko",
          };
          let rawLang = String(transcriptionResult?.language || "en").toLowerCase();
          rawLang = NAME_TO_CODE[rawLang] || rawLang;
          detectedLang = rawLang.split("-")[0];
        }
        console.log("Transcribed text:", transcribedText, "lang:", detectedLang);

        if (!transcribedText.trim()) {
          console.log("No speech detected in audio");
          ws.send(
            JSON.stringify({ type: "error", message: "No speech detected" }),
          );
          return;
        }

        // Surface the transcription to the client for debugging.
        ws.send(
          JSON.stringify({
            type: "transcript",
            text: transcribedText,
            lang: detectedLang,
          }),
        );

        // Process the transcribed text and respond with audio
        await this.processAndRespondWithAudio(ws, transcribedText, detectedLang);
      } catch (asrError) {
        console.error("ASR (Whisper) error:", asrError);
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Speech recognition failed: " + asrError.message,
          }),
        );
      }
    } catch (error) {
      console.error("Audio processing error:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Audio processing failed: " + error.message,
        }),
      );
    }
  }

  async processAndRespondWithAudio(ws, inputText, detectedLang) {
    try {
      const messages = [
        {
          role: "system",
          content:
            "You are a helpful multilingual AI voice assistant. Always reply in the same language the user spoke. Keep your responses concise, natural, and conversational for speech.",
        },
        { role: "user", content: inputText },
      ];

      // LLM: gpt-oss-120b — newest open model in the Workers AI catalog.
      // Voice replies need to be short, so cap max_tokens. GLM-4.7-Flash
      // (fast, dialogue-tuned) stays as the fallback.
      const llmParams = {
        messages,
        max_tokens: 200,
        temperature: 0.6,
      };

      let chatResponse;
      try {
        console.log("Generating response with gpt-oss-120b");
        chatResponse = await this.env.AI.run(
          "@cf/openai/gpt-oss-120b",
          llmParams,
        );
      } catch (llmError) {
        console.log(
          "gpt-oss-120b failed, trying GLM-4.7-Flash fallback:",
          llmError.message,
        );
        try {
          chatResponse = await this.env.AI.run(
            "@cf/zai-org/glm-4.7-flash",
            llmParams,
          );
        } catch (fallbackError) {
          console.log("GLM-4.7 fallback also failed:", fallbackError.message);
          chatResponse = null;
        }
      }

      let responseText =
        this.extractLLMText(chatResponse) ||
        "I apologize, but I could not generate a response at this time.";

      // If reasoning leaks through as <think>...</think>, drop it before TTS.
      responseText = responseText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

      if (!this.extractLLMText(chatResponse)) {
        console.error(
          "Could not extract a valid string response from LLM output:",
          chatResponse,
        );
      }
      console.log("Extracted LLM Response:", responseText);

      // Surface the LLM reply to the client for debugging.
      ws.send(
        JSON.stringify({
          type: "response_text",
          text: responseText,
        }),
      );

      // TTS routing (see synthesizeSpeech): en/es get server audio from Aura-2;
      // other languages either use MiniMax (if a gateway is configured) or fall
      // back to having the browser speak the text via speechSynthesis.
      console.log("TTS for detected language:", detectedLang);
      let audioBytes;
      try {
        audioBytes = await this.synthesizeSpeech(responseText, detectedLang);
      } catch (ttsError) {
        console.log("TTS failed:", ttsError.message);
        audioBytes = null;
      }

      if (audioBytes && audioBytes.byteLength > 0) {
        console.log("Sending TTS audio, size:", audioBytes.byteLength);
        ws.send(audioBytes.buffer);
      } else {
        // No server-side voice — tell the client to speak it locally.
        console.log("No server audio; asking browser to speak. lang:", detectedLang);
        ws.send(
          JSON.stringify({
            type: "speak_text",
            text: responseText,
            lang: detectedLang,
          }),
        );
      }
    } catch (error) {
      console.error("Response generation error:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Failed to generate response: " + error.message,
        }),
      );
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    console.log("WebSocket closed:", code, reason, wasClean);
  }

  webSocketError(ws, error) {
    console.error("WebSocket error:", error);
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
            <button id="startBtn" class="record-btn">🎙️ Start Conversation</button>
            <div class="status-indicator">
                <span id="listeningStatus">Press start, then just talk — I'll reply, and you can interrupt me anytime.</span>
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
                this.botSpeaking = false;     // true while the bot's reply is playing
                this.currentSource = null;    // the AudioBufferSourceNode now playing
                this.currentUtterance = null; // the SpeechSynthesisUtterance now speaking
                this.bargeInChunks = 0;       // consecutive loud chunks during playback
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
                this.startBtn = document.getElementById('startBtn');
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
                    this.addMessage('system', 'Connected! Click "Start Listening" and just talk — I will respond when you stop.');
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
                this.startBtn.addEventListener('click', () => this.startConversation());
                this.volumeSlider.addEventListener('input', (e) => {
                    this.volume = parseFloat(e.target.value);
                    this.volumeValue.textContent = Math.round(this.volume * 100) + '%';
                });
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

            async startConversation() {
                // One-time gesture: browsers require a user click before they
                // grant the mic and allow audio playback. After this it's fully
                // hands-free — no record button, just talk.
                this.startBtn.disabled = true;
                await this.startListening();
                if (this.isListening) {
                    this.startBtn.style.display = 'none';
                } else {
                    this.startBtn.disabled = false;
                }
            }

            async startListening() {
                try {
                    // Initialize AudioContext on user interaction.
                    // Force 16 kHz so the captured samples match what Whisper expects.
                    // Without this option, the context runs at the system default
                    // (usually 44.1/48 kHz) and our WAV header would mislabel the rate.
                    if (!this.audioContext) {
                        const Ctor = window.AudioContext || window.webkitAudioContext;
                        try {
                            this.audioContext = new Ctor({ sampleRate: 16000 });
                        } catch (e) {
                            console.warn('AudioContext sampleRate option not supported, using default:', e.message);
                            this.audioContext = new Ctor();
                        }
                        console.log('AudioContext sample rate:', this.audioContext.sampleRate);
                        if (this.audioContext.sampleRate !== 16000) {
                            console.warn('AudioContext is running at', this.audioContext.sampleRate, 'Hz — server will be told the real rate.');
                        }
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
                                    if (this.isListening) {
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
                            if (this.isListening) {
                                this.processAudioChunk(event.inputBuffer);
                            }
                        };
                    }
                    
                    source.connect(this.processorNode);
                    this.processorNode.connect(this.audioContext.destination);
                    
                    this.isListening = true;
                    this.isProcessingTurn = false;
                    this.botSpeaking = false;
                    this.bargeInChunks = 0;
                    this.pendingTurnDetection = false;
                    this.audioBuffer = [];
                    this.lastTurnDetectionTime = 0;
                    this.vadState = 'idle';
                    this.silenceMs = 0;
                    this.updateListeningStatus('🎧 Listening...', 'listening');

                } catch (error) {
                    console.error('Error starting real-time listening:', error);
                    this.addMessage('error', 'Could not access microphone. Please allow mic access and try again.');
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
                // VAD state machine. AudioWorklet posts 4096 samples at 16kHz
                // = ~256ms per call. We measure RMS per chunk and decide:
                //   idle              -> wait for speech onset, keep tiny pre-roll
                //   speaking          -> buffer everything, watch for silence
                //   trailing_silence  -> keep buffering; commit after enough quiet
                const SPEECH_RMS = 0.015;       // above this = speech
                const SILENCE_RMS = 0.008;      // below this = silence
                const SILENCE_HOLD_MS = 900;    // quiet this long → end of turn
                const BARGE_IN_RMS = 0.03;      // louder bar so the bot's own echo won't trip it
                const BARGE_IN_CHUNKS = 2;      // ~0.5s of sustained speech confirms an interrupt
                const sr = this.audioContext.sampleRate;
                const PREROLL_SAMPLES = Math.round(0.25 * sr);   // ~250ms before onset
                const MAX_UTTERANCE_SAMPLES = Math.round(30 * sr); // cap at 30s
                const MIN_UTTERANCE_SAMPLES = Math.round(0.5 * sr); // ~500ms; below = ignore

                const level = this.calculateAudioLevel(audioData);
                const chunkMs = (audioData.length / sr) * 1000;

                // Barge-in: the user starts talking while the bot is speaking.
                // Echo cancellation removes most of the bot's own voice from the
                // mic, but we still require a couple of loud chunks before cutting
                // playback off, to avoid false triggers.
                if (this.botSpeaking) {
                    if (level >= BARGE_IN_RMS) {
                        this.bargeInChunks++;
                    } else {
                        this.bargeInChunks = 0;
                    }
                    if (this.bargeInChunks < BARGE_IN_CHUNKS) {
                        return; // not confirmed yet — keep letting the bot talk
                    }
                    this.handleBargeIn(); // stops playback, vadState -> 'speaking'
                }

                // After committing, while we wait on the server, ignore the mic.
                if (this.isProcessingTurn && !this.botSpeaking) {
                    return;
                }

                this.audioBuffer.push(...audioData);
                if (!this.vadState) this.vadState = 'idle';

                if (this.vadState === 'idle') {
                    if (level >= SPEECH_RMS) {
                        this.vadState = 'speaking';
                        this.silenceMs = 0;
                        this.updateListeningStatus('🗣️ Speaking...', 'listening');
                    } else if (this.audioBuffer.length > PREROLL_SAMPLES) {
                        // discard old silence so we don't ship a 10-minute prefix
                        this.audioBuffer = this.audioBuffer.slice(-PREROLL_SAMPLES);
                    }
                } else if (this.vadState === 'speaking') {
                    if (level < SILENCE_RMS) {
                        this.vadState = 'trailing_silence';
                        this.silenceMs = chunkMs;
                    }
                    if (this.audioBuffer.length >= MAX_UTTERANCE_SAMPLES) {
                        // safety: force-commit a runaway utterance
                        this.commitUtterance();
                    }
                } else if (this.vadState === 'trailing_silence') {
                    if (level >= SPEECH_RMS) {
                        this.vadState = 'speaking';
                        this.silenceMs = 0;
                        this.updateListeningStatus('🗣️ Speaking...', 'listening');
                    } else {
                        this.silenceMs += chunkMs;
                        if (this.silenceMs >= SILENCE_HOLD_MS) {
                            if (this.audioBuffer.length >= MIN_UTTERANCE_SAMPLES) {
                                this.commitUtterance();
                            } else {
                                // too short to be real speech — drop it
                                this.audioBuffer = [];
                                this.vadState = 'idle';
                                this.silenceMs = 0;
                            }
                        }
                    }
                }
            }

            async commitUtterance() {
                const samples = this.audioBuffer;
                this.audioBuffer = [];
                this.vadState = 'idle';
                this.silenceMs = 0;
                this.isProcessingTurn = true;
                this.updateListeningStatus('🤔 Thinking...', 'processing');

                try {
                    const audioData = new Float32Array(samples);
                    const pcm16 = new Int16Array(audioData.length);
                    for (let i = 0; i < audioData.length; i++) {
                        pcm16[i] = Math.max(-32768, Math.min(32767, audioData[i] * 32767));
                    }
                    const audioBytes = new Uint8Array(pcm16.buffer);

                    const base64Audio = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result.split(',')[1]);
                        reader.onerror = reject;
                        reader.readAsDataURL(new Blob([audioBytes]));
                    });

                    this.sendAudioForProcessing(base64Audio, this.audioContext.sampleRate);
                } catch (error) {
                    console.error('Commit utterance error:', error);
                    this.addMessage('error', 'Failed to send speech: ' + error.message);
                    this.isProcessingTurn = false;
                    if (this.isListening) {
                        this.updateListeningStatus('🎧 Listening...', 'listening');
                    }
                }
            }

            handleBargeIn() {
                console.log('Barge-in detected — interrupting bot playback');
                this.stopPlayback();
                this.botSpeaking = false;
                this.isProcessingTurn = false;
                this.bargeInChunks = 0;
                // The user is already mid-sentence, so start capturing immediately.
                this.audioBuffer = [];
                this.vadState = 'speaking';
                this.silenceMs = 0;
                this.updateListeningStatus('🗣️ Speaking...', 'listening');
            }

            stopPlayback() {
                if (this.currentSource) {
                    try {
                        this.currentSource.onended = null;
                        this.currentSource.stop();
                    } catch (e) {
                        // already stopped
                    }
                    this.currentSource = null;
                }
                if (this.currentUtterance) {
                    this.currentUtterance.onend = null;
                    this.currentUtterance.onerror = null;
                    this.currentUtterance = null;
                }
                try {
                    if (window.speechSynthesis) window.speechSynthesis.cancel();
                } catch (e) {
                    // ignore
                }
            }

            speakWithBrowser(text, lang) {
                const handBack = () => {
                    this.botSpeaking = false;
                    this.isProcessingTurn = false;
                    this.vadState = 'idle';
                    this.silenceMs = 0;
                    this.audioBuffer = [];
                    if (this.isListening) {
                        this.updateListeningStatus('🎧 Listening...', 'listening');
                    }
                };

                if (!('speechSynthesis' in window) || !text) {
                    console.warn('speechSynthesis unavailable; cannot speak', lang);
                    this.addMessage('status', 'No voice available for this language on your device.');
                    handBack();
                    return;
                }

                const BCP47 = { zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', en: 'en-US' };
                const utterLang = BCP47[lang] || lang || 'en-US';

                try { window.speechSynthesis.cancel(); } catch (e) {}

                const u = new SpeechSynthesisUtterance(text);
                u.lang = utterLang;
                u.volume = this.volume;

                // Pick a matching installed voice if one is available.
                const prefix = utterLang.slice(0, 2).toLowerCase();
                const voices = window.speechSynthesis.getVoices() || [];
                const match = voices.find(v => (v.lang || '').toLowerCase().startsWith(prefix));
                if (match) u.voice = match;

                this.currentUtterance = u;
                this.botSpeaking = true;
                this.bargeInChunks = 0;
                this.updateListeningStatus('🔊 Speaking (talk to interrupt)...', 'processing');

                u.onend = () => {
                    if (this.currentUtterance !== u) return; // replaced by a barge-in
                    this.currentUtterance = null;
                    handBack();
                };
                u.onerror = () => {
                    if (this.currentUtterance !== u) return;
                    this.currentUtterance = null;
                    handBack();
                };

                window.speechSynthesis.speak(u);
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
                this.botSpeaking = false;
                this.bargeInChunks = 0;
                this.pendingTurnDetection = false;
                this.audioBuffer = [];
                this.lastTurnDetectionTime = 0;
                this.vadState = 'idle';
                this.silenceMs = 0;
                this.stopPlayback();
                this.updateListeningStatus('Ready to listen', '');

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
                    
                    // Convert Float32 to 16-bit PCM
                    const pcm16 = new Int16Array(audioData.length);
                    for (let i = 0; i < audioData.length; i++) {
                        pcm16[i] = Math.max(-32768, Math.min(32767, audioData[i] * 32767));
                    }
                    
                    const audioBytes = new Uint8Array(pcm16.buffer);
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

            sendAudioForProcessing(audioBase64, sampleRate) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    // Don't add a placeholder — the server will send back a
                    // transcript message and the client will render that.
                    const message = JSON.stringify({
                        type: 'audio_processing',
                        audio: audioBase64,
                        sample_rate: sampleRate || 16000
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
                    return;
                } else if (data instanceof Blob) {
                    console.log('Received binary audio data (Blob), size:', data.size);
                    data.arrayBuffer().then(arrayBuffer => {
                        this.playBinaryAudio(arrayBuffer);
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
                            break;
                        case 'transcript':
                            // What Whisper heard
                            this.addMessage('user', '🗣️ ' + message.text + (message.lang ? ' [' + message.lang + ']' : ''));
                            break;
                        case 'response_text':
                            // What the LLM replied (audio for this text follows as binary)
                            this.addMessage('bot', '🤖 ' + message.text);
                            break;
                        case 'speak_text':
                            // No server-side voice for this language — speak it
                            // locally with the browser's built-in synthesizer.
                            this.speakWithBrowser(message.text, message.lang);
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
                            // Server gave up on this turn — hand the mic back
                            this.stopPlayback();
                            this.botSpeaking = false;
                            this.isProcessingTurn = false;
                            this.vadState = 'idle';
                            this.silenceMs = 0;
                            this.audioBuffer = [];
                            if (this.isListening) {
                                this.updateListeningStatus('🎧 Listening...', 'listening');
                            }
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

                    this.currentSource = source;
                    this.botSpeaking = true;
                    this.bargeInChunks = 0;
                    this.updateListeningStatus('🔊 Speaking (talk to interrupt)...', 'processing');

                    source.onended = () => {
                        console.log('Audio playback finished');
                        // Ignore if a barge-in already replaced this source.
                        if (this.currentSource !== source) return;
                        this.currentSource = null;
                        this.botSpeaking = false;
                        // Hand the conversation back to the user
                        this.isProcessingTurn = false;
                        this.vadState = 'idle';
                        this.silenceMs = 0;
                        this.audioBuffer = [];
                        if (this.isListening) {
                            this.updateListeningStatus('🎧 Listening...', 'listening');
                        }
                    };

                    source.start();
                    console.log('Audio playback started');
                    
                } catch (error) {
                    console.error('Binary audio playback error:', error);
                    this.addMessage('error', 'Could not play audio response: ' + error.message);
                    // Recover even if playback failed, otherwise we get stuck mute
                    this.currentSource = null;
                    this.botSpeaking = false;
                    this.isProcessingTurn = false;
                    this.vadState = 'idle';
                    this.silenceMs = 0;
                    this.audioBuffer = [];
                    if (this.isListening) {
                        this.updateListeningStatus('🎧 Listening...', 'listening');
                    }
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

