"""
Authentication system — JWT-based with user management.

Default admin: username=admin, password=AegisAI@2024
Admin can add/remove users and reset passwords.
"""

import json, os, secrets
from datetime import datetime, timedelta
from typing import Optional
from passlib.context import CryptContext
from jose import JWTError, jwt

# ── Config ────────────────────────────────────────────────────────────────────
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 480  # 8 hours

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

USERS_FILE = os.path.join(os.path.dirname(__file__), "..", "users.json")
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
    "username": "admin",
    "full_name": "Administrator",
    "hashed_password": pwd_context.hash("AegisAI@2024"),
    "role": "admin",
    "created_at": datetime.now().isoformat(),
    "active": True,
}


def _load_users() -> dict[str, dict]:
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    # Bootstrap with default admin
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


# ── JWT helpers ───────────────────────────────────────────────────────────────

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode["exp"] = expire
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None


# ── User CRUD ─────────────────────────────────────────────────────────────────

def authenticate_user(username: str, password: str) -> Optional[dict]:
    users = _load_users()
    user = users.get(username)
    if not user or not user.get("active", True):
        return None
    if not verify_password(password, user["hashed_password"]):
        return None
    return {k: v for k, v in user.items() if k != "hashed_password"}


def get_user(username: str) -> Optional[dict]:
    users = _load_users()
    user = users.get(username)
    if not user:
        return None
    return {k: v for k, v in user.items() if k != "hashed_password"}


def list_users() -> list[dict]:
    users = _load_users()
    return [{k: v for k, v in u.items() if k != "hashed_password"}
            for u in users.values()]


ALL_PERMISSIONS = ["covered_calls", "market", "ai_insights"]


def create_user(username: str, full_name: str, password: str, role: str = "user",
                permissions: Optional[list] = None) -> dict:
    users = _load_users()
    if username in users:
        raise ValueError(f"User '{username}' already exists")
    if len(password) < 6:
        raise ValueError("Password must be at least 6 characters")
    users[username] = {
        "username": username,
        "full_name": full_name,
        "hashed_password": hash_password(password),
        "role": role,
        "permissions": permissions if permissions is not None else [],
        "created_at": datetime.now().isoformat(),
        "active": True,
    }
    _save_users(users)
    return get_user(username)


def update_user(username: str, full_name: Optional[str] = None,
                password: Optional[str] = None, active: Optional[bool] = None,
                role: Optional[str] = None, permissions: Optional[list] = None) -> dict:
    users = _load_users()
    if username not in users:
        raise ValueError(f"User '{username}' not found")
    if full_name is not None:
        users[username]["full_name"] = full_name
    if password is not None:
        if len(password) < 6:
            raise ValueError("Password must be at least 6 characters")
        users[username]["hashed_password"] = hash_password(password)
    if active is not None:
        users[username]["active"] = active
    if role is not None:
        users[username]["role"] = role
    if permissions is not None:
        users[username]["permissions"] = permissions
    _save_users(users)
    return get_user(username)


def delete_user(username: str) -> None:
    if username == "admin":
        raise ValueError("Cannot delete the admin user")
    users = _load_users()
    if username not in users:
        raise ValueError(f"User '{username}' not found")
    del users[username]
    _save_users(users)
