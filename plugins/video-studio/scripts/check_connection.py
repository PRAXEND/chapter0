"""Read-only ChatCut preflight. Never reads OAuth storage or invokes generation."""
import json
import shutil
import subprocess


def registration():
    """Inspect the existing registration, retaining no URL, headers or raw errors."""
    cli = shutil.which("codex")
    if not cli:
        return "unknown"
    try:
        result = subprocess.run([cli, "mcp", "get", "chatcut", "--json"],
                                capture_output=True, text=True, timeout=15)
        if result.returncode:
            # A CLI/transport failure is not proof that registration is missing.
            error = result.stderr.lower()
            if "no mcp server named" in error:
                return "missing"
            return "unknown"
        value = json.loads(result.stdout)
        if not isinstance(value, dict) or not isinstance(value.get("enabled"), bool):
            return "unknown"
        return "enabled" if value["enabled"] else "disabled"
    except (OSError, subprocess.TimeoutExpired, ValueError, AttributeError):
        return "unknown"


def diagnose(observation, registered="unknown", previous=None):
    """Classify host observations; a successful CLI login is never a live probe.

    Input is deliberately small and categorical. Raw logs, OAuth responses,
    tokens, URLs, headers and arbitrary tool responses are rejected.
    """
    if not isinstance(observation, dict):
        raise ValueError("Connection observations must be an object")
    allowed = {"tools_available", "live_probe", "auth", "startup", "session_id"}
    if set(observation) - allowed:
        raise ValueError("Only categorical connection observations are accepted; omit raw logs and credentials")
    if registered not in {"enabled", "disabled", "missing", "unknown"}:
        raise ValueError("Invalid registration state")
    tools = observation.get("tools_available")
    if tools is not None and not isinstance(tools, bool):
        raise ValueError("tools_available must be a boolean")
    probe = observation.get("live_probe", "not_run")
    auth = observation.get("auth", "unknown")
    startup = observation.get("startup", "unknown")
    if probe not in {"not_run", "success", "auth_required", "failed"}:
        raise ValueError("Invalid live_probe state")
    if auth not in {"unknown", "login_succeeded", "required"}:
        raise ValueError("Invalid auth state")
    if startup not in {"unknown", "ready", "failed", "issuer_missing", "timeout"}:
        raise ValueError("Invalid startup state")
    session = observation.get("session_id")
    if session is not None:
        if not isinstance(session, str) or not session or len(session) > 100 or not all(c.isalnum() or c in "-_" for c in session):
            raise ValueError("session_id must be an opaque host identifier, not a URL or free text")
    if probe != "not_run" and tools is not True:
        raise ValueError("A live probe requires tools_available=true")

    # Current authenticated tool results outrank CLI configuration and old logs.
    if probe == "success":
        state, action, message = "connected", "continue", "ChatCut 实际工具调用成功，可以继续制作。"
    elif probe == "auth_required" or (auth == "required" and probe == "not_run"):
        state, action, message = "auth_required", "login", "ChatCut 明确要求认证；在宿主中完成一次登录，再做实际工具验证。"
    elif probe == "failed":
        state, action, message = "connection_failed", "inspect_connection_error", "ChatCut 工具调用失败；按这次调用错误诊断，不把所有失败都当作需登录。"
    elif tools is True:
        state, action, message = "probe_required", "live_probe", "工具已加载，但尚未验证访问；先调用 list_projects 或当前项目的只读工具。"
    elif registered == "missing":
        state, action, message = "registration_missing", "register_hosted_mcp", "未发现 ChatCut 服务注册；按已安装 ChatCut 指南配置 Hosted MCP。"
    elif registered == "disabled":
        state, action, message = "registration_disabled", "review_host_settings", "ChatCut 注册已停用；检查宿主 MCP 设置，不创建重复服务。"
    elif tools is False and startup == "issuer_missing":
        state, action, message = "host_auth_metadata_error", "reauthorize_in_host", "宿主报告 OAuth issuer 元数据缺失；在报错的应用中重新授权。CLI 登录成功不证明应用连接已恢复。"
    elif tools is False and startup in {"failed", "timeout"}:
        state, action, message = "startup_failed", "inspect_startup_error", "ChatCut 启动失败；保留具体错误类别，检查宿主连接后重新加载会话。"
    elif tools is False and registered == "enabled":
        state, action, message = "tools_not_loaded", "reload_session", "ChatCut 已注册，但当前聊天没有调用工具；保存断点后从侧栏新建聊天加载。旧聊天继续发消息不会验证新会话是否恢复。"
    else:
        state, action, message = "unverified", "inspect_registration_and_tools", "证据不足；检查宿主当前工具清单和现有注册，不猜测登录已失效。"

    evidence = {"registration": registered, "tools_available": tools,
                "live_probe": probe, "auth": auth, "startup": startup,
                "session_id": session}
    repeated = bool(previous and previous.get("state") == state and previous.get("checks") == evidence)
    if repeated and action != "continue":
        message += " 状态与上次相同；不要循环登录、安装或重复准备素材，给出一次具体恢复操作。"
    return {"schema_version": 1, "state": state, "ready": state == "connected",
            "next_action": action, "message": message, "checks": evidence,
            "unchanged_since_previous_check": repeated,
            "automatic_login": False, "automatic_generation": False,
            "host_reload_supported_by_this_plugin": False}
