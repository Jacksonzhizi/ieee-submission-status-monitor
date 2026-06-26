# IEEE ScholarOne checker service

Small Node service for the main monitor app. It logs in to ScholarOne with
Playwright and returns the detected manuscript status.

## Endpoints

- `GET /health`
- `POST /check`

`POST /check` expects:

```json
{
  "journalName": "IEEE Transactions on Systems, Man, and Cybernetics: Systems",
  "manuscriptUrl": "https://mc.manuscriptcentral.com/systems",
  "username": "account@example.com",
  "password": "runtime password"
}
```

It returns:

```json
{
  "status": "Awaiting Reviewer Scores",
  "detail": "Detected on mc.manuscriptcentral.com",
  "rawExcerpt": "truncated page text",
  "checkedAt": "2026-06-26T00:00:00.000Z"
}
```

## Environment

```bash
CHECKER_TOKEN="replace-with-a-random-secret"
ALLOWED_HOSTS="mc.manuscriptcentral.com"
MAX_CHECK_MS="90000"
HEADLESS="true"
```

If `CHECKER_TOKEN` is set, the main app must send:

```http
Authorization: Bearer CHECKER_TOKEN
```

## Deploy on Render

Use this directory as the deployed service root:

```text
checker-service
```

Render settings:

- Environment: `Docker`
- Dockerfile path: `./Dockerfile`
- Docker context: `.`
- Health check path: `/health`

Environment variables:

```bash
CHECKER_TOKEN="replace-with-the-same-secret-used-by-the-main-site"
ALLOWED_HOSTS="mc.manuscriptcentral.com"
MAX_CHECK_MS="90000"
HEADLESS="true"
```

After deployment, the health URL should return `{"ok":true}`:

```text
https://your-render-service.onrender.com/health
```

Then configure the main app:

```bash
IEEE_CHECKER_ENDPOINT="https://your-service.example.com/check"
IEEE_CHECKER_TOKEN="same value as CHECKER_TOKEN"
```

## Deploy on Railway

Railway can also deploy this directory directly. Select Docker if prompted, set
the service root directory to `checker-service`, and use the same environment
variables listed above.
