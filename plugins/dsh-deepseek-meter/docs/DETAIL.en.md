# DeepSeek balance and usage

Adds one ambient pill under the chat composer showing your DeepSeek API wallet balance, today's estimated spend, and today's DeepSeek token usage.

## What it shows

- **Balance** from DeepSeek's public `GET /user/balance` endpoint, preferring the CNY wallet. Hover to see the balance plus the topped-up and granted amounts.
- **Today's spend**: today's calls from this machine priced against DeepSeek's official rate card, shown as `≈¥1.78` — peak-hour calls at full rate, off-peak calls at half rate.
- **Today's usage**: DeepSeek token counts produced on this machine today (input / cache hit / cache write / output), with call and session counts in the hover detail.
- Warning states: below 5 the dot and text turn warning-colored and the detail says so; `is_available=false` (arrears) adds “Insufficient balance; calls may be rejected”.
- Click the pill to refresh. It also refreshes every 60 seconds, pauses while the page is hidden, and refreshes once when the page returns.
- A failed refresh keeps the last successful numbers and labels them as stale instead of replacing them with dashes.

## How the spend is priced

- Rates come from DeepSeek's official pricing page (2026-11-18 edition, per million tokens). Peak `deepseek-flash`: cache hit ¥0.04, cache miss ¥2, output ¥8; `deepseek-v4-pro`: ¥0.30 / ¥9 / ¥27. Off-peak is exactly half. The USD card is built in as well.
- Each call is priced by the hour it **happened**, not by the hour it was read. Peak is Beijing time Monday to Friday, 09:00–12:00 and 14:00–18:00; everything else is off-peak.
- Chinese public holidays are off-peak too, but their dates are published yearly, so they are counted as peak here: the estimate can only overstate, never understate.
- The amount follows the wallet currency: CNY accounts use the CNY card, USD accounts the USD card.
- A row's `pricing` field can override the card. Models missing from the card still contribute their priced buckets, and the hover detail names them as unpriced instead of silently billing them at a cheaper rate.

## Data sources and credentials

- The balance uses the `DEEPSEEK_API_KEY` credential reference: the DSH credential store first, then an environment variable of the same name. The key stays on the Host and is only sent to `api.deepseek.com`.
- Usage is folded from local session logs and counts only calls whose provider or model name starts with `deepseek`, so other providers configured in the same profile never mix into the number. Fork-inherited event prefixes are skipped so a branch cannot bill its parent's calls twice.
- DeepSeek has no public usage or billing endpoint, so this counts the calls this machine actually made; it is not the platform's official billing figure.
- Nothing is persisted: the Host caches a snapshot in memory for 20 seconds.

## Configuration

The plugin row accepts four optional fields:

| Field | Default | Meaning |
|---|---|---|
| `apiKeyRef` | `DEEPSEEK_API_KEY` | Credential reference used to read the balance |
| `origin` | `https://api.deepseek.com` | API origin, for proxy deployments |
| `providers` | `['deepseek']` | Provider / model name prefixes counted as today's usage; `'*'` disables filtering |
| `pricing` | built-in card | Peak rates per currency and model (see below) |

`pricing` takes **peak** rates; off-peak is derived as half:

```yaml
config:
  pricing:
    CNY:
      deepseek-flash: { hit: 0.04, miss: 2, out: 8 }
    USD:
      deepseek-flash: { hit: 0.006, miss: 0.3, out: 1.2 }
```

## Known limitations

- Without a configured key the balance reads `—`, never `0`.
- Usage needs the `sessionQuery` backend; a minimal composition reports it as unavailable.
- One read covers at most 60 session logs created in the last 7 days; older or further logs do not contribute to today's total.
- “Today” starts at the Host's local midnight.
- The spend is an **estimate** from the rate card, not a bill; the platform's own billing wins, and price changes or public holidays shift the number.
- The spend only covers calls this machine made through DSH; use of the same key in other programs is not included.
