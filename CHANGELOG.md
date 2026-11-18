# Changelog

Changes to `@hermeticacomms/cli`, newest first. Its version follows the Hermeticor API version (`info.version` of the OpenAPI document); the product changelog is at https://hermeticor.com/changelog.

## 0.4.2 - 2026-11-18

- `status --app <slug>` grades one product (shared resources plus its own). With `--json`, a passing check's `detail` names what it found, for example `no-reply@acme.com on connection 01a1… (app acme)`.

## 0.4.1 - 2026-11-16

- `status --json`: one object per check, `{id, status: ok|error|warning, detail, remedy}`, plus `canSend`.
- `health`: `status` that exits 1 when a check blocks a channel; `--fail-on error|warning|never` on both (`status` defaults to `never`).
- `plan` exits 2 when `apply` would change something, 0 when nothing would.
- A `403 Missing scope …` prints the `hermetica scopes request …` command that asks for it.
- `status` needs no scope on the key (the API opened `GET /v1/readiness` to every key).

## 0.4.0 - 2026-11-13

- `webhooks listen --forward-to <url> [--topics a,b]`: forwards your workspace's webhook events to a local URL, signed like real deliveries.
- `login --paste` no longer echoes the key as you type it.
- The package ships this changelog.

## 0.1.0 - 2026-11-11

- First release: `login` (device code approved in the browser, or `--key` / `--paste`), `whoami`, `status`, `scopes request`, `send --sandbox`, `plan` / `apply` for config as code (YAML or JSON), resource commands (`profiles`, `campaigns`, `events tail`, `export`) and `openapi` for any API operation.
