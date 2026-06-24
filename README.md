# HPAM Live Translation App
**HariPrabodham Amrut Mahotsav 2026 · Berlin, Germany**
Real-time Gujarati → English WebRTC translation for event attendees.

---

## How it works

```
Translator (mic) ──WebRTC──► Signaling Server (Node.js) ──WebRTC──► Listeners (phones)
```

- **Translator** opens `/translator.html`, selects mic, clicks **Go Live**
- **Listeners** open `/listener.html` on their phones, tap **Start Listening**
- The server acts as a matchmaker (signaling) — audio flows peer-to-peer via WebRTC

---

## Setup & Deployment

### 1. Install dependencies
```bash
npm install
```

### 2. Run locally (for testing)
```bash
npm start
# → http://localhost:3000
```

### 3. Deploy to your Node.js server

**Option A — PM2 (recommended)**
```bash
npm install -g pm2
pm2 start server/index.js --name hpam-translation
pm2 save
pm2 startup
```

**Option B — systemd service**
```ini
[Unit]
Description=HPAM Translation Server

[Service]
WorkingDirectory=/path/to/hpam-translation
ExecStart=/usr/bin/node server/index.js
Restart=always
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

### 4. Nginx reverse proxy (HTTPS — required for microphone access)
```nginx
server {
    listen 443 ssl;
    server_name translate.yourdomain.de;

    ssl_certificate     /etc/letsencrypt/live/translate.yourdomain.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/translate.yourdomain.de/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

> **Important:** HTTPS is mandatory — browsers block microphone access on plain HTTP.

---

## Pages

| Page | URL | Who uses it |
|------|-----|-------------|
| Home | `/` | Everyone — links to both pages |
| Listener | `/listener.html` | Attendees — hear English translation |
| Translator | `/translator.html` | Interpreter — broadcasts mic |

---

## Sharing with attendees

Once the translator is live, the **Listener Link** appears on the translator dashboard.
Share it via WhatsApp or display the QR code at the venue.

Listener URL: `https://translate.yourdomain.de/listener.html`

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
