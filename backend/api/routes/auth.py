"""Auth API routes — login, token refresh, user management."""

from fastapi import APIRouter, HTTPException, Depends, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List
from auth.auth_utils import (
    authenticate_user, create_access_token, decode_token,
    get_user, list_users, create_user, update_user, delete_user,
)

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


# ── Request models ─────────────────────────────────────────────────────────────

class CreateUserInput(BaseModel):
    username: str
    full_name: str
    password: str
    role: str = "user"
    permissions: List[str] = []


class UpdateUserInput(BaseModel):
    full_name: Optional[str] = None
    password: Optional[str] = None
    active: Optional[bool] = None
    role: Optional[str] = None
    permissions: Optional[List[str]] = None


class ChangePasswordInput(BaseModel):
    current_password: str
    new_password: str


# ── Dependency: get current user from Bearer token ────────────────────────────

def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    payload = decode_token(token)
    if not payload:
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


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/auth/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    """Login with username + password → JWT access token."""
    user = authenticate_user(form_data.username, form_data.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Incorrect username or password")
    token = create_access_token({"sub": user["username"], "role": user["role"]})
    # admin gets all permissions implicitly
    perms = user.get("permissions", [])
    if user["role"] == "admin":
        perms = ["covered_calls", "wheel", "paper_trade", "market", "ai_insights"]
    return {
        "access_token": token,
        "token_type": "bearer",
        "username": user["username"],
        "full_name": user["full_name"],
        "role": user["role"],
        "permissions": perms,
    }


@router.get("/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    """Return current user info."""
    if current_user.get("role") == "admin":
        current_user = {**current_user, "permissions": ["covered_calls", "wheel", "paper_trade", "market", "ai_insights"]}
    return current_user


@router.post("/auth/change-password")
async def change_password(body: ChangePasswordInput,
                          current_user: dict = Depends(get_current_user)):
    user_auth = authenticate_user(current_user["username"], body.current_password)
    if not user_auth:
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    update_user(current_user["username"], password=body.new_password)
    return {"message": "Password changed successfully"}


# ── Admin: user management ────────────────────────────────────────────────────

@router.get("/admin/users")
async def admin_list_users(_: dict = Depends(require_admin)):
    return {"users": list_users()}


@router.post("/admin/users")
async def admin_create_user(body: CreateUserInput, _: dict = Depends(require_admin)):
    try:
        user = create_user(body.username, body.full_name, body.password, body.role,
                           permissions=body.permissions)
        return {"message": f"User '{body.username}' created", "user": user}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/admin/users/{username}")
async def admin_update_user(username: str, body: UpdateUserInput,
                             _: dict = Depends(require_admin)):
    try:
        user = update_user(username,
                           full_name=body.full_name,
                           password=body.password,
                           active=body.active,
                           role=body.role,
                           permissions=body.permissions)
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
