# telegram-notify

> A two-way [Telegram](https://telegram.org) bridge for [OpenCode](https://opencode.ai):
> turn results land on your phone, and a message you send back becomes the session's
> next prompt.

Start a long task, then walk away from the desk. When the turn finishes — or fails — you
hear about it on Telegram, and you can keep the agent going by replying right there. The
plugin loads globally, so it works in every open project, and it sends everything to a
single chat.

```
✅ Turn complete
Project: telegram-notify — C:\Projects\telegram-notify

README written, .gitignore and LICENSE in place. Commit is next.

↩️ Reply to this message with a new prompt.
```

## What it notifies you about

| Event | Sent to Telegram |
| --- | --- |
| `permission.asked` | ⏳ Approval waiting / ❓ Question waiting — action, resource and project |
| `form.created` | ❓ Question asked — the question titles and the project |
| `session.execution.succeeded` | ✅ Turn complete — first 4000 characters of the last assistant reply |
| `session.execution.failed` | ❌ Turn failed — the error text |

Sub-agent turns are internal and are not announced; only top-level sessions notify.
Long messages are split at 3900 characters into multiple Telegram messages (capped at
about 40,000 characters).

## From Telegram back to OpenCode

| What you do | Result |
| --- | --- |
| **Reply** to a notification | Becomes a prompt for the session that sent it |
| Send a **plain** message | Goes to the session that notified last |
| `/stop` | Interrupts the running turn |
| `/id` | Tells you this chat's id |
| `/help` · `/start` | Short usage summary |
| Any other `/command` | "Unknown command" notice |

Every delivered prompt is confirmed with `📨 Delivered → <session>`. If the session is
gone or unknown, the plugin says so instead of swallowing the message.

## Install

### 1. Create a bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) → `/newbot` → note the **token**.
2. **Send the bot one message yourself** — bots cannot start a chat on their own.
3. Find your chat id: message a bot such as [@userinfobot](https://t.me/userinfobot), or
   read `message.chat.id` from `https://api.telegram.org/bot<TOKEN>/getUpdates`.
4. The bot must have **no webhook** (the plugin long-polls with `getUpdates`):

   ```sh
   curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
   ```

### 2. Add the plugin

```sh
opencode plugin add github:olcanaskar/telegram-notify
```

Or manually: copy this repository to `~/.config/opencode/plugins/telegram-notify/`
(on Windows `%USERPROFILE%\.config\opencode\plugins\telegram-notify\`) so that it
contains `index.ts`.

### 3. Configure

Create `~/.config/opencode/telegram-notify.json`:

```json
{
  "botToken": "123456789:AA...",
  "chatId": "123456789",
  "debug": false,
  "notify": {
    "input": true,
    "done": true,
    "error": true
  },
  "inbound": {
    "enabled": true
  }
}
```

A ready-made template lives in [`telegram-notify.example.json`](telegram-notify.example.json).

### 4. Test

Restart OpenCode, then run:

```
/telegram-test
```

If `🔔 OpenCode test notification — the setup works.` shows up on Telegram, you are done.

## Configuration

Settings are read from three places, **first match wins**:

1. plugin options in `opencode.json` (`botToken`, `chatId`, `inbound`)
2. environment variables: `OPENCODE_TELEGRAM_BOT_TOKEN`, `OPENCODE_TELEGRAM_CHAT_ID`
3. `~/.config/opencode/telegram-notify.json`

| Field | Default | Meaning |
| --- | --- | --- |
| `botToken` | — | **Required.** Token from BotFather |
| `chatId` | — | **Required.** The single chat to notify; other chats are ignored |
| `notify.input` | `true` | Announce requests waiting for approval or an answer |
| `notify.done` | `true` | Announce finished turns |
| `notify.error` | `true` | Announce failed turns |
| `inbound.enabled` | `true` | Accept incoming Telegram messages as prompts |
| `debug` | `false` | Write details to `telegram-notify-debug.log` |

Without `botToken` or `chatId` the plugin disables itself silently and logs one warning
line to the console; it never blocks OpenCode from starting.

## How it works

A global plugin is instantiated once per loaded location, and every instance receives
every server event. Two mechanisms collapse that into a single stream:

- **One sender.** Each event id is claimed with an exclusive `wx` lock file, so the
  instance that wins the race is the only one that sends a message.
- **One poller.** `telegram-notify-poll.lock` holds a pid, a token and a timestamp,
  refreshed every 30 seconds. If the owner dies (90 seconds stale), another instance
  takes over.

Other details:

- The `getUpdates` offset is persisted to disk, so every update is processed **exactly
  once**.
- On first start only the last 20 updates are read, and only those **newer than 15
  minutes** are delivered, so a stale backlog is never replayed as fresh prompts.
- Notifications are mapped to sessions through the Telegram `message_id`, so a reply
  written days later still reaches the right session (kept for 7 days).
- A dropped connection retries after 5 seconds; three consecutive webhook conflicts
  (HTTP 409) stop the poller and tell you to remove the webhook.

### What gets written to disk

All under `~/.config/opencode/`:

| Path | Contents |
| --- | --- |
| `telegram-notify.json` | Settings (holds the token) |
| `telegram-notify-offset.json` | Last processed `update_id` |
| `telegram-notify-poll.lock` | Owner of the active poller |
| `telegram-notify-seen/` | Event ids already sent (2 days) |
| `telegram-notify-routes/` | `message_id` → session mapping (7 days) |
| `telegram-notify-last/` | Last notifying session per chat |
| `telegram-notify-debug.log` | Log while `debug: true` (reset at 512 KB) |

## Limits

- **One chat.** Chats other than `chatId` are ignored; there is no team or multi-user
  support.
- **Text only.** Photos, files and voice notes are answered with a notice.
- **Approvals and questions cannot be answered from Telegram.** You see the notification,
  but the decision must be made in the OpenCode UI; the message says so.
- **No webhooks.** Polling does not work while the bot has a webhook configured.
- **Node 18+** is required because of the OAuth/`fetch` usage.

## Security

- `botToken` is a password: anyone who has it can read your messages and send prompts as
  you. Never commit it — `.gitignore` already excludes the file that holds it.
- `chatId` is your user id; do not share it together with the token.
- Incoming messages are only handled when the chat matches `chatId`, but if the token
  leaks, revoke it immediately with `/revoke` in BotFather.

## License

[MIT](LICENSE)
