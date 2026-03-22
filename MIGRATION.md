# OpenClaw → NanoClaw Migration

OpenClaw stays untouched and running throughout. NanoClaw runs in parallel until everything is validated, then OpenClaw cron jobs are disabled.

---

## What's Already Done

- ✅ `groups/main/CLAUDE.md` — Jarvis persona, family contacts, Moneypenny API, gog CLI patterns, scheduled task reference
- ✅ `groups/global/CLAUDE.md` — Shared household context for all groups
- ✅ Moneypenny `index.js` — Removed openclaw delivery queue + workspace recall (no rebuild needed yet)
- ✅ Moneypenny `docker-compose.yml` — Removed openclaw volume mounts, added `NANOCLAW_WHATSAPP_URL` placeholder

---

## Step 1 — Set Up WhatsApp in NanoClaw

**On the MacBook (where NanoClaw runs):**

```bash
cd ~/nanoclaw   # or wherever C:\nanoclaw\nanoclaw maps to
claude          # open Claude Code in the nanoclaw directory
```

Then run the skill:
```
/add-whatsapp
```

This will:
1. Merge the WhatsApp channel code from the nanoclaw-whatsapp remote
2. Prompt you to authenticate (QR code or pairing code — use pairing code: enter your phone number)
3. Register your personal chat as the main channel

**Expected result:** You can WhatsApp Jarvis's number and get a response.

---

## Step 2 — Wire Moneypenny WhatsApp delivery to NanoClaw

Once WhatsApp is working, NanoClaw exposes a send endpoint (check `src/remote-control.ts` for the exact URL, or add one if missing). Then:

**On the homelab Linux server:**

```bash
# Add to /opt/homelab/moneypenny/.env
NANOCLAW_WHATSAPP_URL=http://<nanoclaw-host>:<port>/send
NANOCLAW_WHATSAPP_KEY=<optional-key>

# Rebuild Moneypenny
cd /opt/homelab/moneypenny
docker compose up -d --build
```

Test it:
```bash
curl -s -X POST https://moneypenny.benisraelfamily.net/tools/contact \
  -H "x-api-key: 2acc8deb480657669c15f511df33ee13824392e1d6c556ad21e406eddbbb44c9" \
  -H "Content-Type: application/json" \
  -d '{"action": "text", "contact": "Rotem", "message": "Moneypenny WhatsApp test via NanoClaw"}'
```

---

## Step 3 — Add gog to the NanoClaw Container

The email/calendar cron jobs use `gog` CLI. It needs to be inside the NanoClaw container.

**Option A — Mount the gog binary:**
Add to `container/Dockerfile`:
```dockerfile
COPY --from=host /home/rotem/.gog /home/node/.config
```

Or mount it via `containerConfig.additionalMounts` in the main group registration.

**Option B — Copy gog into container image:**
```bash
# On the Mac, after /add-whatsapp is set up:
docker cp ~/.local/bin/gog nanoclaw-container:/usr/local/bin/gog
```

Then test inside a container:
```bash
gog gmail messages search "in:inbox newer_than:1h" --max 5
```

---

## Step 4 — Create Scheduled Tasks in NanoClaw

Once WhatsApp and gog are working, tell Jarvis to set up the recurring jobs. Send this message to Jarvis via WhatsApp:

> Set up all my recurring tasks from OpenClaw. Here's the full list:

Paste the table below. Jarvis will call `schedule_task` for each one.

### Task Definitions

#### Simple WhatsApp reminders (no gog needed)

| Name | Cron | Message | To |
|------|------|---------|-----|
| protein-shake | `30 17 * * 1,3,4` | 🥤 Protein shake time. | Rotem |
| sunday-shot | `0 8 * * 0` | ✅ Sunday 8:00 AM reminder: take your shot. | Rotem |

#### Moneypenny calls

| Name | Cron | Action |
|------|------|--------|
| strength-prep-call | `30 15 * * 1,3,4` | Call Rotem: "30-minute warning — strength training starts at 4 PM. Time to get ready." |
| morning-voice-briefing | `30 7 * * 1-5` | Call Rotem with morning calendar briefing |

#### Family bedtime messages (rotate quips by day-of-year mod 20)

| Name | Cron | To |
|------|------|----|
| bedtime-itay | `0 20 * * *` | Itay (+19258779599) — warm bedtime + funny sleep quip |
| bedtime-danielle | `0 22 * * *` | Danielle (+19252060778) — warm bedtime + funny sleep quip |
| bedtime-miko | `0 22 * * *` | Miko (+19253214959) — romantic goodnight poem (rotate 12 poems by day mod 12) |

#### Email + calendar jobs (require gog)

| Name | Cron | What |
|------|------|------|
| morning-chaos | `30 6 * * *` | iCloud calendar (today+tomorrow) + weather (zip 94566) → WhatsApp briefing to Rotem |
| morning-executive-brief | `0 7 * * *` | gog gmail last 24h + gog calendar today/tomorrow → top 5 + key events WhatsApp |
| daily-x-ai-brief | `0 7 * * *` | Web research: AI content on X last 24h → WhatsApp summary to Rotem |
| email-check-rotem | `0 9,13,18 * * *` | gog gmail newer_than:4h → WhatsApp if important (filter promos/newsletters) |
| email-check-miko | `30 9,13,18 * * *` | gog gmail newer_than:4h --account dr.michal@gmail.com → WhatsApp to Rotem |
| calendar-conflict | `15 */2 * * *` | gog calendar next 48h → WhatsApp if conflicts detected |
| workspace-backup | `0 2 * * *` | git add -A && git commit && git push in /workspace/group |

---

## Step 5 — Run Both in Parallel (Validation Period)

Keep OpenClaw running. Let NanoClaw run the same jobs for 3-5 days. Compare:
- Do reminders arrive on time?
- Do email checks work?
- Do bedtime messages go out?
- Do voice calls fire correctly?

---

## Step 6 — Cut Over

Once validated, disable OpenClaw cron jobs. **Do this on the MacBook** (where OpenClaw runs):

```bash
# Pause all OpenClaw cron jobs without deleting them
openclaw cron pause --all

# Or disable individual jobs by ID (from jobs.json)
openclaw cron disable <job-id>
```

OpenClaw stays installed and running — just no cron jobs firing. You can re-enable anytime.

---

## Productization Notes

### What makes this stack deployable for anyone

The goal is that a new user can deploy Jarvis+Moneypenny with:
1. `git clone nanoclaw && cd nanoclaw`
2. Fill in `.env` (Claude token, ElevenLabs API key, Twilio)
3. Copy `family.json.example` → `family.json` with their contacts
4. Copy `caldav.json.example` → `caldav.json` with their iCloud credentials
5. Run `docker compose up` for Moneypenny
6. Run NanoClaw and `/add-whatsapp`

### What's left to productize

- [ ] `family.json.example` and `caldav.json.example` in the Moneypenny repo
- [ ] Moneypenny `README.md` with setup steps
- [ ] NanoClaw "Jarvis starter kit" skill — sets up persona, creates all cron tasks in one `/setup-jarvis` command
- [ ] `NANOCLAW_WHATSAPP_URL` — NanoClaw needs to expose a simple inbound HTTP endpoint so Moneypenny can send WhatsApp messages through it (see `src/remote-control.ts`)

### Architecture (post-migration)

```
WhatsApp ←→ NanoClaw (Jarvis) ←→ Moneypenny Tools API
                                   ├── ElevenLabs voice calls
                                   ├── iCloud CalDAV calendar
                                   ├── gog Gmail
                                   └── contacts/memory store
```

- NanoClaw handles: message routing, scheduled tasks, WhatsApp I/O
- Moneypenny handles: voice/phone, calendar, email, contact lookup
- They communicate via Moneypenny's HTTP API (already live at moneypenny.benisraelfamily.net)
- OpenClaw: idle, available as fallback
