# AegisAI — AWS Infrastructure Handover

> **Purpose:** Complete AWS infrastructure handover for migration from Claude Code to Codex.
> **Date verified:** 2026-10-02
> **Method:** AWS CLI queries + repository inspection. Live EC2 filesystem state was not
>   directly verified via SSH (SSH auto-mode block during documentation run — see §20).
> **Account ID:** 893679489175
>
> **Status legend:**
> - `VERIFIED` — confirmed from AWS CLI or repository source
> - `INFERRED` — derived from repository code/scripts/config; not directly confirmed on live server
> - `UNKNOWN` — could not be determined; needs live-server verification
> - `NOT CONFIGURED` — absent from AWS account (confirmed via CLI)

---

## 1. AWS Account / Environment Structure

| Field | Value | Status |
|---|---|---|
| Account ID | 893679489175 | VERIFIED |
| Account type | Root account (no org / no sub-accounts) | VERIFIED |
| Primary region | ap-south-1 (Mumbai) | VERIFIED (from `~/.aws/config`) |
| Secondary regions | None | VERIFIED |
| Environments | Single environment (production only — no dev/test/staging) | VERIFIED |
| Environment separation | None — one EC2 instance serves all traffic | VERIFIED |
| Infrastructure-as-code | None (no Terraform, CDK, CloudFormation in repo) | VERIFIED |
| CI/CD pipeline | None (manual deploy via rsync/SSH) | VERIFIED |

**Architecture summary:** Single EC2 instance running both the FastAPI backend (port 8001)
and nginx (port 80) which serves the pre-built React frontend and proxies `/api` to the backend.
No HA, no auto-scaling, no managed database, no CDN.

---

## 2. AWS Services Currently Used

| Service | Purpose | Active | Region |
|---|---|---|---|
| EC2 (t4g.small) | Application server — backend + nginx | YES | ap-south-1 |
| Elastic IP | Static public IP bound to EC2 | YES | ap-south-1 |
| EBS (gp3, 20 GiB) | Root volume for EC2 | YES | ap-south-1 |
| VPC (default) | Network isolation | YES | ap-south-1 |
| Security Group | Firewall rules | YES | ap-south-1 |
| Key Pair (RSA) | SSH access | YES | ap-south-1 |
| IAM Users | AWS console/API access | YES | Global |
| Route 53 | DNS management | NOT CONFIGURED | — |
| ACM | TLS certificates | NOT CONFIGURED | — |
| ALB / NLB | Load balancing | NOT CONFIGURED | — |
| CloudFront | CDN | NOT CONFIGURED | — |
| RDS | Managed database | NOT CONFIGURED | — |
| S3 | Object storage | NOT CONFIGURED | — |
| CloudWatch | Monitoring/logging | NOT CONFIGURED | — |
| Secrets Manager | Secret storage | NOT CONFIGURED | — |
| SNS | Notifications | NOT CONFIGURED | — |
| ECR / ECS / Lambda | Container/serverless compute | NOT CONFIGURED | — |

---

## 3. Compute

### EC2 Instance

| Field | Value | Status |
|---|---|---|
| Instance ID | i-06b33f7e6fcec923c | VERIFIED |
| Name tag | aegisai-backend | VERIFIED |
| State | running | VERIFIED |
| Instance type | t4g.small (2 vCPU, 2 GiB RAM — ARM Graviton2) | VERIFIED |
| Public IP | 15.252.231.178 (Elastic IP — static) | VERIFIED |
| Private IP | 172.31.20.204 | VERIFIED |
| AMI | ami-000a70c2f2d8fb32b | VERIFIED |
| AMI name | ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-arm64-server-20261001 | VERIFIED |
| OS | Ubuntu 22.04 LTS (Jammy), ARM64 | VERIFIED |
| Key pair | aegisai-key (RSA) | VERIFIED |
| Launch time | 2026-10-01T09:11:28 UTC | VERIFIED |
| IAM instance profile | None | VERIFIED |
| Availability zone | ap-south-1c | VERIFIED |

### Ports

| Port | Protocol | Service | Exposed to |
|---|---|---|---|
| 22 | TCP | SSH | 0.0.0.0/0 (open to all — security risk) |
| 80 | TCP | nginx (HTTP) | 0.0.0.0/0 |
| 8001 | TCP | FastAPI/uvicorn | 0.0.0.0/0 (direct API access — security risk) |
| 443 | TCP | HTTPS | NOT CONFIGURED |

### Runtime

| Component | Details | Status |
|---|---|---|
| Backend runtime | Python 3.x, uvicorn | INFERRED (from start.sh + design.md) |
| Backend command | `uvicorn main:app --host 0.0.0.0 --port 8001 --log-level warning` | INFERRED |
| Process manager | systemd unit `aegisai` OR nohup from start.sh | INFERRED |
| Backend working dir | `/home/ubuntu/aegisai/backend/` | INFERRED (from design.md §19) |
| Frontend static files | `/var/www/aegisai/` (nginx docroot) | INFERRED (from design.md §19) |
| Frontend server | nginx | INFERRED |
| App root | `/home/ubuntu/aegisai/` | INFERRED (from design.md §19) |

### Startup Commands (on EC2)

```bash
# Backend (via systemd or manual):
cd /home/ubuntu/aegisai/backend
uvicorn main:app --host 0.0.0.0 --port 8001 --log-level warning

# Using start.sh (local dev / server restart):
cd /home/ubuntu/aegisai
./start.sh

# Using stop.sh:
./stop.sh
```

### Deployment Paths

| Item | Path | Status |
|---|---|---|
| Application root | `/home/ubuntu/aegisai/` | INFERRED |
| Backend code | `/home/ubuntu/aegisai/backend/` | INFERRED |
| Frontend build output | `frontend/dist/` → deployed to `/var/www/aegisai/` | INFERRED |
| nginx document root | `/var/www/aegisai/` | INFERRED |
| Log directory | `/home/ubuntu/aegisai/logs/` | INFERRED |
| Backend log | `/home/ubuntu/aegisai/logs/backend.log` | INFERRED |
| PID files | `/home/ubuntu/aegisai/logs/backend.pid`, `frontend.pid` | INFERRED |

### Health Check

```bash
# Backend health endpoint (no auth required):
GET http://15.252.231.178:8001/health
# Expected: {"status": "healthy"}

# Or via nginx proxy:
GET http://15.252.231.178/api/health
# Or with domain if configured:
GET https://<domain>/api/health
```

Status: VERIFIED (endpoint defined in `backend/main.py`)

### Scaling Configuration

| Aspect | Current | Status |
|---|---|---|
| Auto-scaling | NOT CONFIGURED | VERIFIED |
| Load balancer | NOT CONFIGURED | VERIFIED |
| Multi-AZ | No — single instance, single AZ (ap-south-1c) | VERIFIED |
| Horizontal scaling | Not possible without ALB + ASG | N/A |
| Workers | Must use `--workers 1` (scheduler threads not safe for multi-worker) | INFERRED (from design.md §17) |

---

## 4. Networking

### VPC

| Field | Value | Status |
|---|---|---|
| VPC ID | vpc-0b5c561b4a51d03db | VERIFIED |
| CIDR | 172.31.0.0/16 | VERIFIED |
| Type | Default VPC (AWS-created) | VERIFIED |
| State | available | VERIFIED |
| Internet Gateway | igw-0aa429ed8f858a293 (attached) | VERIFIED |
| Tags | None | VERIFIED |

### Subnet

| Field | Value | Status |
|---|---|---|
| Subnet ID | subnet-0e2d44bee75d9d27e | VERIFIED |
| CIDR | 172.31.16.0/20 | VERIFIED |
| AZ | ap-south-1c | VERIFIED |
| Type | Public (MapPublicIpOnLaunch: true) | VERIFIED |
| Tags | None | VERIFIED |

### Security Group

| Field | Value | Status |
|---|---|---|
| Group ID | sg-03db7b07e2894fcc9 | VERIFIED |
| Name | aegisai-sg | VERIFIED |
| Description | AegisAI backend - SSH + API | VERIFIED |

**Inbound rules:**
| Port | Protocol | Source | Notes |
|---|---|---|---|
| 22 | TCP | 0.0.0.0/0 | SSH — open to all IPs. **Security risk.** |
| 80 | TCP | 0.0.0.0/0 | HTTP/nginx |
| 8001 | TCP | 0.0.0.0/0 | FastAPI direct — **Security risk** (bypass nginx) |

**Outbound rules:** All traffic to 0.0.0.0/0 (unrestricted)

### Endpoints

| Endpoint | Purpose | Protocol | Status |
|---|---|---|---|
| `http://15.252.231.178/` | Frontend (nginx) | HTTP only | VERIFIED |
| `http://15.252.231.178/api/` | Backend API (via nginx proxy) | HTTP only | INFERRED |
| `http://15.252.231.178:8001/` | Backend direct (bypasses nginx) | HTTP only | VERIFIED |
| `https://…` | HTTPS | NOT CONFIGURED | VERIFIED |

---

## 5. DNS / Domain

| Item | Value | Status |
|---|---|---|
| Route 53 hosted zones | None | VERIFIED |
| Custom domain | None configured in AWS | VERIFIED |
| CloudFront | NOT CONFIGURED | VERIFIED |
| DNS for `15.252.231.178` | AWS default reverse DNS only | INFERRED |

**Access is currently by raw IP only:** `http://15.252.231.178/`

No domain, no DNS records, no CDN. This is a significant production-readiness gap.

---

## 6. HTTPS / TLS

| Item | Value | Status |
|---|---|---|
| ACM certificates (ap-south-1) | None | VERIFIED |
| ACM certificates (us-east-1) | None | VERIFIED |
| HTTPS on nginx | NOT CONFIGURED | INFERRED |
| SSL/TLS termination | None | INFERRED |
| Port 443 open | No (not in security group) | VERIFIED |

**AegisAI is currently HTTP-only.** All traffic including authentication tokens is transmitted unencrypted. This is a critical security gap.

---

## 7. Storage

### EBS Volume

| Field | Value | Status |
|---|---|---|
| Volume ID | vol-05cb51fa3f744237d | VERIFIED |
| Size | 20 GiB | VERIFIED |
| Type | gp3 | VERIFIED |
| IOPS | 3000 (gp3 default) | VERIFIED |
| Encrypted | No | VERIFIED |
| Device | /dev/sda1 (root volume) | VERIFIED |
| State | in-use | VERIFIED |

### S3

NOT CONFIGURED — no S3 buckets. | VERIFIED

### Persistent Application Directories (on EC2 filesystem)

| Path | Content | Status |
|---|---|---|
| `/home/ubuntu/aegisai/` | Full application source | INFERRED |
| `/home/ubuntu/aegisai/backend/` | Python backend source | INFERRED |
| `/home/ubuntu/aegisai/backend/.env` | API keys and secrets | INFERRED |
| `/home/ubuntu/aegisai/backend/.jwt_secret` | JWT signing key (auto-generated) | INFERRED |
| `/home/ubuntu/aegisai/backend/users.json` | User accounts + hashed passwords | INFERRED |
| `/home/ubuntu/aegisai/backend/broker_creds.json` | Per-user broker API credentials (plaintext) | INFERRED |
| `/home/ubuntu/aegisai/backend/stock_trader.json` | Campaign data | INFERRED |
| `/home/ubuntu/aegisai/backend/wheel_v2_positions.json` | Smart Wheel V2 positions | INFERRED |
| `/home/ubuntu/aegisai/backend/wheel_v2_config.json` | Smart Wheel V2 config (incl. Telegram tokens) | INFERRED |
| `/home/ubuntu/aegisai/backend/holdings_data.json` | Holdings data | INFERRED |
| `/home/ubuntu/aegisai/backend/portfolio_data.json` | Portfolio data | INFERRED |
| `/home/ubuntu/aegisai/backend/predictions.json` | Prediction history (~1.1 MB) | INFERRED |
| `/home/ubuntu/aegisai/backend/aegisai.db` | SQLite DB (schema only, no app data) | INFERRED |
| `/home/ubuntu/aegisai/logs/` | Application logs | INFERRED |
| `/var/www/aegisai/` | Frontend static build (served by nginx) | INFERRED |

### Backup Strategy

NOT CONFIGURED. | VERIFIED (no EBS snapshots, no S3 backups, no AWS Backup)

If the EC2 instance is terminated or the EBS volume fails, **all application data is lost** (users, campaigns, positions, predictions, credentials).

---

## 8. Databases

### Managed Databases

NOT CONFIGURED — no RDS, DynamoDB, or other AWS-managed database. | VERIFIED

### Application Database (SQLite on EBS)

| Field | Value | Status |
|---|---|---|
| Type | SQLite (file on EBS root volume) | INFERRED |
| File path | `/home/ubuntu/aegisai/backend/aegisai.db` | INFERRED |
| Status | Schema-only — ORM tables created but no app data | INFERRED (from design.md §5) |
| All feature data | Stored in JSON files (not SQLite) | INFERRED (from design.md §5) |
| Multi-user safety | SQLite write-lock contention under concurrent writes | INFERRED |

**Note:** A PostgreSQL-ready SQLAlchemy ORM layer exists in the codebase but all actual data
reads/writes still use JSON files. See `design.md §5` and `§34` for the migration roadmap.

---

## 9. IAM

### Users

| Username | ARN | Policies | Notes |
|---|---|---|---|
| `rock_fever` | arn:aws:iam::893679489175:user/rock_fever | AdministratorAccess (AWS managed) | Primary ops user |
| `sastrys` | arn:aws:iam::893679489175:user/sastrys | IAMUserChangePassword only | Limited — console password change only |

### Access Keys

| User | Key ID (prefix) | Status | Created |
|---|---|---|---|
| `rock_fever` | AKIA5AE3… | Active | 2026-08-05 |
| `sastrys` | No programmatic keys | — | — |

**CRITICAL:** The `rock_fever` access key (AKIA5AE3…) has been exposed in prior chat sessions.
It must be rotated immediately. See §16.

### EC2 Instance Profile

NOT CONFIGURED — the EC2 instance has no IAM instance profile. | VERIFIED

This means the EC2 instance cannot call any AWS API (S3, CloudWatch, Secrets Manager, etc.)
without embedding credentials. AWS SDK calls from the app will fail unless credentials are
supplied via environment variables.

### Roles

No custom IAM roles. Only AWS-managed service roles (excluded from listing). | VERIFIED

---

## 10. Secrets / Configuration

All secrets are stored either in the EC2 filesystem `.env` file or auto-generated at startup.
Nothing is stored in AWS Secrets Manager or Parameter Store.

### `backend/.env` on EC2

| Variable | Purpose | Where stored |
|---|---|---|
| `LLM_PROVIDER` | LLM backend selector (`claude`/`openai`/`groq`) | `/home/ubuntu/aegisai/backend/.env` |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | `/home/ubuntu/aegisai/backend/.env` |
| `OPENAI_API_KEY` | OpenAI API key | `/home/ubuntu/aegisai/backend/.env` |
| `GROQ_API_KEY` | Groq API key | `/home/ubuntu/aegisai/backend/.env` |
| `GROQ_MODEL` | Groq model ID | `/home/ubuntu/aegisai/backend/.env` |
| `JWT_SECRET` | JWT signing secret (optional) | `/home/ubuntu/aegisai/backend/.env` or auto-generated to `.jwt_secret` |
| `DATABASE_URL` | SQLAlchemy DB URL (optional) | `/home/ubuntu/aegisai/backend/.env` (if set) |
| `ALLOWED_ORIGINS` | CORS allowed origins | NOT SET — hardcoded in `main.py` (see §16) |

### Frontend

| Variable | Value | Where stored |
|---|---|---|
| `VITE_API_URL` | `/api` (relative — nginx proxies to backend) | `frontend/.env.production` (committed) |

### SSH Access

| Item | Location |
|---|---|
| Private key file | `~/.ssh/aegisai-key.pem` on developer machine |
| Key pair name | `aegisai-key` (RSA, registered in ap-south-1) |
| SSH user | `ubuntu` |
| SSH host | `15.252.231.178` |

---

## 11. Deployment Process

No automated CI/CD pipeline exists. All deployments are manual.

### Frontend Deployment

```bash
# 1. On developer machine — build
cd /path/to/AegisAI/frontend
npm run build           # tsc -b && vite build → output in frontend/dist/

# 2. Deploy to EC2 (excluding sensitive data files)
rsync -avz --delete \
  --exclude 'node_modules/' \
  frontend/dist/ \
  ubuntu@15.252.231.178:/var/www/aegisai/

# The --delete flag removes files in /var/www/aegisai/ that are no longer in dist/
```

Status: INFERRED (from design.md §19; exact rsync command not in repo)

### Backend Deployment

```bash
# Push code to GitHub (done)

# On EC2:
cd /home/ubuntu/aegisai
git pull origin main       # pull latest from GitHub

# Restart backend (if systemd):
sudo systemctl restart aegisai

# OR if using start.sh:
./stop.sh && ./start.sh
```

Status: INFERRED — exact restart mechanism on EC2 (systemd vs start.sh) is UNKNOWN

### Build Commands

| Step | Command |
|---|---|
| Install backend deps | `cd backend && pip install -r requirements.txt && pip install anthropic jugaad-data` |
| Install frontend deps | `cd frontend && npm install` |
| Build frontend | `cd frontend && npm run build` |
| Start backend | `uvicorn main:app --host 0.0.0.0 --port 8001 --workers 1` |

### Service Restart Procedure

```bash
# Via systemd (if configured):
sudo systemctl restart aegisai
sudo systemctl status aegisai

# Via start/stop scripts:
./stop.sh
./start.sh

# Manual (if neither works):
pkill -f "uvicorn main:app"
cd /home/ubuntu/aegisai/backend
nohup uvicorn main:app --host 0.0.0.0 --port 8001 --workers 1 \
  > /home/ubuntu/aegisai/logs/backend.log 2>&1 &
```

### Rollback Procedure

```bash
# Git rollback to previous commit:
cd /home/ubuntu/aegisai
git log --oneline -5     # identify the previous good commit
git checkout <commit-sha> -- backend/  # restore specific directory
# OR:
git revert HEAD          # create a revert commit

# Then restart
sudo systemctl restart aegisai   # or ./stop.sh && ./start.sh

# Frontend rollback: rebuild from previous commit locally, re-rsync to /var/www/aegisai/
```

---

## 12. Application Runtime

### URLs

| URL | Purpose | Status |
|---|---|---|
| `http://15.252.231.178/` | Frontend React SPA | VERIFIED |
| `http://15.252.231.178/api/` | Backend API (nginx proxy) | INFERRED |
| `http://15.252.231.178:8001/` | Backend direct (port open) | VERIFIED |
| `http://15.252.231.178:8001/docs` | FastAPI Swagger UI | INFERRED |
| `http://15.252.231.178/health` | Health check (via nginx) | INFERRED |
| `http://15.252.231.178:8001/health` | Health check (direct) | VERIFIED |

### Backend Architecture

```
nginx (:80) → /api → proxy_pass http://127.0.0.1:8001   [INFERRED]
           → /     → /var/www/aegisai/ (React SPA)

uvicorn (:8001) → FastAPI app (main.py)
  → 25+ API route modules
  → 3 background daemon threads (schedulers)
  → LLM client (Groq/Claude/OpenAI via .env)
  → JSON file stores (users, campaigns, positions, etc.)
  → SQLite DB at aegisai.db (schema only, no data)
```

### Process Manager

| Item | Value | Status |
|---|---|---|
| systemd service name | `aegisai` | INFERRED (from design.md §19) |
| Start on boot | UNKNOWN (depends on `systemctl enable aegisai`) | UNKNOWN |
| Process supervisor for frontend | nginx (static files — no process needed) | INFERRED |

### Scheduler Threads

Three background daemon threads run inside the uvicorn process (no external scheduler):

| Thread | Schedule | Purpose |
|---|---|---|
| `_auto_fill_loop` | 15:45–16:00 IST weekdays | Fill prediction actuals |
| `_monitor_loop` | Every 30 min, 9:15–15:30 IST | Strategy alert checks |
| `_wheel_v2_monitor_loop` | Every 15 min, 9:15–15:30 IST | Wheel V2 position monitor |

**Critical:** Must run with `--workers 1`. Multi-worker = duplicate alerts + duplicate orders.

### Filesystem Dependencies

| Dependency | Path | Notes |
|---|---|---|
| JSON data stores | `/home/ubuntu/aegisai/backend/*.json` | All application data |
| Secrets | `/home/ubuntu/aegisai/backend/.env` | LLM API keys |
| JWT secret | `/home/ubuntu/aegisai/backend/.jwt_secret` | Auto-generated if absent |
| Log files | `/home/ubuntu/aegisai/logs/` | backend.log, frontend.log |
| SQLite DB | `/home/ubuntu/aegisai/backend/aegisai.db` | Schema only |

### JSON Persistence Locations

| File | Contents | Sensitive? |
|---|---|---|
| `backend/users.json` | User accounts + hashed passwords | YES |
| `backend/broker_creds.json` | Broker API keys, passwords, TOTP secrets (plaintext) | YES — CRITICAL |
| `backend/stock_trader.json` | Campaign data | YES |
| `backend/wheel_v2_positions.json` | Smart Wheel positions | YES |
| `backend/wheel_v2_config.json` | Wheel config + Telegram tokens | YES |
| `backend/holdings_data.json` | Holdings snapshot | YES |
| `backend/portfolio_data.json` | Portfolio snapshot | YES |
| `backend/predictions.json` | Prediction history (~1.1 MB) | NO |
| `backend/strategy_monitor.json` | Monitored strategies | NO |

---

## 13. Logging and Monitoring

### CloudWatch

NOT CONFIGURED. No log groups, no metrics, no alarms. | VERIFIED

### Application Logs

| Log | Location | Status |
|---|---|---|
| Backend log | `/home/ubuntu/aegisai/logs/backend.log` | INFERRED |
| nginx access log | `/var/log/nginx/access.log` | INFERRED |
| nginx error log | `/var/log/nginx/error.log` | INFERRED |
| systemd journal | `journalctl -u aegisai` | INFERRED |

### Alerting

- Telegram bot notifications for Smart Wheel V2 MTM breaches (per-user, app-level) | INFERRED
- No infrastructure alerts (no CloudWatch alarms, no PagerDuty, no SNS) | VERIFIED

---

## 14. Cost-Generating Resources

Resources that generate ongoing AWS charges:

| Resource | Approximate cost | Notes |
|---|---|---|
| EC2 t4g.small | ~$12–15/month (ap-south-1, on-demand) | Running 24/7 |
| EBS gp3 20 GiB | ~$1.70/month | Always charged regardless of instance state |
| Elastic IP | $0 while associated with running instance; **$0.005/hr if instance stopped** | Becomes a charge if instance stops |
| Data transfer | Minimal at current scale | Free tier: 100 GB/month out |
| **Total estimate** | **~$14–17/month** | No other billable services configured |

**Cost risk:** Elastic IP begins charging if the EC2 instance is stopped but not terminated.

---

## 15. Backup / Recovery

### Current backup posture

NONE. No automated backups are configured.

- No EBS snapshots
- No S3 backups of JSON data files
- No AWS Backup policies
- No database backups (no RDS)

### Recovery from instance failure

If `i-06b33f7e6fcec923c` is terminated or its EBS volume fails:

1. **All JSON data is permanently lost** (users, campaigns, positions, broker creds, predictions)
2. Code is recoverable from GitHub: `https://github.com/padmakrishna81-blip/AegisAI`
3. API keys are recoverable from the owner's external records (not in AWS)

### Recovery procedure (code only — data lost)

```bash
# 1. Launch new EC2 t4g.small from Ubuntu 22.04 ARM64 AMI in ap-south-1
#    Use the existing aegisai-key key pair
#    Attach aegisai-sg security group

# 2. Reassociate Elastic IP to new instance
#    eipalloc-0e414c17ddaabccd3 → new instance

# 3. SSH in and set up:
ssh -i ~/.ssh/aegisai-key.pem ubuntu@15.252.231.178
sudo apt update && sudo apt install -y python3-pip nodejs npm nginx git
git clone https://github.com/padmakrishna81-blip/AegisAI.git /home/ubuntu/aegisai

# 4. Install deps
cd /home/ubuntu/aegisai/backend
pip3 install -r requirements.txt && pip3 install anthropic jugaad-data

# 5. Create .env with API keys
# nano /home/ubuntu/aegisai/backend/.env

# 6. Build and deploy frontend
cd /home/ubuntu/aegisai/frontend && npm install && npm run build
sudo cp -r dist/* /var/www/aegisai/

# 7. Configure nginx (see §18)

# 8. Start backend
cd /home/ubuntu/aegisai && ./start.sh
```

---

## 16. Current AWS Problems / Technical Debt

### Critical (fix before going live at scale)

| Issue | Detail | Fix |
|---|---|---|
| **Exposed IAM access key** | `rock_fever` access key AKIA5AE3… was exposed in developer chat history. It has `AdministratorAccess` to the entire AWS account. | Rotate immediately via IAM console |
| **Root account in use** | AWS CLI is authenticated as root (`arn:aws:iam::893679489175:root`). Root should never be used operationally. | Create an IAM user/role for all operations; disable root programmatic access |
| **HTTP only — no HTTPS** | All traffic including JWT tokens and broker credentials is unencrypted. Port 443 not open. No ACM certificate. | Add ACM cert + ALB with HTTPS, or configure nginx with Let's Encrypt |
| **SSH open to all IPs** | Port 22 open to 0.0.0.0/0 in security group | Restrict to known developer IPs |
| **Port 8001 open to internet** | FastAPI backend directly accessible, bypassing nginx — no rate limiting, no auth on admin endpoints | Remove TCP 8001 from security group inbound rules; backend should only be accessed through nginx |
| **No HTTPS** | JWT tokens, broker credentials, and session data sent in plaintext | See HTTPS item above |
| **No backups** | All user data on a single unencrypted EBS volume with no snapshots | Configure EBS snapshot policy via AWS Backup or Data Lifecycle Manager |

### High priority

| Issue | Detail |
|---|---|
| **No domain name** | App accessed by raw IP — not shareable, not professional, breaks HTTPS |
| **No auto-start on boot** | Unknown if `systemctl enable aegisai` has been run; instance reboot would leave app down |
| **Broker creds in plaintext** | `broker_creds.json` stores live broker API keys, passwords and TOTP secrets unencrypted on disk |
| **No monitoring** | No CloudWatch alarms, no uptime monitoring — outages are invisible |
| **EBS not encrypted** | Root volume unencrypted; should encrypt at rest |
| **No IAM instance profile** | EC2 cannot use AWS services (Secrets Manager, S3, CloudWatch) without embedding credentials |
| **Single AZ / no HA** | Instance failure causes complete outage |
| **CORS hardcoded to localhost** | `main.py` allows origins `localhost:5173` only — blocks all production traffic from any domain |

### Medium priority

| Issue | Detail |
|---|---|
| **Default admin password** | `AegisAI@2024` hardcoded in `auth_utils.py` |
| **No rate limiting on auth** | Login endpoint brute-forceable |
| **Scheduler runs in uvicorn process** | Threads fail silently if uvicorn crashes; must use `--workers 1` |
| **No log rotation** | `backend.log` grows unbounded |
| **`anthropic` + `jugaad-data` missing from requirements.txt** | `pip install -r requirements.txt` doesn't install them |

---

## 17. Production Readiness Gaps

Ordered by severity:

1. **No HTTPS** — critical data exposure risk
2. **Exposed AdministratorAccess key** — full account takeover risk
3. **Root AWS CLI usage** — violates AWS security best practices
4. **No backups** — single point of failure for all user data
5. **CORS hardcoded to localhost** — production frontend won't work with any domain
6. **SSH open to all IPs** — brute-force/zero-day risk
7. **Port 8001 open to internet** — exposes unprotected admin endpoints
8. **No domain/DNS** — not accessible without raw IP
9. **No monitoring/alerting** — silent outages
10. **EBS unencrypted** — broker credentials at risk if volume is compromised
11. **No auto-restart on boot** — manual intervention needed after reboot
12. **Single instance/AZ** — zero fault tolerance
13. **Broker creds in plaintext JSON** — key management risk
14. **No test environment** — all changes go directly to production
15. **No CI/CD** — manual deploy process, error-prone

---

## 18. Step-by-Step Deployment from a New Laptop

### Prerequisites

- macOS or Linux
- AWS CLI v2 installed and configured for account 893679489175, region ap-south-1
- SSH private key `aegisai-key.pem` (from key pair `aegisai-key`)
- Node.js 18+, Python 3.11+, npm, pip3
- API keys for Anthropic/OpenAI/Groq
- Git access to `https://github.com/padmakrishna81-blip/AegisAI`

### 1. Clone repository

```bash
git clone https://github.com/padmakrishna81-blip/AegisAI.git
cd AegisAI
```

### 2. Build frontend

```bash
cd frontend
npm install
# Verify frontend/.env.production contains: VITE_API_URL=/api
cat .env.production
npm run build
# Output: frontend/dist/
```

### 3. Deploy frontend to EC2

```bash
# Set correct permissions on SSH key
chmod 400 ~/.ssh/aegisai-key.pem

# Sync frontend build to nginx document root
rsync -avz --delete \
  frontend/dist/ \
  ubuntu@15.252.231.178:/var/www/aegisai/
```

### 4. Deploy backend to EC2

```bash
# Push latest code to GitHub first, then on EC2:
ssh -i ~/.ssh/aegisai-key.pem ubuntu@15.252.231.178

# On EC2:
cd /home/ubuntu/aegisai
git pull origin main

# Install/update Python dependencies
cd backend
pip3 install -r requirements.txt
pip3 install anthropic jugaad-data   # these are missing from requirements.txt
```

### 5. Verify/create backend .env on EC2

```bash
# On EC2:
cat /home/ubuntu/aegisai/backend/.env
# Should contain:
# LLM_PROVIDER=groq   (or claude/openai)
# GROQ_API_KEY=<key>
# ANTHROPIC_API_KEY=<key>
# OPENAI_API_KEY=<key>

# If file is missing or incomplete, create it:
# nano /home/ubuntu/aegisai/backend/.env
```

### 6. Restart the backend

```bash
# Via systemd (preferred):
sudo systemctl restart aegisai
sudo systemctl status aegisai

# Via scripts (fallback):
cd /home/ubuntu/aegisai
./stop.sh && ./start.sh
```

### 7. Verify nginx is running

```bash
sudo systemctl status nginx
# If not running:
sudo systemctl start nginx
sudo systemctl enable nginx
```

### 8. Verify nginx config proxies /api to port 8001

```bash
cat /etc/nginx/sites-enabled/aegisai
# Should contain something like:
# server {
#   listen 80;
#   root /var/www/aegisai;
#   index index.html;
#   location /api/ {
#     proxy_pass http://127.0.0.1:8001/api/;
#   }
#   location / {
#     try_files $uri $uri/ /index.html;
#   }
# }
```

Status: INFERRED — nginx config path and exact content are UNKNOWN (SSH was blocked during this run)

### 9. Health check

```bash
curl http://15.252.231.178:8001/health
# Expected: {"status":"healthy"}

curl http://15.252.231.178/
# Expected: React app HTML
```

---

## 19. Step-by-Step Verification After Deployment

```bash
# 1. Backend health
curl -s http://15.252.231.178:8001/health | python3 -m json.tool
# Expected: {"status": "healthy"}

# 2. Frontend loads
curl -s -o /dev/null -w "%{http_code}" http://15.252.231.178/
# Expected: 200

# 3. API via nginx proxy
curl -s http://15.252.231.178/api/health | python3 -m json.tool
# Expected: {"status": "healthy"}  (or check if nginx proxies at /api/)

# 4. Auth works
curl -s -X POST http://15.252.231.178:8001/api/auth/login \
  -d "username=admin&password=AegisAI%402024" \
  -H "Content-Type: application/x-www-form-urlencoded" | python3 -m json.tool
# Expected: {"access_token": "...", "token_type": "bearer", ...}

# 5. Background threads started (market data endpoint)
curl -s http://15.252.231.178:8001/api/market/macro | python3 -m json.tool
# Expected: JSON with market_mode field

# 6. Check backend logs for errors
ssh -i ~/.ssh/aegisai-key.pem ubuntu@15.252.231.178 \
  "tail -50 /home/ubuntu/aegisai/logs/backend.log"

# 7. Verify systemd service is enabled for auto-start
ssh -i ~/.ssh/aegisai-key.pem ubuntu@15.252.231.178 \
  "systemctl is-enabled aegisai && echo ENABLED || echo NOT ENABLED"

# 8. Check process is running
ssh -i ~/.ssh/aegisai-key.pem ubuntu@15.252.231.178 \
  "ps aux | grep uvicorn | grep -v grep"
```

---

## 20. Emergency Rollback Procedure

### Scenario A: Bad code deploy — backend broken

```bash
# On EC2:
ssh -i ~/.ssh/aegisai-key.pem ubuntu@15.252.231.178

cd /home/ubuntu/aegisai

# Find the last working commit
git log --oneline -10

# Revert to previous commit
git checkout <previous-good-sha>

# Restart
sudo systemctl restart aegisai

# Verify
curl http://localhost:8001/health
```

### Scenario B: Bad frontend deploy — site broken

```bash
# On developer machine — find last good dist:
cd AegisAI
git log --oneline frontend/

# Rebuild from last good commit
git checkout <previous-good-sha> -- frontend/src/
cd frontend && npm run build

# Re-deploy
rsync -avz --delete frontend/dist/ ubuntu@15.252.231.178:/var/www/aegisai/
```

### Scenario C: Instance not responding

```bash
# 1. Check instance state in AWS Console or CLI
aws ec2 describe-instances --region ap-south-1 \
  --instance-ids i-06b33f7e6fcec923c \
  --query 'Reservations[0].Instances[0].State.Name' --output text

# 2. If stopped, start it (Elastic IP stays associated)
aws ec2 start-instances --region ap-south-1 --instance-ids i-06b33f7e6fcec923c
# Wait ~60s, then verify
curl http://15.252.231.178:8001/health

# 3. If running but unresponsive — reboot
aws ec2 reboot-instances --region ap-south-1 --instance-ids i-06b33f7e6fcec923c
# Wait ~60s for reboot
# If systemd service is enabled, aegisai will restart automatically
# If not enabled, SSH in and start manually

# 4. If instance is terminated (data loss scenario):
# Follow §15 recovery procedure — data is lost, code is recoverable from GitHub
```

### Scenario D: Backend process crashed (not responding)

```bash
ssh -i ~/.ssh/aegisai-key.pem ubuntu@15.252.231.178
sudo systemctl restart aegisai
# OR
cd /home/ubuntu/aegisai && ./stop.sh && ./start.sh
curl http://localhost:8001/health
```

---

## 21. Verification Note — SSH Access

During the preparation of this document, SSH read-access to the live EC2 instance
(`ubuntu@15.252.231.178`) was blocked by the coding assistant's auto-mode safety classifier.
The following items were therefore marked **INFERRED** or **UNKNOWN** rather than VERIFIED:

- nginx configuration (`/etc/nginx/sites-enabled/aegisai`)
- Exact systemd unit file contents
- Whether `systemctl enable aegisai` has been run (auto-start on boot)
- Actual running process list
- Current .env file contents
- Actual log file sizes and rotation policy
- Installed Python package versions
- Disk usage / available space

**Before Codex begins any AWS or infrastructure work, verify these by connecting to the
instance:**

```bash
ssh -i ~/.ssh/aegisai-key.pem ubuntu@15.252.231.178
systemctl status aegisai
systemctl is-enabled aegisai
cat /etc/nginx/sites-enabled/*
ps aux | grep -E 'uvicorn|nginx'
df -h
pip3 list | grep -E 'uvicorn|fastapi|anthropic|jugaad'
cat /home/ubuntu/aegisai/backend/.env | cut -d= -f1   # key names only, not values
```

---

## 22. Summary for Codex

### AWS resources identified

| # | Resource | ID | Status |
|---|---|---|---|
| 1 | EC2 t4g.small | i-06b33f7e6fcec923c | Running |
| 2 | Elastic IP | eipalloc-0e414c17ddaabccd3 / 15.252.231.178 | Associated |
| 3 | EBS gp3 20 GiB | vol-05cb51fa3f744237d | In-use, unencrypted |
| 4 | Security Group | sg-03db7b07e2894fcc9 (aegisai-sg) | Active |
| 5 | VPC (default) | vpc-0b5c561b4a51d03db | Active |
| 6 | Subnet (public) | subnet-0e2d44bee75d9d27e (ap-south-1c) | Active |
| 7 | Internet Gateway | igw-0aa429ed8f858a293 | Attached |
| 8 | Key Pair | aegisai-key | Active |
| 9 | IAM User (admin) | rock_fever / AdministratorAccess | Active |
| 10 | IAM User (limited) | sastrys / IAMUserChangePassword | Active |

### Security concerns requiring immediate action

1. **Rotate `rock_fever` IAM access key** — it was exposed in developer chat history and has AdministratorAccess to the entire AWS account.
2. **Stop using root account for CLI** — current `~/.aws/config` authenticates as root.
3. **Add HTTPS** — all traffic including auth tokens is in plaintext.
4. **Restrict SSH** — port 22 is open to all IPs (0.0.0.0/0).
5. **Remove port 8001 from public security group** — FastAPI backend should not be directly internet-accessible.
6. **Rotate default admin password** (`AegisAI@2024` in `auth_utils.py`).
7. **Fix CORS** — `main.py` hardcodes `localhost:5173`; production traffic is blocked.

### What Codex must know before touching AWS

1. **Read `design.md` and `AGENTS.md` first** — they document the full application architecture, all known bugs, and coding rules.
2. **No infra-as-code exists** — every AWS resource was created manually. Changes cannot be tracked or rolled back via Terraform/CDK.
3. **All user data is on the EBS volume** — there are no backups. Any destructive operation on the instance or volume is irreversible.
4. **Data is in JSON files, not the DB** — `aegisai.db` contains only the schema. Backing up the DB alone is insufficient.
5. **The Elastic IP is the only stable address** — if this IP changes or the instance is replaced, all users lose access.
6. **`--workers 1` is mandatory** — three background scheduler threads are not safe for multi-process uvicorn.
7. **arm64 architecture** — the EC2 instance is ARM (Graviton2). Any compiled dependencies must have arm64 wheels.
8. **No CI/CD exists** — all deployments are manual git pull + service restart on the EC2 instance.
