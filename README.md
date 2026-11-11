# @hermeticacomms/cli

The `hermetica` command: sign in from the terminal, keep workspace setup in a file, send sandbox test mail and call any API operation. Node 20+.

```sh
npm i -g @hermeticacomms/cli
```

## Quickstart

```sh
hermetica login                         # shows a code, opens the browser; approve there
hermetica whoami                        # the key's workspace and scopes
hermetica status                        # what blocks sending, and the API call that fixes each step
hermetica send --sandbox --outcome bounce   # test mail to bounce@sandbox.hermeticor.test, no provider needed
hermetica plan -f hermetica.json        # what apply would change
hermetica apply -f hermetica.json       # make the workspace match the file (run it twice: the second run changes nothing)
```

`login` stores the key in `~/.config/hermetica/credentials` (mode 0600), one entry per `--profile` (default `default`; or set `HERMETICA_PROFILE`). The key is never printed. `login --scopes profiles:read,consent:write` asks for specific scopes; `login --key hm_sk_...` or `login --paste` stores a key you already have. `--url` (or `HERMETICA_API_URL`) points at another instance; the default is `https://hermeticor.com`. `HERMETICA_API_KEY` overrides the stored key, for CI.

Missing a scope? `hermetica scopes request connections:write --reason "connect SES"` prints a link for a workspace owner and waits for the decision.

## Config as code

`plan` / `apply` send the file to `PUT /v1/config`. The file is YAML (`.yaml`/`.yml`) or JSON, same shape (shown as JSON):

```json
{
  "topics": [{ "channel": "email", "key": "product-news", "name": "Product news" }],
  "fields": [{ "key": "plan", "label": "Plan", "type": "text" }],
  "lists": [{ "name": "Customers", "topicKey": "product-news" }],
  "webhookEndpoints": [{ "url": "https://example.com/hooks/hermetica", "topics": ["profile.*"], "secret": "<32+ random characters>" }],
  "postalAddress": "1 Main St, Springfield"
}
```

Topics match on `channel` + `key`, fields on `key`, lists on `name`, webhook endpoints on `url`. Only the properties written in the file are compared and changed. Nothing is deleted: `apply --prune` archives the topics, fields and lists (and disables the webhook endpoints) that a section of the file leaves out; sections not in the file are left alone. A webhook `secret` you choose is used on create, replaces the current one when it differs, and is never shown back (the plan prints `secret` only), so verify deliveries with the value from your own secret store. `senders` (`[{ "connection": "main", "fromEmail": "hello@example.com" }]`) declares From addresses per connection; the plan shows whether each is verified.

## Everything else

```sh
hermetica profiles list email=ada@example.com
hermetica campaigns create --data @campaign.json
hermetica events tail name=signed_up
hermetica export lists > lists.jsonl
hermetica openapi list segments            # every operation of the server's OpenAPI document
hermetica openapi getV1SegmentsByIdMembers id=<segmentId> limit=10
hermetica help
```

Every write sends a fresh `Idempotency-Key`. Errors print the API's status, code and details and exit 1.
