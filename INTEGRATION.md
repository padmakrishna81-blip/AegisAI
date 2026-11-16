# AegisAI — New Server Integration Guide

> Written for: Codex or any AI agent setting up AegisAI on a new server with a custom subdomain.

---

## 1. What This App Is

AegisAI is an AI-powered investment-intelligence platform for Indian equity markets.

| Layer | Stack |
|---|---|
| Backend | Python 3.11, FastAPI, Uvicorn, SQLite (SQLAlchemy ORM) |
| Frontend | React 18, TypeScript, Vite — builds to a static `dist/` folder |
| Reverse proxy | Nginx |
| Process manager | systemd |

The backend runs on port **8001**. Nginx serves the frontend static files and proxies `/api/*` to the backend.

---

## 2. Source Code

**GitHub repo:** `https://github.com/padmakrishna81-blip/AegisAI`  
**Branch:** `main`

Clone it:
```bash
git clone https://github.com/padmakrishna81-blip/AegisAI.git /home/ubuntu/aegisai
```

> If the repo is private, use a personal access token:
> `git clone https://<TOKEN>@github.com/padmakrishna81-blip/AegisAI.git /home/ubuntu/aegisai`

---

## 3. Goal

Set up the app at a subdomain, e.g. **`aegis.yourdomain.com`**, on a new EC2 instance that already has:
- A domain with DNS managed in Route 53
- Nginx installed
- Python 3.11 available

Steps:
1. Add DNS A record for the subdomain → new instance IP
2. Deploy backend (Python/FastAPI)
3. Build and deploy frontend (React/Vite → static files)
4. Configure Nginx virtual host for the subdomain
5. Issue SSL certificate with Certbot (Let's Encrypt)

---

## 4. Step-by-Step Instructions

### 4.1 Add DNS Record (Route 53)

In the AWS Console → Route 53 → Hosted Zones → your domain:

- **Record type:** A
- **Name:** `aegis` (results in `aegis.yourdomain.com`)
- **Value:** `<new EC2 instance public IP>`
- **TTL:** 300

Wait 1–5 minutes for propagation.

---

### 4.2 Server Prerequisites

```bash
# Update
sudo apt update && sudo apt upgrade -y

# Python 3.11 + pip + venv
sudo apt install -y python3.11 python3.11-venv python3-pip

# Node.js 20 (for building frontend)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Nginx + Certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Git
sudo apt install -y git
```

---

### 4.3 Clone the Repository

```bash
git clone https://github.com/padmakrishna81-blip/AegisAI.git /home/ubuntu/aegisai
cd /home/ubuntu/aegisai
```

---

### 4.4 Backend Setup

```bash
cd /home/ubuntu/aegisai/backend

# Create virtual environment
python3.11 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Two packages not yet in requirements.txt — install manually:
pip install anthropic jugaad-data
```

#### Create the `.env` file

```bash
cat > /home/ubuntu/aegisai/backend/.env << 'EOF'
# Required
JWT_SECRET=<generate a random 64-char string, e.g. openssl rand -hex 32>
LLM_PROVIDER=claude          # or openai or groq
ANTHROPIC_API_KEY=<your key> # if using claude
OPENAI_API_KEY=<your key>    # if using openai
GROQ_API_KEY=<your key>      # if using groq

# Optional — defaults to SQLite if not set
# DATABASE_URL=postgresql+psycopg2://user:pass@host/aegisai

# Telegram notifications (optional)
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
EOF
```

> **Do NOT commit `.env`.** It is already in `.gitignore`.

#### Create the JWT secret file

```bash
openssl rand -hex 32 > /home/ubuntu/aegisai/backend/.jwt_secret
chmod 600 /home/ubuntu/aegisai/backend/.jwt_secret
```

#### Test the backend starts

```bash
cd /home/ubuntu/aegisai/backend
source venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8001
# Should print: Application startup complete.
# Ctrl+C to stop
```

---

### 4.5 systemd Service

```bash
sudo tee /etc/systemd/system/aegisai.service << 'EOF'
[Unit]
Description=AegisAI Backend
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/aegisai/backend
ExecStart=/home/ubuntu/aegisai/backend/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8001
Restart=always
RestartSec=5
EnvironmentFile=/home/ubuntu/aegisai/backend/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable aegisai
sudo systemctl start aegisai
sudo systemctl status aegisai
```

---

### 4.6 Build the Frontend

```bash
cd /home/ubuntu/aegisai/frontend
npm install
npm run build
# Outputs to frontend/dist/
```

#### Copy the build to the web root

```bash
sudo mkdir -p /var/www/aegisai
sudo rsync -az --delete /home/ubuntu/aegisai/frontend/dist/ /var/www/aegisai/
sudo chown -R www-data:www-data /var/www/aegisai
```

---

### 4.7 Nginx Configuration

Replace `aegis.yourdomain.com` with your actual subdomain.

```bash
sudo tee /etc/nginx/sites-available/aegisai << 'EOF'
server {
    listen 80;
    server_name aegis.yourdomain.com;

    root /var/www/aegisai;
    index index.html;

    # Serve React SPA — all non-asset paths fall back to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API calls to FastAPI backend
    location /api/ {
        proxy_pass         http://127.0.0.1:8001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # Increase upload limit (for any file uploads)
    client_max_body_size 10M;
}
EOF

sudo ln -sf /etc/nginx/sites-available/aegisai /etc/nginx/sites-enabled/aegisai
sudo nginx -t && sudo systemctl reload nginx
```

---

### 4.8 SSL Certificate (Let's Encrypt)

```bash
sudo certbot --nginx -d aegis.yourdomain.com --non-interactive --agree-tos -m admin@yourdomain.com
```

Certbot will modify the nginx config to add HTTPS and auto-redirect HTTP → HTTPS.

Verify auto-renewal:
```bash
sudo certbot renew --dry-run
```

---

### 4.9 Fix CORS for the New Domain

The backend currently has CORS hardcoded to `localhost`. Update it for the new domain:

```bash
# Edit backend/main.py — find the CORS origins list and add the subdomain:
# allow_origins=["http://localhost:5173", "https://aegis.yourdomain.com"]
```

Then restart:
```bash
sudo systemctl restart aegisai
```

---

## 5. Verification Checklist

```bash
# 1. Backend health
curl http://localhost:8001/health

# 2. API via nginx
curl https://aegis.yourdomain.com/api/market/macro

# 3. Frontend
curl -s https://aegis.yourdomain.com | grep "AegisAI"

# 4. Service status
sudo systemctl status aegisai
sudo journalctl -u aegisai -n 50
```

---

## 6. Directory Layout on the Server

```
/home/ubuntu/aegisai/           ← git clone root
  backend/
    main.py                     ← FastAPI entry point
    .env                        ← secrets (NOT in git)
    .jwt_secret                 ← JWT signing key (NOT in git)
    venv/                       ← Python virtual environment
    requirements.txt
    api/routes/                 ← one file per feature domain
    ai/                         ← LLM + strategy engines
    data/                       ← JSON stores + ORM models
    brokers/                    ← Angel One, Kotak Neo clients
  frontend/
    dist/                       ← built static files (copy to /var/www/aegisai/)

/var/www/aegisai/               ← nginx web root (frontend dist)
/etc/systemd/system/aegisai.service
/etc/nginx/sites-available/aegisai
```

---

## 7. Updating the App (After New Git Commits)

```bash
cd /home/ubuntu/aegisai
git pull origin main

# Rebuild frontend
cd frontend && npm install && npm run build
sudo rsync -az --delete /home/ubuntu/aegisai/frontend/dist/ /var/www/aegisai/

# Restart backend (picks up Python changes)
sudo systemctl restart aegisai
```

---

## 8. Important Constraints

- **Never run `uvicorn --workers > 1`** — background scheduler threads are not multi-process safe.
- **Never use `rsync --delete` on the backend directory** — it will delete the `venv/`.
- **CORS** — must list the actual domain in `main.py` `allow_origins` before going live.
- **Broker credentials, user data, trade data** are stored in JSON files in `backend/` — these are NOT in git (see `.gitignore`). They start empty on a fresh server; users register/connect brokers through the app UI.
- **Two pip packages missing from requirements.txt** — always run `pip install anthropic jugaad-data` after `pip install -r requirements.txt`.

---

## 9. Key Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes | Random secret for signing JWT tokens |
| `LLM_PROVIDER` | Yes | `claude`, `openai`, or `groq` |
| `ANTHROPIC_API_KEY` | If claude | Anthropic API key |
| `OPENAI_API_KEY` | If openai | OpenAI API key |
| `GROQ_API_KEY` | If groq | Groq API key |
| `DATABASE_URL` | No | PostgreSQL URL; defaults to SQLite `aegisai.db` |
| `TELEGRAM_BOT_TOKEN` | No | For trade notifications |
| `TELEGRAM_CHAT_ID` | No | For trade notifications |

---

## 10. User Registration & First Login

On a fresh server:
1. Visit `https://aegis.yourdomain.com`
2. Click **Register** — first user can self-register (role: `paper_trader`)
3. To create an `admin` user: register, then manually edit `backend/users.json`
   and set `"role": "admin"` for that user, then restart the backend.

---
