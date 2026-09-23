#!/usr/bin/env python3
"""一次性积分任务脚本的共享函数库.

从 auths/ 读账号凭证，封装 growth 域 / report 域请求，供 task_*.py 复用。
全部默认 dry-run（写动作由调用脚本显式 --yes 放行）。

端点权威来源（Go 代码实测 + 实测确认）：
  - chat 域（copilot.tencent.com）：growth / tasks / buddy / streak / chat/completions
  - billing 域（www.codebuddy.cn）：/v2/report
  - accept : POST /v2/activity/growth/tasks/accept  {"task_codes":[code]}
  - claim  : POST /v2/activity/growth/tasks/reward/claim {"task_code":code}
"""
import json, os, time, glob, urllib.request, urllib.error, base64

# 默认凭证目录：优先读取环境变量 WORKBUDDY_AUTHS_DIR 或 AUTHS_DIR，回退到当前脚本目录同级的 auths/
DEFAULT_AUTHS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "auths")
AUTHS = os.environ.get("WORKBUDDY_AUTHS_DIR") or os.environ.get("AUTHS_DIR") or DEFAULT_AUTHS

CHAT_BASE = "https://copilot.tencent.com"   # growth / tasks / buddy / streak / chat
BILL_BASE = "https://www.codebuddy.cn"      # report / billing

# growth 域常量
PATH_LIST_TASKS     = "/v2/activity/growth/tasks"
PATH_ACCEPT_TASKS   = "/v2/activity/growth/tasks/accept"
PATH_CLAIM_REWARD   = "/v2/activity/growth/tasks/reward/claim"
PATH_BUDDY_FIRST    = "/activity/growth/buddy/first"
PATH_BUDDY_AGREEMENT = "/activity/growth/buddy/agreement"
PATH_STREAK         = "/activity/growth/streak"
PATH_REPORT         = "/v2/report"
PATH_CHAT           = "/v2/chat/completions"

CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2"


def _parse_jwt(token: str) -> dict:
    """解析 JWT Payload，安全提取 claims（无需第三方依赖）。"""
    try:
        parts = token.split(".")
        if len(parts) >= 2:
            p = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
            return json.loads(base64.urlsafe_b64decode(p).decode("utf-8", "ignore"))
    except Exception:
        pass
    return {}


def _parse_auth_dict(d: dict, p: str) -> dict:
    if not isinstance(d, dict):
        raise SystemExit(f"Invalid auth entry in {p}: expected dict, got {type(d).__name__}")
    # 1. workbuddy2api 格式
    if "auth" in d and isinstance(d["auth"], dict):
        a = d["auth"]
        acc = d.get("account") or {}
        token = a.get("accessToken") or a.get("access_token") or ""
        claims = _parse_jwt(token)
        uid = acc.get("uid") or a.get("uid") or claims.get("uid") or claims.get("sub") or ""
        domain = a.get("domain") or claims.get("domain") or ""
        nick = acc.get("nickname") or claims.get("nickname") or ""
    # 2. ai-gateway 池状态格式
    elif "token" in d and isinstance(d["token"], dict):
        t = d["token"]
        token = t.get("access_token") or t.get("accessToken") or ""
        claims = _parse_jwt(token)
        uid = d.get("uid") or t.get("uid") or claims.get("uid") or claims.get("sub") or ""
        domain = d.get("domain") or t.get("domain") or claims.get("domain") or ""
        nick = d.get("nickname") or claims.get("nickname") or ""
    # 3. 扁平格式
    else:
        token = d.get("access_token") or d.get("accessToken") or d.get("token") or ""
        claims = _parse_jwt(token)
        uid = d.get("uid") or claims.get("uid") or claims.get("sub") or ""
        domain = d.get("domain") or claims.get("domain") or ""
        nick = d.get("nickname") or claims.get("nickname") or ""

    if not token:
        raise SystemExit(f"No access token found in {p}")
    if not uid:
        uid = claims.get("uid") or claims.get("sub") or "unknown_user"

    return {"token": token, "domain": domain, "uid": uid, "nick": nick, "file": os.path.basename(p)}


def get_all_auth_prefixes() -> list:
    """返回 AUTHS 目录下所有可用账号的 uid 前缀（支持单账号文件与多账号导出数组文件）。"""
    pattern1 = os.path.join(AUTHS, "workbuddy-*.json")
    pattern2 = os.path.join(AUTHS, "*.json")
    files = sorted(set(glob.glob(pattern1) + glob.glob(pattern2)))
    prefixes = []
    for p in files:
        try:
            with open(p, "r", encoding="utf-8") as f:
                content = json.load(f)
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("uid"):
                        prefixes.append(item["uid"][:8])
            elif isinstance(content, dict):
                uid = content.get("uid") or (content.get("account") or {}).get("uid")
                if uid:
                    prefixes.append(uid[:8])
                else:
                    base = os.path.basename(p)
                    if base.startswith("workbuddy-"):
                        prefixes.append(base[10:].replace(".json", "")[:8])
                    else:
                        prefixes.append(base.replace(".json", "")[:8])
        except Exception:
            base = os.path.basename(p)
            prefixes.append(base.replace(".json", ""))
    seen, res = set(), []
    for x in prefixes:
        if x and x not in seen:
            seen.add(x)
            res.append(x)
    return res


def load_auth(uid_or_file: str) -> dict:
    """从 auths/、指定 JSON 文件或环境变量加载账号凭证。

    uid_or_file 可以为：
      - "env": 从环境变量 WORKBUDDY_TOKEN, WORKBUDDY_UID, WORKBUDDY_DOMAIN 读取
      - 绝对路径或相对路径的 .json 文件（单账号 dict 或多账号 list）
      - uid 前缀（自动匹配独立文件或多账号导出数组文件中的匹配账号）

    支持的数据格式：
      - workbuddy2api 格式：{"auth": {"accessToken": "..."}, "account": {"uid": "..."}}
      - ai-gateway 格式：{"token": {"access_token": "..."}, "uid": "..."}
      - 扁平格式：{"access_token": "...", "uid": "..."}
      - ai-gateway 批量导出数组：[{...}, {...}]

    返回 {token, domain, uid, nick, file} 五元组。
    """
    if uid_or_file == "env":
        token = os.environ.get("WORKBUDDY_TOKEN", "")
        if not token:
            raise SystemExit("Environment variable WORKBUDDY_TOKEN is not set")
        claims = _parse_jwt(token)
        uid = os.environ.get("WORKBUDDY_UID") or claims.get("uid") or claims.get("sub") or "env_user"
        domain = os.environ.get("WORKBUDDY_DOMAIN") or claims.get("domain") or ""
        nick = os.environ.get("WORKBUDDY_NICK") or claims.get("nickname") or claims.get("name") or uid
        return {"token": token, "domain": domain, "uid": uid, "nick": nick, "file": "env"}

    pre = ""
    target_item = None
    target_file = ""

    if os.path.sep in uid_or_file or uid_or_file.endswith(".json") or os.path.isfile(uid_or_file):
        p = uid_or_file
        if not os.path.isabs(p) and not os.path.exists(p):
            p = os.path.join(AUTHS, p)
        if not os.path.exists(p):
            raise SystemExit(f"Auth file not found: {p}")
        target_file = p
    else:
        pre = uid_or_file
        hits = glob.glob(os.path.join(AUTHS, f"workbuddy-{pre}*.json")) or glob.glob(os.path.join(AUTHS, f"{pre}*.json"))
        if hits:
            target_file = hits[0]
        else:
            # 扫描所有 JSON 文件（支持从多账号导出数组文件中按 UID 查找）
            all_files = sorted(set(glob.glob(os.path.join(AUTHS, "workbuddy-*.json")) + glob.glob(os.path.join(AUTHS, "*.json"))))
            for fpath in all_files:
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        content = json.load(f)
                    if isinstance(content, list):
                        for item in content:
                            if isinstance(item, dict):
                                i_uid = str(item.get("uid") or "")
                                i_nick = str(item.get("nickname") or "")
                                if i_uid.startswith(pre) or i_nick == pre:
                                    target_item = item
                                    target_file = fpath
                                    break
                        if target_item:
                            break
                    elif isinstance(content, dict):
                        i_uid = str(content.get("uid") or (content.get("account") or {}).get("uid") or "")
                        if i_uid.startswith(pre):
                            target_item = content
                            target_file = fpath
                            break
                except Exception:
                    continue
            if not target_file and not target_item:
                raise SystemExit(f"no auth for {pre} in {AUTHS}")

    if target_item is not None:
        return _parse_auth_dict(target_item, target_file)

    with open(target_file, "r", encoding="utf-8") as f:
        d = json.load(f)

    if isinstance(d, list):
        if not d:
            raise SystemExit(f"Empty account list in {target_file}")
        matched = None
        if pre:
            for item in d:
                if isinstance(item, dict):
                    i_uid = str(item.get("uid") or "")
                    i_nick = str(item.get("nickname") or "")
                    if i_uid.startswith(pre) or i_nick == pre:
                        matched = item
                        break
        d = matched if matched is not None else d[0]

    return _parse_auth_dict(d, target_file)


def chat_base(auth: dict) -> str:
    return auth.get("chat_base") or CHAT_BASE


def billing_base(auth: dict) -> str:
    return auth.get("billing_base") or BILL_BASE


def _headers(auth: dict) -> dict:
    hdr = {"Authorization": "Bearer " + auth["token"],
           "Accept": "application/json",
           "Content-Type": "application/json",
           "User-Agent": CLIENT_UA,
           "Origin": "https://www.codebuddy.cn",
           "Referer": "https://www.codebuddy.cn/"}
    if auth.get("uid"):
        hdr["X-User-Id"] = auth["uid"]
    if auth.get("domain"):
        hdr["X-Domain"] = auth["domain"]
    return hdr


def _request(auth, method, base, path, body=None, headers=None, timeout=30):
    url = path if path.startswith("http") else base + path
    hdr = _headers(auth)
    if headers:
        hdr.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        t = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, {"raw": t[:300]}
    except Exception as e:
        return -1, {"err": repr(e)}


def do_get(auth, base, path, headers=None) -> tuple:
    """GET 读请求，返回 (status, dict)。"""
    return _request(auth, "GET", base, path, None, headers)


def do_post(auth, base, path, body, headers=None) -> tuple:
    """POST 写请求，返回 (status, dict)。body 为 dict。"""
    return _request(auth, "POST", base, path, body, headers)


def list_tasks(auth) -> list:
    """GET /v2/activity/growth/tasks 全量任务列表（元素为原始 dict）。"""
    st, d = do_get(auth, chat_base(auth), PATH_LIST_TASKS)
    if st != 200:
        raise RuntimeError(f"list_tasks http={st}")
    tasks = (d.get("data", {}) or {}).get("tasks") or []
    return tasks


def task_status(auth, task_code) -> dict | None:
    """查单个任务当前状态；找不到返回 None。"""
    for t in list_tasks(auth):
        if t.get("task_code") == task_code:
            return t
    return None


def accept_tasks(auth, task_codes) -> tuple:
    """POST accept 任务（not_accepted → accepted）。返回 (status, resp)。"""
    return do_post(auth, chat_base(auth), PATH_ACCEPT_TASKS,
                   {"task_codes": task_codes})


def claim_reward(auth, task_code) -> tuple:
    """POST claim 领取奖励（任务已 complete 后可领）。重复领返回业务错误，安全。"""
    return do_post(auth, chat_base(auth), PATH_CLAIM_REWARD,
                   {"task_code": task_code})


def get_streak(auth) -> int:
    """GET /activity/growth/streak 连登天数（只读 oracle）。失败返回 -1 记日志。"""
    st, d = do_get(auth, chat_base(auth), PATH_STREAK)
    if st != 200:
        return -1
    return (d.get("data", {}).get("streak", {}) or {}).get("days", 0)


def chat_event(auth, conversation_id=None, model_id="deepseek-v4-flash",
               model_name="DeepSeek V4 Flash", mode="craft"):
    """客户端 chat_request_send 事件完整形状。

    必须带 userId（=账号 uid），缺失则服务端 200 但静默丢弃。
    model_id/name 可换（如 GLM-5.2），供 model_chat 对齐实际模型。
    """
    now = int(time.time() * 1000)
    cid = conversation_id or f"task-{now}"
    return {"eventCode": "chat_request_send", "timestamp": now, "reportDelay": 0,
            "mode": mode, "conversationId": cid, "requestId": cid,
            "inputLength": 12, "requestModelId": model_id,
            "requestModelName": model_name, "isPlan": False,
            "isAutoExecuteTerminal": False, "isAutoModify": False,
            "codebaseEnable": False, "maxToken": 0, "maxSteps": 0, "temperature": 0,
            "maxRetries": 0, "mentionContexts": [], "knowledgeId": [],
            "knowledgeName": [], "codebaseId": "", "mentionContextCount": 0,
            "command": "", "expertId": "", "recommendId": "", "skillId": "",
            "skillCount": 0, "totalCount": 0, "fileUri": "", "presentAt": now,
            "traceId": "", "rootRequestId": cid, "parentConversationId": cid,
            "agentName": "default", "agentType": "conversation", "userId": auth["uid"]}


def report_activity(auth, count=1, gap=1.05, model_id="deepseek-v4-flash",
                    model_name="DeepSeek V4 Flash", mode="craft") -> list:
    """向 {billing}/v2/report 上报 count 条 chat_request_send。

    每次间隔 >= gap 秒（默认 1.05，匹配限速口径）。
    返回 [(status, code), ...] 汇总。
    """
    out = []
    for i in range(count):
        ev = chat_event(auth, model_id=model_id, model_name=model_name, mode=mode)
        st, r = do_post(auth, billing_base(auth), PATH_REPORT, [ev])
        out.append((st, r.get("code") if isinstance(r, dict) else None))
        if i < count - 1:
            time.sleep(gap)
    return out


def chat_completion(auth, model_id="glm-5.2", prompt="hi", max_tokens=32,
                    timeout=60, extra_var=None) -> tuple:
    """POST {chat}/v2/chat/completions 真实对话一次（stream:true）。

    服务端强制流式，逐行读 SSE 直到 done。
    返回 (status, first_content)。用于 Model_chat_GLM5.2 的“真实对话一次”。
    """
    body = {"model": model_id, "messages": [{"role": "user", "content": prompt}],
            "stream": True, "max_tokens": max_tokens}
    if extra_var:
        body["extra_vars"] = {**(body.get("extra_vars") or {}), **extra_var}
    hdr = {"Accept": "text/event-stream"}
    url = chat_base(auth) + PATH_CHAT
    req_headers = _headers(auth)
    req_headers.update(hdr)
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers=req_headers, method="POST")
    first = ""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = r.status
            for raw in r:
                line = raw.decode("utf-8", "replace")
                if line.startswith("data: "):
                    payload = line[6:].strip()
                    if payload in ("[DONE]", ""):
                        continue
                    try:
                        obj = json.loads(payload)
                        delta = (obj.get("choices") or [{}])[0].get("delta") or {}
                        content = delta.get("content") or ""
                        if content and not first:
                            first = content
                    except Exception:
                        pass
            return status, first
    except urllib.error.HTTPError as e:
        t = e.read().decode("utf-8", "replace")
        return e.code, t[:200]
    except Exception as e:
        return -1, repr(e)[:200]
