"""
Authentication system — JWT-based with multi-role user management.

Roles:
  admin        — full access, can manage all users
  live_trader  — real broker connection + automated live orders + all paper features
  paper_trader — AI-guided paper trading only (no real money, no live orders)
  viewer       — read-only access (holdings, market data, no trading)

Default admin: username=admin, password=AegisAI@2024
"""

import json, os, secrets, re
from datetime import datetime, timedelta
from typing import Optional
from passlib.context import CryptContext
from jose import JWTError, jwt
from fastapi import HTTPException, status

# ── Config ────────────────────────────────────────────────────────────────────
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 480   # 8 hours
REFRESH_TOKEN_EXPIRE_DAYS   = 30

VALID_ROLES = {"admin", "live_trader", "paper_trader", "viewer"}

# Role hierarchy: higher index = more access
ROLE_LEVEL = {"viewer": 0, "paper_trader": 1, "live_trader": 2, "admin": 99}

# Default permissions granted per role (used for legacy hasPermission() checks)
ROLE_PERMISSIONS: dict[str, list[str]] = {
    "viewer":       ["market"],
    "paper_trader": ["market", "ai_insights", "covered_calls", "wheel", "paper_trade"],
    "live_trader":  ["market", "ai_insights", "covered_calls", "wheel", "paper_trade", "broker_connect", "live_trade"],
    "admin":        ["market", "ai_insights", "covered_calls", "wheel", "paper_trade", "broker_connect", "live_trade"],
}

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

USERS_FILE  = os.path.join(os.path.dirname(__file__), "..", "users.json")
_SECRET_FILE = os.path.join(os.path.dirname(__file__), "..", ".jwt_secret")


def _load_or_create_secret() -> str:
    env_secret = os.getenv("JWT_SECRET")
    if env_secret:
        return env_secret
    if os.path.exists(_SECRET_FILE):
        with open(_SECRET_FILE) as f:
            return f.read().strip()
    secret = secrets.token_hex(32)
    with open(_SECRET_FILE, "w") as f:
        f.write(secret)
    return secret


SECRET_KEY = _load_or_create_secret()

# ── Default admin ─────────────────────────────────────────────────────────────
DEFAULT_ADMIN = {
    "username":         "admin",
    "email":            "admin@aegisai.in",
    "full_name":        "Administrator",
    "hashed_password":  pwd_context.hash("AegisAI@2024"),
    "role":             "admin",
    "created_at":       datetime.now().isoformat(),
    "active":           True,
}


def _load_users() -> dict[str, dict]:
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE) as f:
                data = json.load(f)
                # Migrate old 'user' role → 'paper_trader'
                for u in data.values():
                    if u.get("role") == "user":
                        u["role"] = "paper_trader"
                    if "email" not in u:
                        u["email"] = f"{u['username']}@aegisai.in"
                return data
        except Exception:
            pass
    users = {"admin": DEFAULT_ADMIN}
    _save_users(users)
    return users


def _save_users(users: dict[str, dict]) -> None:
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)


# ── Password helpers ──────────────────────────────────────────────────────────

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def _validate_password(password: str) -> None:
    if len(password) < 8:
        raise ValueError("Password must be at least 8 characters")
    if not re.search(r"[A-Z]", password):
        raise ValueError("Password must contain at least one uppercase letter")
    if not re.search(r"[0-9]", password):
        raise ValueError("Password must contain at least one number")


# ── JWT helpers ───────────────────────────────────────────────────────────────

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode["exp"] = expire
    to_encode["type"] = "access"
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(username: str) -> str:
    to_encode = {
        "sub":  username,
        "type": "refresh",
        "exp":  datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
    }
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None


# ── User CRUD ─────────────────────────────────────────────────────────────────

def authenticate_user(username: str, password: str) -> Optional[dict]:
    users = _load_users()
    # Allow login by email too
    if "@" in username:
        user = next((u for u in users.values() if u.get("email") == username), None)
    else:
        user = users.get(username)
    if not user or not user.get("active", True):
        return None
    if not verify_password(password, user["hashed_password"]):
        return None
    return _safe_user(user)


def _safe_user(user: dict) -> dict:
    u = {k: v for k, v in user.items() if k != "hashed_password"}
    # Ensure permissions are always role-derived (single source of truth)
    u["permissions"] = ROLE_PERMISSIONS.get(u.get("role", "viewer"), [])
    return u


def get_user(username: str) -> Optional[dict]:
    users = _load_users()
    user = users.get(username)
    if not user:
        return None
    return _safe_user(user)


def get_user_by_email(email: str) -> Optional[dict]:
    users = _load_users()
    user = next((u for u in users.values() if u.get("email", "").lower() == email.lower()), None)
    return _safe_user(user) if user else None


def list_users() -> list[dict]:
    return [_safe_user(u) for u in _load_users().values()]


def register_user(username: str, email: str, full_name: str, password: str,
                  role: str = "paper_trader") -> dict:
    """Self-registration. New accounts default to paper_trader."""
    if role not in VALID_ROLES - {"admin"}:
        role = "paper_trader"
    users = _load_users()
    if username in users:
        raise ValueError(f"Username '{username}' is already taken")
    if any(u.get("email", "").lower() == email.lower() for u in users.values()):
        raise ValueError(f"An account with email '{email}' already exists")
    if not re.match(r"^[a-zA-Z0-9_.-]{3,30}$", username):
        raise ValueError("Username must be 3-30 characters (letters, numbers, _.-)")
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise ValueError("Invalid email address")
    _validate_password(password)

    users[username] = {
        "username":        username,
        "email":           email,
        "full_name":       full_name,
        "hashed_password": hash_password(password),
        "role":            role,
        "created_at":      datetime.now().isoformat(),
        "active":          True,
    }
    _save_users(users)
    return _safe_user(users[username])


def create_user(username: str, full_name: str, password: str, role: str = "paper_trader",
                email: str = "", permissions: Optional[list] = None) -> dict:
    """Admin-created user."""
    if role not in VALID_ROLES:
        raise ValueError(f"Invalid role '{role}'. Valid: {VALID_ROLES}")
    users = _load_users()
    if username in users:
        raise ValueError(f"User '{username}' already exists")
    if len(password) < 6:
        raise ValueError("Password must be at least 6 characters")
    users[username] = {
        "username":        username,
        "email":           email or f"{username}@aegisai.in",
        "full_name":       full_name,
        "hashed_password": hash_password(password),
        "role":            role,
        "created_at":      datetime.now().isoformat(),
        "active":          True,
    }
    _save_users(users)
    return _safe_user(users[username])


def update_user(username: str, full_name: Optional[str] = None, email: Optional[str] = None,
                password: Optional[str] = None, active: Optional[bool] = None,
                role: Optional[str] = None, permissions: Optional[list] = None) -> dict:
    users = _load_users()
    if username not in users:
        raise ValueError(f"User '{username}' not found")
    if full_name is not None:
        users[username]["full_name"] = full_name
    if email is not None:
        users[username]["email"] = email
    if password is not None:
        if len(password) < 6:
            raise ValueError("Password must be at least 6 characters")
        users[username]["hashed_password"] = hash_password(password)
    if active is not None:
        users[username]["active"] = active
    if role is not None:
        if role not in VALID_ROLES:
            raise ValueError(f"Invalid role '{role}'")
        users[username]["role"] = role
    _save_users(users)
    return _safe_user(users[username])


def delete_user(username: str) -> None:
    if username == "admin":
        raise ValueError("Cannot delete the admin user")
    users = _load_users()
    if username not in users:
        raise ValueError(f"User '{username}' not found")
    del users[username]
    _save_users(users)


# ── Role enforcement ──────────────────────────────────────────────────────────

def has_role(user: dict, *roles: str) -> bool:
    """Return True if user has any of the given roles (or is admin)."""
    return user.get("role") in set(roles) | {"admin"}


def has_min_role(user: dict, min_role: str) -> bool:
    """Return True if user's role level is >= min_role level."""
    user_level = ROLE_LEVEL.get(user.get("role", "viewer"), 0)
    min_level  = ROLE_LEVEL.get(min_role, 99)
    return user_level >= min_level


def require_role(*roles: str):
    """FastAPI dependency factory. Usage: Depends(require_role('live_trader'))"""
    from fastapi import Depends
    from api.routes.auth import get_current_user

    def _dep(current_user: dict = Depends(get_current_user)) -> dict:
        if not has_role(current_user, *roles):
            role_list = " or ".join(roles)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"This feature requires {role_list} role. "
                       f"Your current role is {current_user.get('role')}."
            )
        return current_user
    return _dep
