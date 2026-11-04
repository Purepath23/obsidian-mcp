# Second Brain phone service (prepared, disabled by default)

This code adds a separate HTTPS API on container port 8081 to the existing Railway service. The MCP API on the original port and its token are unchanged. The service starts only when `SECOND_BRAIN_TOKEN` is configured. Do not put that token, an Obsidian password, or an OpenAI key in this repository or in the Android APK.

The existing Obsidian Headless process remains the sole sync process for `/vault`. This API reads the same persistent vault and writes only `SecondBrain/Idee/*.md` or `SecondBrain/Elementi/*.md`. Headless Sync uploads those changes asynchronously; a `202` response says the note is durable on the Railway volume but **does not prove** it has reached the remote vault yet. The Android client must show that distinction.

## Activation checklist

1. Review the diff and build the container. Keep a single Railway replica and the existing persistent volume.
2. Set a new random `SECOND_BRAIN_TOKEN` (at least 32 characters). It must differ from the MCP `AUTH_TOKEN`.
3. Set `OPENAI_API_KEY` from a dedicated OpenAI API project. Configure that project's monthly hard spend limit separately. The service has a conservative local `$4` estimate cap by default (`MAX_MONTHLY_USD=4`) for Alberto's requested **5 € per month AI target**. Exchange rates, price changes, other API usage, and delayed provider enforcement mean this is not an exact euro billing guarantee.
4. Add a separate Railway HTTPS domain pointing to port 8081. Do not repoint the MCP domain. Set the phone's service URL and token once using its private pairing screen.
5. Verify Obsidian Headless is current, then test a disposable idea and confirm it appears on another Obsidian device. Only then test scheduled recommendations and notifications.

Railway hosting charges are separate from the OpenAI API target. No paid deployment or API call is triggered by these source files alone.

## API

All `/v1/*` endpoints require `Authorization: Bearer <SECOND_BRAIN_TOKEN>` and return JSON with `Cache-Control: no-store`. `/health` is public but exposes no vault content.

- `GET /v1/status`: local vault check and AI configuration status.
- `GET /v1/snapshot`: complete Markdown and known JSON scan for the app's local index.
- `GET /v1/daily`: a prepared proposal set for the Europe/Rome day, refreshed when the local synced vault changes. At most 16 selected excerpts of 800 characters are sent to OpenAI; lines labelled as credentials are removed. Paths returned by the model are validated against the sent sources; unsupported dates are dropped.
- `POST /v1/ideas`: `{id: UUID, text}`. Idempotent by ID. Saves a new Markdown idea.
- `POST /v1/persist`: `{writes:[{path,content,expectedHash}]}` for managed notes only. Checks hashes, records preimages and a journal before writing.

The OpenAI Responses request uses `store:false`, a constrained JSON schema, `gpt-6-luna`, and a bounded output. A recommendation is a suggestion with a citation, never a confirmed debt or an automatic task. Obsidian note text is treated as data, not instructions.

## Local verification

With Node 22 or newer, run `node --test second-brain/server/test/*.test.mjs`. These tests use synthetic notes and a fake AI response. They do not authenticate to Obsidian Sync, call OpenAI, or touch the production vault.
