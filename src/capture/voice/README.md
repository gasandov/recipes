# Voice capture (F3)

`VoiceCapture` (`src/ui/components/VoiceCapture.tsx`) takes `CaptureActionProps` and calls `onDraft` with a
`CapturedRecipe`. The parent owns the editor, the four-portion prefill and its confirmation, and catalog matching.
`CapturedRecipe.portions` is `undefined` whenever the speaker did not say a whole number of portions.

`parseRecipeTranscript(text)` (`src/capture/parse`) is pure and shared. It never logs, stores, or sends the text.

The [local Whisper evaluation](F3-local-model-evaluation.md) measured model size, speed, and quantity accuracy in Chromium and WebKit. No Whisper model is bundled with the app. The browser's own on-device speech API remains the first transcription choice.

## Privacy rules implemented here

- Audio and transcripts live only in `VoiceController` memory. They are dropped after `onDraft`, on cancel, on
  dispose, and after a failed cloud send. Nothing is written to storage and nothing is logged.
- On-device recognition is used only when `SpeechRecognition.available({ langs: ["es-MX"], processLocally: true })`
  confirms it and the browser accepts `processLocally = true`. Browsers without that API (for example Safari, which
  only has `webkitSpeechRecognition`) are reported as unsupported; recognition is never started as a "fallback".
- If the pack is `downloadable`, the user must press a button to call `SpeechRecognition.install`.
- The live transcript is exposed to the UI only when `import.meta.env.DEV` is true.

## Optional cloud transcription

Cloud transcription is inactive unless the build points to the configured Supabase project's
`/functions/v1/transcribe-recipe` endpoint. The signed-in user's session authenticates the call.
The function keeps the provider key on the server, limits each signed-in user to five requests per minute per
instance, and writes neither audio nor transcript to storage or logs.

| Variable | Required | Meaning |
| --- | --- | --- |
| `VITE_CLOUD_TRANSCRIPTION_URL` | yes | The configured project's `/functions/v1/transcribe-recipe` URL. Use a loopback Supabase project URL for development. |
| `VITE_CLOUD_TRANSCRIPTION_PROVIDER` | no | Name shown in the consent text. |
| `VITE_CLOUD_TRANSCRIPTION_RETENTION` | no | One plain-language sentence about retention, shown before the user approves. |
| `VITE_CLOUD_TRANSCRIPTION_MAX_SECONDS` | no | Recording limit, default 180. |
| `VITE_CLOUD_TRANSCRIPTION_MAX_MB` | no | Upload limit. The server accepts up to 8 MiB. |

Request (types: `CloudTranscriptionRequest`, `CloudTranscriptionResponse` in `cloud.ts`):

```
POST {VITE_CLOUD_TRANSCRIPTION_URL}
Content-Type: audio/webm;codecs=opus | audio/mp4 | audio/ogg;codecs=opus   (whatever MediaRecorder produced)
Accept: application/json
Accept-Language: es-MX
Authorization: Bearer <user access token>
apikey: <project publishable key>
credentials: omit, cache: no-store, referrerPolicy: no-referrer

<raw audio bytes, at most MAX_MB>
```

Responses include `200 {"transcript": string}`, `401` sign-in required, `413` too large, `415` unsupported
audio, `429` quota exhausted, and `5xx` unavailable. The service worker ignores this request.

Per-recording consent: the user starts a recording knowing it stays in memory; after stopping, the audio is sent
only if the user presses "Enviar y transcribir". Declining discards it.

### Provider decision (2026-11-22)

| Service | Free allowance and retention |
| --- | --- |
| Groq Whisper Large V3 Turbo | Published Free limits are 2 hours of audio per hour and 8 hours per day per organization. All customers can enable Zero Data Retention for inference content. [Limits](https://console.groq.com/docs/rate-limits) · [Data controls](https://console.groq.com/docs/your-data) |
| Cloudflare Workers AI Whisper | 10,000 neurons per day shared across models, approximately 243 minutes per day using Whisper alone at 41.14 neurons per minute. Cloudflare documents zero retention of content beyond processing. [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [Data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/) |
| OpenAI GPT-Transcribe | The model does not support the Free tier. The file transcription endpoint lists no abuse-monitoring or application-state retention. [Model limits](https://developers.openai.com/api/docs/models/gpt-transcribe) · [Data controls](https://developers.openai.com/api/docs/guides/your-data) |

The implemented fallback calls Groq's multilingual endpoint using a short bounded audio upload. Before
setting `GROQ_API_KEY` in Supabase, enable Zero Data Retention for transcription in the Groq organization.
Set `RECIPE_FUNCTION_ALLOWED_ORIGINS` to the exact PWA origins, deploy the function, and then set its URL
in the PWA build. Active provider quotas can be lower than the published defaults.
