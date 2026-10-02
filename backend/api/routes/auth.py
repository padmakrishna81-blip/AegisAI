"""Auth API routes — login, register, token refresh, user management."""

from fastapi import APIRouter, HTTPException, Depends, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List
from auth.auth_utils import (
    authenticate_user, create_access_token, create_refresh_token, decode_token,
    get_user, list_users, create_user, update_user, delete_user, register_user,
    ROLE_PERMISSIONS,
)

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


# ── Request models ─────────────────────────────────────────────────────────────

class RegisterInput(BaseModel):
    username:   str
    email:      str
    full_name:  str
    password:   str
    role:       str = "paper_trader"   # paper_trader | live_trader (admin-approved upgrade)


class CreateUserInput(BaseModel):
    username:   str
    full_name:  str
    email:      str = ""
    password:   str
    role:       str = "paper_trader"
    permissions: List[str] = []


class UpdateUserInput(BaseModel):
    full_name:  Optional[str] = None
    email:      Optional[str] = None
    password:   Optional[str] = None
    active:     Optional[bool] = None
    role:       Optional[str] = None
    permissions: Optional[List[str]] = None


class ChangePasswordInput(BaseModel):
    current_password: str
    new_password:     str


class RefreshInput(BaseModel):
    refresh_token: str


# ── Dependency: get current user from Bearer token ────────────────────────────

def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    payload = decode_token(token)
    if not payload or payload.get("type") == "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Invalid or expired token",
                            headers={"WWW-Authenticate": "Bearer"})
    username = payload.get("sub")
    user = get_user(username) if username else None
    if not user or not user.get("active", True):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User inactive or not found")
    return user


def require_admin(current_user: dict = Depends(get_current_user)) -> dict:
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user


def _build_login_response(user: dict) -> dict:
    token = create_access_token({"sub": user["username"], "role": user["role"]})
    refresh = create_refresh_token(user["username"])
    return {
        "access_token":  token,
        "refresh_token": refresh,
        "token_type":    "bearer",
        "username":      user["username"],
        "email":         user.get("email", ""),
        "full_name":     user["full_name"],
        "role":          user["role"],
        "permissions":   ROLE_PERMISSIONS.get(user["role"], []),
    }


# ── Public endpoints ───────────────────────────────────────────────────────────

@router.post("/auth/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    """Login with username/email + password → JWT access + refresh token."""
    user = authenticate_user(form_data.username, form_data.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Incorrect username or password")
    return _build_login_response(user)


@router.post("/auth/register")
async def register(body: RegisterInput):
    """Self-registration. Creates paper_trader account (live_trader requires admin upgrade)."""
    try:
        user = register_user(
            username=body.username.strip().lower(),
            email=body.email.strip().lower(),
            full_name=body.full_name.strip(),
            password=body.password,
            role="paper_trader",   # new accounts always start as paper_trader
        )
        return _build_login_response(user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/auth/refresh")
async def refresh_token(body: RefreshInput):
    """Exchange a refresh token for a new access token."""
    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    username = payload.get("sub")
    user = get_user(username) if username else None
    if not user or not user.get("active", True):
        raise HTTPException(status_code=401, detail="User inactive")
    token = create_access_token({"sub": user["username"], "role": user["role"]})
    return {"access_token": token, "token_type": "bearer"}


# ── Authenticated endpoints ────────────────────────────────────────────────────

@router.get("/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    return {
        **current_user,
        "permissions": ROLE_PERMISSIONS.get(current_user.get("role", "viewer"), []),
    }


@router.post("/auth/change-password")
async def change_password(body: ChangePasswordInput,
                          current_user: dict = Depends(get_current_user)):
    user_auth = authenticate_user(current_user["username"], body.current_password)
    if not user_auth:
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    try:
        update_user(current_user["username"], password=body.new_password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "Password changed successfully"}


# ── Admin: user management ────────────────────────────────────────────────────

@router.get("/admin/users")
async def admin_list_users(_: dict = Depends(require_admin)):
    return {"users": list_users()}


@router.post("/admin/users")
async def admin_create_user(body: CreateUserInput, _: dict = Depends(require_admin)):
    try:
        user = create_user(body.username, body.full_name, body.password, body.role,
                           email=body.email)
        return {"message": f"User '{body.username}' created", "user": user}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/admin/users/{username}")
async def admin_update_user(username: str, body: UpdateUserInput,
                             _: dict = Depends(require_admin)):
    try:
        user = update_user(username,
                           full_name=body.full_name,
                           email=body.email,
                           password=body.password,
                           active=body.active,
                           role=body.role)
        return {"message": f"User '{username}' updated", "user": user}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/admin/users/{username}")
async def admin_delete_user(username: str, _: dict = Depends(require_admin)):
    try:
        delete_user(username)
        return {"message": f"User '{username}' deleted"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/admin/users/{username}/reset-password")
async def admin_reset_password(username: str, body: dict,
                                _: dict = Depends(require_admin)):
    new_pw = body.get("new_password", "")
    if not new_pw:
        raise HTTPException(status_code=400, detail="new_password required")
    try:
        update_user(username, password=new_pw)
        return {"message": f"Password reset for '{username}'"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/admin/users/{username}/set-role")
async def admin_set_role(username: str, body: dict, _: dict = Depends(require_admin)):
    """Upgrade/downgrade a user's role (e.g. paper_trader → live_trader)."""
    role = body.get("role", "")
    if not role:
        raise HTTPException(status_code=400, detail="role required")
    try:
        user = update_user(username, role=role)
        return {"message": f"Role updated to '{role}'", "user": user}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
