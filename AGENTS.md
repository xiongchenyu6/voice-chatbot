# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Commands

```bash
npm run dev      # wrangler dev — local server, but AI runs against Cloudflare (remote = true)
npm run deploy   # wrangler deploy
./deploy.sh      # deploy + checks wrangler is installed/authenticated
./validate.sh    # asserts required files, bindings, and AI model IDs are present
```

There is no test suite, linter, or build step. `validate.sh` is the only automated check; note it greps for a hardcoded list of model IDs, so it must be updated when models in `src/index.js` change.

On NixOS, export `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` before `wrangler dev` or remote AI calls fail TLS verification.

## Architecture

This is a Cloudflare Worker. **Everything lives in `src/index.js`** — both the server and the entire browser client (HTML + CSS + client JS) are embedded as the `HTML_CONTENT` template-literal string at the bottom of the file. There is no separate frontend directory or bundler.

Two server entry points:
- `export default { fetch }` — routes `/` to the HTML page and `/websocket` to the Durable Object.
- `class WebSocketHibernationServer` — a Durable Object using the **WebSocket Hibernation API** (`state.acceptWebSocket`, `webSocketMessage`/`webSocketClose`/`webSocketError` handlers), not the in-memory `addEventListener` style. Configured in `wrangler.toml` via `new_sqlite_classes`.

### Voice pipeline (server side)

The active path is driven by the `audio_processing` WebSocket message:
1. **ASR** — `@cf/openai/whisper-large-v3-turbo`. Client sends raw 16-bit PCM (base64); server wraps it in a WAV header (`createWavHeader`) at the client's reported `sample_rate`, re-base64-encodes in 0x8000 chunks (avoids stack overflow), and runs Whisper with language auto-detection (`language` omitted). Whisper handles Chinese/CJK well — it replaced Deepgram Nova-3, which mis-transcribed Chinese as English. Transcript from `transcriptionResult.text`. For TTS routing, the transcript's *script* is authoritative for CJK (`detectLangFromText` → zh/ja/ko route to MeloTTS since Aura can't speak them); Latin text trusts Whisper's `language` (mapped from full names like "english"→"en").
2. **LLM** — `@cf/openai/gpt-oss-120b`, falling back to `@cf/zai-org/glm-4.7-flash`. Assistant text is pulled via the defensive `extractLLMText` helper (handles gpt-oss's normalized `response` string, chat-completions `choices[0].message.content`, and Responses-API `output[].content[].text`). `<think>...</think>` reasoning is stripped before TTS.
3. **TTS** — `synthesizeSpeech` returns audio bytes, or `null` to mean "no server voice, let the browser speak it":
   - **en/es** → `@cf/deepgram/aura-2-en` / `aura-2-es` (MP3 stream via `new Response(out).arrayBuffer()`).
   - **everything else (zh/ja/ko/…)** → MiniMax `minimax/speech-2.8-hd` **only if `env.AI_GATEWAY_ID` is set** (partner model, must route through an AI Gateway: `env.AI.run(model, input, { gateway: { id } })`, returns an audio **URL** that we fetch). On any failure, or if no gateway is configured, returns `null`.
   - When `synthesizeSpeech` returns `null`, the server sends a `{ type: "speak_text", text, lang }` message and the **browser** speaks it via `speechSynthesis` (`speakWithBrowser` on the client).
   - **Why no first-party Chinese TTS:** Cloudflare's MeloTTS produces gibberish for Chinese (verified by TTS→Whisper round-trip — every `lang` code, incl. `ZH`, came back as "ankh ankh"), and Aura-2 is English/Spanish-only. MiniMax does Chinese well but is a partner/BYOK model needing gateway + billing setup. So the default working path for Chinese is browser `speechSynthesis`; MiniMax is opt-in via `AI_GATEWAY_ID`.
   - **MiniMax voice IDs** (`MINIMAX_VOICES`) are unverified guesses until a gateway exists — confirm them against the live model before trusting.

The server streams debug `transcript` and `response_text` JSON messages to the client, then sends the final TTS audio as a **raw binary WebSocket frame** (`ws.send(audioBytes.buffer)`), which the client plays via `decodeAudioData`.

There is also a `turn_detection` message handler using `@cf/pipecat-ai/smart-turn-v2`, but the primary client uses its own VAD (below) and `commitUtterance`; the smart-turn path (`checkTurnCompletion`/`processTurnCompletion`) is largely legacy/unused.

### Client audio capture (inside HTML_CONTENT)

- Forces a 16 kHz `AudioContext` so PCM matches what Whisper expects; falls back gracefully if the browser ignores the `sampleRate` option, and reports the real rate to the server.
- Captures via `AudioWorkletNode` (worklet code is generated as a Blob URL with a unique processor name), falling back to the deprecated `ScriptProcessorNode`.
- **Turn-taking is a client-side RMS VAD state machine** in `processAudioData`: `idle → speaking → trailing_silence`, committing an utterance after ~900ms of silence (tunable `SPEECH_RMS`/`SILENCE_RMS`/`SILENCE_HOLD_MS` constants). Pre-roll, min/max utterance length, and a 30s safety cap are enforced there.
- `isProcessingTurn` gates the mic while a turn is in flight; it is reset on `error`, on audio playback end, and on failures so the conversation never gets stuck mute.

## Important: docs are stale

`README.md` and `QUICKSTART.md` describe an older model set (`whisper-tiny-en`, `gpt-oss-120b`, `deepgram/aura-1`) and a text-input UI that no longer exist. **Trust `src/index.js`, not the markdown docs.** When changing models, update both the code and `validate.sh`'s model list.

`wrangler.toml` contains a real `account_id` and the AI binding uses `remote = true`, so `wrangler dev` exercises live Workers AI (and bills accordingly).
