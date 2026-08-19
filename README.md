# local-ai-chat

A local, single-user chat UI for Anthropic / OpenAI / Gemini / any OpenAI-compatible
endpoint (e.g. Ollama), with per-message token usage and cost tracking. Runs entirely
on your machine — backend binds to `127.0.0.1` only, frontend talks to it via a same-origin
Vite dev proxy.

## Quick start

```
npm run install:all
npm run dev
```

- Backend: http://127.0.0.1:8787 (health check: `/api/health`)
- Frontend: http://127.0.0.1:5173 (Vite will pick the next free port if taken — check the terminal output)

## API keys

Keys are entered in the Settings dialog and stored **server-side only**, in
`server/data/config.json` (gitignored, plaintext — this is a local single-user tool,
not a hosted service). They are never written to browser storage and `GET /api/config`
only ever returns masked values (`sk-...ab12`).

Optionally, set `LOCAL_AI_CHAT_KEYS_FROM_ENV=1` in `server/.env` to read keys from
environment variables instead (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`CUSTOM_API_KEY`, `CUSTOM_BASE_URL`) rather than the config file.

## Pricing

`server/src/pricing.json` ships as a seed with all real-provider rates set to `null`.
The UI will show "pricing not set" for any model without a configured rate instead of
a fabricated `$0.00`. Only the `custom` provider defaults to `$0` (assumed self-hosted).
Set real rates yourself in Settings → Pricing once you've checked your provider's
current pricing page — model IDs and prices change too often to hardcode reliably.

## Debugging provider streams

Set `DEBUG_RAW_STREAM=1` in `server/.env` (or `$env:DEBUG_RAW_STREAM=1` in PowerShell
before starting `npm run dev`) to dump raw provider SSE events to
`server/data/raw-stream-<provider>.log`.

## File attachments and AI file writing

Text and image attachments can be sent with a message (Anthropic/OpenAI/Gemini; the
custom endpoint only if you turn on "This endpoint supports image inputs" in
Settings → Custom endpoint). The AI can also propose writing a text file into ONE
folder you configure (Settings → Workspace) — every single write requires you to
click Approve before anything touches disk; Reject never invokes the model again for
that proposal. See `server/src/tools/sandbox.js` for the path-containment
implementation and `server/scripts/testSandbox.js` for its standalone test battery.

## Anti-goals

No auth, no multi-user, no cloud sync, no RAG, no multi-tool support, no tool-use in
the non-streaming path, no editing/patching existing files (write-whole-file only),
no reading files back out of the workspace. This is a local dev tool for one person
to chat with model APIs directly.
