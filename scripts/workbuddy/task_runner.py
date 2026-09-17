#!/usr/bin/env python3
"""task_runner —— 批量「查询 → 完成(点亮) → 领取」成长任务的一体化辅助工具.

用途
  对任意账号（uid 前缀 / ALL）查询成长任务现状，并对可伪造成就态的任务补齐上报
  点亮至 completed，最后经真实领奖端点入账。默认 dry-run（只查询展示），--yes 才写。

主要用法
  python3 task_runner.py <uid>                       # dry-run：查询展示任务现状
  python3 task_runner.py <uid> --yes --only-claim    # 只领奖（已完成任务直接入账，幂等）
  python3 task_runner.py <uid> --yes --only template_5   # 只完成/领取指定任务
  python3 task_runner.py <uid> --yes                 # 全量：accept→点亮→回读→claim
  python3 task_runner.py ALL --yes                      # 批量（写操作慎用，符合预算才执行）

参数
  account    uid 前缀或 ALL（ALL = auths/workbuddy-*.json 全部）
  --yes      真实执行写操作；缺省 dry-run 不发任何上报/accept/claim
  --only     只处理指定 task_code（可多次），同时过滤 dry-run 展示
  --only-claim 只领奖不点亮（对已完成但未领的账号直接入账；已领任务服务端幂等）
  --gap      上报/领奖动作间隔秒数，默认 1.0（所有写动作 ≥1s）

映射表摘要（task_code → 点亮事件 → 次数 → 对象 id 来源）
  常规上报经 POST {billing}/v2/report（必带 userId）：
    create_canvas        wbx_design_canvas_task_create      1  （自造 id wb-<ms>）
    template_5           agent_task_created_with_template   5  （scene ids: /console/as/support/scenes）
    expert_5             expert_actual_use                  5  (ex_ id: market expert/list)
    Expert_team_use_3    expert_actual_use(expertType=team) 3  （团队 id: market/COS expertType=team）
    skill_1              skill_info                         1  （skillId: market/skill/list）
    automation_1         automated_task_create_suc          1  （rrule 虚拟对象）
    playbook_prompt      playbook_prompt_send               1  （案例 id: static registry.json）
    Expert_lighthouse    expert_actual_use                  1  （轻量云 ex_ id: 关键词过滤）
    Hp_Appearance        appearance_skin_apply              1  （theme resourceKey: appearance/resources）
    chat_5               chat_request_send                  5  （5 条独立 conversation）
    Model_chat_GLM5.2    chat_request_send(glm-5.2)         1
    black_cat            chat_request_send(glm-5.2)         3  （★夜猫窗口 23-08 CST，窗口内最多补 1 次）
  桌面指纹事件链（fork autotask.go 实测吸收：POST {chat}/v2/report + desktopFingerprint 注入）：
    RichMeow_Chat       桌面对话链 6 连事件组                   1  （agent_task_created→…→chat_request_response）
    Buddy_App/_QQ       buddyapp 五连（discover→…→bind_skip）  1  （application_id: open-platform search）
  web 域行为（fork ReportWebEvent 实测：POST www.workbuddy.cn/v2/report + web 指纹）：
    Library_read        web_element_click(library_doc_intro_click) 1  （space 文档 URL）
  小程序成长任务（growth 域 X-Client-Platform: miniprogram 专属下发，chat 域同头）：
    Sequential_Tasks_1  在小程序内完成 1 次有效对话（mini chat_request_send，
                        无 activityId——服务端按 source=mini_program 指纹关联） 100c+5e
    school_season       参与「校园日」有奖活动（jump 落 coffee-activity H5 = school 开学季
                        同一活动；mini chat_request_send + activityId=school_open_day_2026
                        点亮，无 activityId 不点亮）                              100c+5e
  仍不可伪造：
    Expert_Philanthropy   真实捐款动作(M8)

领奖端点（M15 突破，勿用旧端点）
  POST {chat}/activity/growth/tasks/{task_code}/claim   —— 路径含 task_code、无 body（M15 实测）。
  旧 /v2/activity/growth/tasks/reward/claim 是 404 错端点。
  chat 域 400 时自动降级 web 域：POST https://www.workbuddy.cn/activity/growth/tasks/{code}/claim，
  带 Origin/Referer/x-client-platform: web 头（fork ClaimReward 同款，web_claim_fallback）。
  accept: POST {chat}/activity/growth/tasks/accept  body {"task_codes":[...]}（复数数组）。

来源：scripts/task_*.py 实测沉淀 + 各里程碑报告（M1-M15）+ 参考实现。
linguo2625469/workbuddy2api-panel（autotask.go/desktop.go/report.go/tasks.go 三账号实测）。
<uid> 已 14/14 claimed（credit +1450、energy +65），本脚本把相同桩点
知识固化为可对任意账号批量执行的 runner。

注意
  - 不修改 task_common.py（保持纯 HTTP 工具层）；本次映射逻辑全部留在本文件。
  - claim 用真实端点验证过幂等：已领任务返回 already_claimed，不重复入账。
  - richmeow/buddy 走 chat 域 /v2/report + 桌面指纹（ideName=WorkBuddy/extName=workbuddy-desktop，
    machineId/sessionId 由 uid+盐 md5 稳定派生，勿每次随机）；library 走 web 域 web 指纹。
  - 日志前缀 [task_runner]，行为 action ∈ query/accept/report/claim，汇总行 task_runner done: ...
"""
import sys, os, json, time, argparse, glob, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import task_common as tc
# school 模块仅作**事件形状单一事实源**复用（school.mini_chat_event），不复用其 HTTP 层
# ——mp 上报通道本文件已有（report_mp_events，同 codebuddy.cn 域 + 同 MP 头）。
# 源提交 e45f39f 的 schoolseason 判据直接调 school.mini_chat_event，勿在此手抄第二份形状。
import school_open_day_2026 as school

# --------------------------------------------------------------------------
# 任务映射表（task_code -> 完成定义）
#   kind     事件构建器类型（build_event/ids_for 分派）
#   target   兜底次数（优先读服务端 progress.target）
#   src      对象 id 来源说明（仅展示）
#   unforgeable / reason   不可伪造任务的标注
# --------------------------------------------------------------------------
MAPPING = {
    "create_canvas":          {"kind": "canvas",     "target": 1, "src": "自造 wb-<ms>"},
    "template_5":             {"kind": "template",   "target": 5, "src": "scenes 场景 id"},
    "expert_5":               {"kind": "expert",     "target": 5, "src": "专家市场 ex_ id"},
    "Expert_team_use_3":      {"kind": "team",       "target": 3, "src": "团队 id"},
    "skill_1":                {"kind": "skill",      "target": 1, "src": "skillId"},
    "automation_1":           {"kind": "automation", "target": 1, "src": "rrule 虚拟对象"},
    "playbook_prompt":        {"kind": "playbook",   "target": 1, "src": "playbook 案例 id"},
    "Expert_lighthouse":      {"kind": "lighthouse", "target": 1, "src": "轻量云专家 id"},
    "Buddy_App":              {"kind": "buddy5",     "target": 1, "src": "buddy 应用 id"},
    "Buddy_App_QQ":           {"kind": "buddy5",     "target": 1, "src": "企鹅教师助手 id"},
    "Hp_Appearance":          {"kind": "skin",       "target": 1, "src": "主题 resourceKey"},
    "chat_5":                 {"kind": "chat",       "target": 5, "src": "无(独立会话)"},
    "Model_chat_GLM5.2":      {"kind": "glmchat",    "target": 1, "src": "无(glm-5.2)"},
    # 特殊：时段敏感（夜猫窗口 23-08 CST），窗口内最多补 1 次
    "black_cat":              {"kind": "cat",        "target": 3, "src": "无(glm-5.2 夜猫)"},
    # 桌面指纹 6 连对话事件链（fork DesktopChatSequence，三账号实测点亮）
    "RichMeow_Chat":          {"kind": "richmeow",   "target": 1, "src": "无(桌面指纹对话链)"},
    # web 域 web_element_click（fork ReportWebEvent，三账号实测点亮）
    "Library_read":           {"kind": "library",    "target": 1, "src": "无(资料库介绍点击)"},
    # 小程序成长任务（growth 域小程序限定）：列表/accept/claim 均需 X-Client-Platform: miniprogram。
    # 该 code 在默认（无 mp 头）任务列表里不存在，必须专段处理，不进 process_task 主循环。
    "Sequential_Tasks_1":     {"kind": "minichat",   "target": 1, "src": "无(mini 对话无activityId)"},
    # 同一下发口径的「校园日」任务（移植 workbuddy2api e45f39f）：jump_url 落
    # coffee-activity H5（/events/school-season/），但完成判据走 school 域 activityId 关联
    # ——一条 mini chat_request_send + activityId=school_open_day_2026 即点亮，
    # **无 activityId 不点亮**（源实测 0ceb9c7c/f8657995）。accept/claim 均要求 mp 头。
    "school_season":          {"kind": "schoolseason", "target": 1, "src": "无(mini chat+activityId)"},
    # 不可伪造（真实业务副作用）
    "Expert_Philanthropy":    {"unforgeable": True, "reason": "真实捐款动作(M8)"},
}

# 夜猫时段（CST）23:00 - 次日 08:00
def within_night_window():
    try:
        import datetime as _dt
        now = _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=8)))
        return now.hour >= 23 or now.hour < 8
    except Exception:
        return None


# --------------------------------------------------------------------------
# 稳定指纹派生（fork deriveID 同款思路：md5(uid+盐) 截短，注入用，勿每次随机）
# --------------------------------------------------------------------------
def derive_id(auth, salt):
    """由 uid 稳定派生一个 36 位 hex 设备标识（machineId/sessionId 复用）。

    幂等：同一账号每次生成相同值，模拟固定设备（fork desktop.go deriveID）。
    只用于事件指纹注入，不参与任何业务逻辑。
    """
    import hashlib
    # sha256 而非 md5（弱敏感数据哈希，CodeQL py/weak-sensitive-data-hashing）
    return hashlib.sha256(f"{salt}:{auth['uid']}".encode()).hexdigest()[:36]


def desktop_fingerprint(auth):
    """fork desktopFingerprint 同款公共桌面指纹（注入每个事件，覆盖同名业务键）。"""
    now = int(time.time() * 1000)
    return {
        "timezone": "Asia/Shanghai", "reportDelay": 2000,
        "userId": auth["uid"],
        "username": auth.get("nick", ""), "userNickname": auth.get("nick", ""),
        "product": "SaaS", "releaseDate": 1789036585355,
        "commit": "5f9692923c93033111c51ad7b003eb80204a9b75",
        "ideName": "WorkBuddy", "ideType": "WorkBuddy", "ideVersion": "5.5.6",
        "machineId": derive_id(auth, "machine"), "sessionId": derive_id(auth, "session"),
        "extName": "workbuddy-desktop", "extVersion": "5.5.6",
        "os": "win32", "arch": "x64", "osVersion": "10.0.26220",
        "cpuCores": 20, "memorySize": 24,
        "timestamp": now, "presentAt": now,
    }


def _desktop_headers(auth):
    """chat 域桌面指纹请求头（fork ReportDesktopEvent 同款）。"""
    return {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8",
        "User-Agent": DESKTOP_UA,
        "X-Domain": tc.chat_base(auth),
        "X-Product": "SaaS",
        "X-Request-ID": derive_id(auth, "req") + str(time.time_ns() % 1000000),
        "X-User-Id": auth["uid"],
    }


def _web_event_headers(auth, page_url):
    """web 域浏览器请求头（fork ReportWebEvent 同款，Library_read 用）。

    X-Domain 显式覆盖为 web 域：task_common._headers 会把 auth 的 domain
    （如 copilot.tencent.com）带上，发往 www.workbuddy.cn 会造成跨域不一致。
    """
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "x-client-platform": "web",
        "Origin": WEB_BASE,
        "Referer": page_url,
        "User-Agent": WEB_UA,
        "X-User-Id": auth["uid"],
        "X-Domain": WEB_BASE,
    }


def _web_claim_headers(auth):
    """web 域领奖头（fork ClaimReward 同款，web_claim_fallback 用）。"""
    return {
        "Authorization": "Bearer " + auth["token"],
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": WEB_BASE,
        "Referer": f"{WEB_BASE}/profile/growth-center",
        "x-client-platform": "web",
        "User-Agent": WEB_UA,
        "X-User-Id": auth["uid"],
        "X-Domain": WEB_BASE,
    }


# --------------------------------------------------------------------------
# 对象 id 来源（只读 fetch；均返回 [(id, meta_dict), ...] 有序去重列表）
# --------------------------------------------------------------------------
DEFAULT_SCENES = [(0, "幻灯片"), (2, "视频生成"), (4, "深度研究"), (6, "文档处理"),
                  (8, "数据分析"), (10, "可视化"), (12, "金融服务"), (14, "产品管理")]
DEFAULT_EXPERT_IDS = [
    "ContentCreator", "UiDesigner", "DataAnalyticsReporter", "ChinaEcommerceOperationsExpert",
    "DouyinStrategist", "SalesCoach", "BrandGuardian", "XiaohongshuOperationsExpert",
]
EXPERT_NAMES = {
    "ContentCreator": "内容创作专家", "UiDesigner": "UI设计师",
    "DataAnalyticsReporter": "数据分析报告师", "ChinaEcommerceOperationsExpert": "中国电商运营专家",
    "DouyinStrategist": "抖音策略师", "SalesCoach": "销售教练",
    "BrandGuardian": "品牌策略师", "XiaohongshuOperationsExpert": "小红书运营专家",
}
DEFAULT_TEAM_IDS = ["CloudOpsTeam", "SoftwareCompany", "TradingAgentTeam",
                    "GPTResearcherTeam", "MarketingCampaignTeam"]
DEFAULT_SKILL_IDS = [
    ("skill_2096525080079265792", "pptx"),
    ("skill_2096528888507297792", "xlsx"),
    ("skill_2070033533400236032", "qqmusic"),
    ("skill_2095322904487550976", "pdf"),
]
DEFAULT_CASES = [("worker-ledger-freedom-dashboard", {"title": "打工人小账本",
                  "artifact_type": "other", "categories": [""], "skills": [],
                  "experts": [], "prompt": ""})]
LIGHTHOUSE_IDS = [("ex_2cvvUZQhDyeJ", {
    "name": "腾讯轻量云专家", "category": "02-Engineering",
    "expertType": "agent", "version": "1.0.2"})]
LIGHTHOUSE_KEYWORDS = ["lighthouse", "轻量云"]

# 连登/能量读数（只读 oracle，M15 实测 /v2/activity/growth/energy -> data.balance）
PATH_ENERGY = "/v2/activity/growth/energy"
# buddyapp 五连事件承载应用（fork DesktopBuddyAppSequence 实测用企鹅教师助手，
# 同一组事件同时满足 Buddy_App 与 Buddy_App_QQ；两账号实测点亮）
BUDDY_APPS = {"Buddy_App": ("cb_y5Dy46tPQGGWtueMxXbe", "企鹅教师助手"),
              "Buddy_App_QQ": ("cb_y5Dy46tPQGGWtueMxXbe", "企鹅教师助手")}
PE_THEME = ("theme-tkmw7j", {"name": "和平精英激战金秋", "vipLevel": "free",
                             "series": "craft", "appearance": "light"})

COS_EXPERT_URL = ("https://acc-1258344699.cos.accelerate.myqcloud.com/"
                  "workbuddy/expert-marketplace/expert_center.json")
PLAYBOOK_BASE = "https://static.workbuddy.cn/workbuddy/playbook"
MARKET_LIST_PATH = "/v2/operation-platform/market/expert/list"
WEB_BASE = "https://www.workbuddy.cn"

# 小程序成长任务（growth 域小程序限定）吸收常量（源提交 8622910）：
#   growth 域任务列表/accept/claim 端点对 X-Client-Platform 敏感——带 miniprogram 才下发
#   小程序限定任务（默认 18 项 vs mp 口径 9 项）。web 小程序 H5 由请求拦截器统一注入该头
#   （config-D_y8qqW1.js：判 session platform=miniProgram 时注入）。
#   实测结论（源提交 8622910 记录）：缺该头时 accept 返回 task not found。
MP_PLATFORM_HEADER = {"X-Client-Platform": "miniprogram"}
# 小程序 UA 由微信原生注入（源 school 模块 _build_headers 同款，mp 上报沿用）
MP_UA = ("Mozilla/5.0 (Linux; Android 14; MicroMessenger/8.0.49 WeChat/0.8.0 "
         "MiniProgramEnv/android; wkbrowser xweb)")

# fork 桌面指纹（desktop.go）/ web 域（report.go）吸收常量
DESKTOP_UA = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1"
WEB_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36")
# Library_read 空间文档 URL（fork autotask.go:438 实测三账号点亮）
LIBRARY_DOC_URL = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm"


def _fetch_scenes(auth):
    """GET /console/as/support/scenes -> [(scene_id, name)]（只读）。"""
    out = []
    try:
        st, d = tc.do_get(auth, tc.chat_base(auth), "/console/as/support/scenes?locale=zh-CN")
        if st == 200 and (d.get("code") in (0, None)):
            for s in (d.get("data") or {}).get("scenes") or []:
                if s.get("id") is not None:
                    out.append((str(s["id"]), s.get("name") or ""))
    except Exception as ex:
        print(f"  [warn] 场景清单拉取失败({ex})，回落内置表")
    if not out:
        out = [(str(i), n) for i, n in DEFAULT_SCENES]
    return out


def _fetch_market_experts(auth, team_only=False, keyword=None):
    """运行时专家市场 POST expert/list -> [(ex_id, meta)]。team_only 只留 expert_type=team。"""
    out, seen = [], set()
    try:
        for page in range(1, 4):
            body = {"page": page, "page_size": 50}
            if keyword:
                body["keyword"] = keyword
            st, r = tc.do_post(auth, tc.chat_base(auth), MARKET_LIST_PATH, body)
            if st != 200:
                break
            experts = ((r.get("data") or {}).get("experts") or [])
            if not experts:
                break
            for e in experts:
                eid = e.get("expert_id") or e.get("source_id")
                if not eid or eid in seen:
                    continue
                etype = e.get("expert_type") or "agent"
                if team_only and etype != "team":
                    continue
                seen.add(eid)
                out.append((eid, {
                    "name": e.get("display_name_zh") or e.get("profession_zh") or "",
                    "category": (e.get("categories") or [""])[0] or "",
                    "expertType": etype, "version": e.get("version") or "",
                    "agent_name": e.get("agent_name") or "",
                }))
            if len(experts) < 50:
                break
    except Exception as ex:
        print(f"  [warn] 专家市场拉取失败({ex})，回落内置表")
    # COS 静态清单补足（expert_center.json）：团队专家市场列表很薄（250 个里仅 2 个 team），
    # M4 实测 COS 有 52 个 team，作为 team_only 的主/补来源；普通专家用市场 ex_ id。
    try:
        req = urllib.request.Request(COS_EXPERT_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as rr:
            data = json.loads(rr.read().decode("utf-8", "replace"))
        seen = {i for i, _ in out}
        for e in (data.get("experts") or []):
            eid = e.get("id")
            etype = e.get("expertType") or "agent"
            if not eid or (team_only and etype != "team"):
                continue
            if eid in seen:
                continue
            seen.add(eid)
            prof = e.get("profession") or {}
            out.append((eid, {"name": prof.get("zh") or "",
                              "category": e.get("categoryId") or "",
                              "expertType": etype, "version": ""}))
    except Exception as ex2:
        print(f"  [warn] COS 专家清单失败({ex2})")
    if not out:
        ids = DEFAULT_TEAM_IDS if team_only else DEFAULT_EXPERT_IDS
        out = [(i, {"name": EXPERT_NAMES.get(i, ""), "category": "",
                    "expertType": "team" if team_only else "agent", "version": ""}) for i in ids]
    return out


def _fetch_skills(auth):
    """POST market/skill/list -> [(skill_id, name)]（只读）。"""
    out = []
    try:
        st, r = tc.do_post(auth, tc.chat_base(auth),
                           "/v2/operation-platform/market/skill/list",
                           {"page": 1, "page_size": 8})
        if st == 200:
            for s in (r.get("data") or {}).get("skills") or []:
                if s.get("skill_id"):
                    out.append((s["skill_id"], s.get("name") or ""))
    except Exception as ex:
        print(f"  [warn] 技能市场拉取失败({ex})，回落内置表")
    if not out:
        out = DEFAULT_SKILL_IDS
    return out


def _fetch_playbook_cases():
    """只读拉灵感案例注册表 -> [(case_id, meta)]。失败回落内置表。"""
    out = []
    try:
        req = urllib.request.Request(f"{PLAYBOOK_BASE}/registry.json",
                                     headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        for c in (data.get("cases") or []):
            if c.get("id"):
                out.append((c["id"], {"title": c.get("title") or "",
                                      "artifact_type": c.get("artifact_type") or "other",
                                      "categories": c.get("categories") or [],
                                      "skills": c.get("skills") or [],
                                      "experts": c.get("experts") or [],
                                      "prompt": c.get("prompt") or "",
                                      "source": "discover"}))
    except Exception as ex:
        print(f"  [warn] 案例注册表拉取失败({ex})，回落内置表")
    if not out:
        out = DEFAULT_CASES
    return out


def _fetch_lighthouse(auth):
    """市场关键词过滤轻量云专家 -> [(ex_id, meta)]。"""
    out = []
    for kw in LIGHTHOUSE_KEYWORDS:
        for eid, meta in _fetch_market_experts(auth, keyword=kw):
            blob = (eid + meta.get("name", "") + meta.get("agent_name", "")).lower()
            if any(k in blob for k in ["lighthouse", "轻量", "light", "yun"]):
                out.append((eid, meta))
    if not out:
        out = LIGHTHOUSE_IDS
    return out


def _fetch_pe_theme(auth):
    """appearance/resources 目录过滤和平精英 -> [(resource_key, meta)]。"""
    out = []
    try:
        st, r = tc.do_post(auth, tc.billing_base(auth),
                           "/v2/operation-platform/appearance/resources",
                           {"platform": "client", "kind": "theme",
                            "version": tc.CLIENT_UA.split("/")[-1], "lang": "zh-CN"})
        if st == 200:
            for x in (r.get("data") or {}).get("resources") or []:
                nm = x.get("name") or ""
                if "和平精英" in nm or "pubg" in nm.lower():
                    out.append((x.get("id") or "", {"name": nm,
                                "vipLevel": x.get("vip_level", ""),
                                "series": x.get("series", ""),
                                "appearance": x.get("appearance", "")}))
    except Exception as ex:
        print(f"  [warn] 主题目录拉取失败({ex})，回落内置表")
    if not out:
        out = [PE_THEME]
    return out


def _dedup_slice(src, offset, need):
    """src: [(id, meta)]；去重后按 offset 偏移取 need 个。"""
    seen, final = set(), []
    for i, m in src:
        if i not in seen:
            seen.add(i)
            final.append((i, m))
    return final[offset:offset + need]


def ids_for(kind, auth, need, offset=0):
    """返回需要上报的对象 id 列表 [(obj_id, meta)]（按源顺序，偏移 cur 避免复用）。"""
    if need <= 0:
        return []
    if kind == "canvas":
        base = int(time.time() * 1000)
        return [(f"wbx-canvas-{base + i}", {}) for i in range(need)]
    if kind == "template":
        return _dedup_slice(_fetch_scenes(auth), offset, need)
    if kind == "expert":
        return _dedup_slice(_fetch_market_experts(auth), offset, need)
    if kind == "team":
        return _dedup_slice(_fetch_market_experts(auth, team_only=True), offset, need)
    if kind == "skill":
        return _dedup_slice(_fetch_skills(auth), offset, need)
    if kind == "playbook":
        return _dedup_slice(_fetch_playbook_cases(), offset, need)
    if kind == "lighthouse":
        return _dedup_slice(_fetch_lighthouse(auth), offset, need)
    if kind == "skin":
        return _dedup_slice(_fetch_pe_theme(auth), offset, need)
    if kind in ("chat", "glmchat", "automation", "cat"):
        return [("", {}) for _ in range(need)]
    if kind == "richmeow":
        return [("", {}) for _ in range(need)]
    if kind in ("buddy5", "library", "minichat", "schoolseason"):
        # history/current 不是顺序语义：buddy5/library/minichat/schoolseason 是固定事件组
        # 按需补 1 次（offset 无意义）
        return [("", {}) for _ in range(need)]
    return []


# --------------------------------------------------------------------------
# 桌面指纹事件链（fork desktop.go 吸收：agent_task_created→chat_message_response→…
# 6 连事件组 + 五连 buddyapp 事件组；ReportDesktopEvent 注入桌面指纹到每个事件）
# --------------------------------------------------------------------------
def desktop_chat_sequence(auth, conversation_id, request_id, message_id,
                          model_id="fast-model", model_name="fast-model"):
    """fork DesktopChatSequence 同款 6 连「桌面端成功对话」事件链（点亮 RichMeow_Chat）。"""
    now = int(time.time() * 1000)
    ev = []

    def mk(code, extra):
        e = {"eventCode": code}
        e.update(extra)
        ev.append(e)

    mk("agent_task_created", {
        "source": "LOCAL", "name": "working", "task_target": "local", "mode": "craft",
        "requestModelId": model_id, "requestModelName": model_name,
        "has_repo": False, "repo_type": "none", "workspace_type": "empty",
        "has_connector": False, "connector_types": [],
        "has_mention": False, "mention_types": [],
        "has_template": False, "action": "", "template_name": "",
        "has_expert": False, "expert_id": "", "expert_name": "", "expert_industry_id": "",
        "has_skill": False, "skill_names": [],
        "conversationId": conversation_id, "messageId": message_id,
        "buddyId": "", "buddyName": "",
    })
    mk("chat_message_send", {
        "messageId": message_id + "-assistant", "historyCount": 0,
        "isContextTruncated": False, "currentStepCount": 1,
        "traceId": request_id, "rootRequestId": request_id,
        "parentConversationId": conversation_id,
        "agentName": "cli", "agentType": "main",
    })
    mk("chat_request_send", {
        "inputLength": 24, "isPlan": False, "isAutoExecuteTerminal": False,
        "isAutoModify": False, "codebaseEnable": False, "maxToken": 0,
        "maxSteps": 500, "temperature": 0, "maxRetries": 0,
        "mentionContexts": [], "knowledgeId": [], "knowledgeName": [],
        "codebaseId": "", "mentionContextCount": 0, "command": "",
        "recommendId": "", "skillId": "", "skillCount": 0, "totalCount": 0,
        "traceId": request_id, "rootRequestId": request_id,
        "parentConversationId": conversation_id,
        "agentName": "cli", "agentType": "main",
        "codebuddy.session_id":              conversation_id,
        "codebuddy.conversation_request_id": request_id,
    })
    mk("chat_message_response", {
        "messageId": message_id + "-assistant", "responseModelId": model_id,
        "inputToken": 120, "outputToken": 80, "totalToken": 200,
        "cachedTokens": 0, "cachedWriteTokens": 0, "cachedMissTokens": 0,
        "isSuccessful": True, "messageErrorCode": "", "finishReason": "stop",
        "firstTokenAt": now, "traceId": request_id,
        "conversationId": conversation_id,
        "rootRequestId": request_id, "parentConversationId": conversation_id,
        "agentName": "cli", "agentType": "main",
        "codebuddy.session_id":              conversation_id,
        "codebuddy.conversation_request_id": request_id,
    })
    mk("chat_message_status", {
        "messageId": message_id + "-assistant", "messageErrorCode": "0",
        "traceId": request_id, "rootRequestId": request_id,
        "parentConversationId": conversation_id,
        "agentName": "cli", "agentType": "main",
    })
    mk("chat_request_response", {
        "mode": "craft", "toolCallCount": 0,
        "inputToken": 120, "outputToken": 80, "totalToken": 200,
        "cachedTokens": 0, "cachedWriteTokens": 0, "cachedMissTokens": 0,
        "isSuccessful": True, "messageErrorCode": "", "finishReason": "stop",
        "rootRequestId": request_id, "parentConversationId": conversation_id,
    })
    return ev


def desktop_buddy5_sequence(auth, buddy_id, buddy_name):
    """fork DesktopBuddyAppSequence 同款五连「进入 Buddy 应用」事件（点亮 Buddy_App/_QQ）。

    discover → show → enter_click → auth_confirm_click → bindaccount_skip_click，
    一次上报即点亮；服务端不校验真实授权（fork 两账号实测）。
    """
    ev = []

    def mk(code, extra):
        e = {"eventCode": code, "mode": "LOCAL",
             "buddyId": buddy_id, "buddyName": buddy_name}
        e.update(extra)
        ev.append(e)

    mk("buddyapp_discover_click", {})
    mk("buddyapp_show", {"elementId": buddy_id, "elementName": buddy_name, "position": 2})
    mk("buddyapp_enter_click",
       {"elementId": buddy_id, "elementName": buddy_name, "position": 2, "isFirstPage": "1"})
    mk("buddyapp_auth_confirm_click", {"elementId": buddy_id, "elementName": buddy_name})
    mk("buddyapp_bindaccount_skip_click", {"elementId": buddy_id, "elementName": buddy_name})
    return ev


# --------------------------------------------------------------------------
# 上报通道（fork ReportDesktopEvent / ReportWebEvent 同款）
# --------------------------------------------------------------------------
def report_desktop_events(auth, events):
    """以桌面指纹向 {chat}/v2/report 批量上报；返回业务信封 (st, code)。

    fork ReportDesktopEvent：每个事件（列表）注入 desktopFingerprint 公共字段覆盖同名键。
    """
    fp = desktop_fingerprint(auth)
    arr = []
    for e in events:
        m = dict(e)
        m.update(fp)
        arr.append(m)
    st, r = tc.do_post(auth, tc.chat_base(auth), tc.PATH_REPORT, arr,
                       headers=_desktop_headers(auth))
    sc = r.get("code") if isinstance(r, dict) else r
    return st, sc


def _mp_headers(auth, extra=None):
    """小程序域请求头（源 school 模块 _build_headers 同款：Bearer + MP UA + 可选覆盖）。

    与 task_common._headers 的差异：UA 换微信小程序 UA（web/desktop 头不同源，勿混用）。
    """
    h = {
        "Authorization": "Bearer " + auth["token"],
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": MP_UA,
    }
    if extra:
        h.update(extra)
    return h


def report_mp_events(auth, events):
    """以小程序指纹向 {billing}=www.codebuddy.cn/v2/report 上报事件数组。

    返回业务信封 (st, code)。源实现走 school.report_events（同 codebuddy.cn 域 +
    MP UA 头）；目标仓无 school 段，故此处自带小程序头，不复用 web/desktop 通道。
    """
    st, r = tc.do_post(auth, tc.billing_base(auth), tc.PATH_REPORT, events,
                       headers=_mp_headers(auth))
    sc = r.get("code") if isinstance(r, dict) else r
    return st, sc


def report_web_event(auth, event_code, page_url, element_id, element_name):
    """以 web 域指纹向 https://www.workbuddy.cn/v2/report 上报单事件（Library_read）。

    fork ReportWebEvent：浏览器形状（os/machineId/userAgent），带 x-client-platform: web。
    """
    now = int(time.time() * 1000)
    ev = {
        "eventCode": event_code, "timestamp": now, "reportDelay": 0,
        "pageURL": page_url, "elementId": element_id, "elementName": element_name,
        "os": "Win32", "arch": "", "osVersion": "10.0", "userAgent": WEB_UA,
        "machineId": derive_id(auth, "webmachine"), "userId": auth["uid"],
        "userNickname": auth.get("nick", ""),
    }
    st, r = tc.do_post(auth, WEB_BASE, tc.PATH_REPORT, [ev],
                       headers=_web_event_headers(auth, page_url))
    sc = r.get("code") if isinstance(r, dict) else r
    return st, sc


# --------------------------------------------------------------------------
# 事件构建器（照抄各 task_*.py 已验证形状，必带 userId）
# --------------------------------------------------------------------------
def build_event(auth, kind, obj_id, meta, idx):
    now = int(time.time() * 1000)
    cid = f"wb-run-{now}-{idx}"
    rid = f"{cid}-{now}"
    uid = auth["uid"]
    # meta 可能是 dict（丰富元数据）或 str（如技能名）；统一成 dict 供 m.get 使用
    if isinstance(meta, str):
        m = {"name": meta}
    elif isinstance(meta, dict):
        m = meta
    else:
        m = {}

    if kind == "canvas":
        return {"eventCode": "wbx_design_canvas_task_create", "timestamp": now,
                "reportDelay": 0, "conversationId": cid, "requestId": rid,
                "source": "summon_keyword", "isCustomModel": False, "name": "",
                "inputLength": 12, "id": obj_id or f"wbx-canvas-{now}",
                "cost": 0, "isSuccessful": True, "userId": uid}

    if kind == "template":
        return {"eventCode": "agent_task_created_with_template", "timestamp": now,
                "reportDelay": 0, "isCustomModel": True, "id": str(obj_id),
                "name": m or "", "requestId": rid, "conversationId": cid, "userId": uid}

    if kind == "expert":
        return {"eventCode": "expert_actual_use", "timestamp": now, "reportDelay": 0,
                "mode": "CLOUD", "id": obj_id, "name": m.get("name") or obj_id,
                "expertTitle": m.get("name") or "", "type": m.get("category") or "",
                "expertType": m.get("expertType") or "agent", "source": "builtin",
                "version": m.get("version") or "", "cost": 0, "characterCount": 12,
                "conversationId": cid, "requestId": rid, "messageId": rid,
                "requestModelId": "deepseek-v4-flash", "requestModelName": "DeepSeek V4 Flash",
                "userId": uid}

    if kind == "team":
        return {"eventCode": "expert_actual_use", "timestamp": now, "reportDelay": 0,
                "mode": "CLOUD", "id": obj_id, "name": m.get("name") or obj_id,
                "expertTitle": m.get("name") or "", "type": m.get("category") or "",
                "expertType": "team", "source": "builtin", "version": m.get("version") or "",
                "cost": 0, "characterCount": 12, "conversationId": cid, "requestId": rid,
                "messageId": rid, "requestModelId": "deepseek-v4-flash",
                "requestModelName": "DeepSeek V4 Flash", "userId": uid}

    if kind == "skill":
        sname = meta if isinstance(meta, str) else (meta.get("name") if isinstance(meta, dict) else "")
        return {"eventCode": "skill_info", "timestamp": now, "reportDelay": 0,
                "skillId": obj_id, "skillName": sname or obj_id,
                "skillVersion": "", "action": "use", "conversationId": cid,
                "requestId": rid, "userId": uid}

    if kind == "automation":
        return {"eventCode": "automated_task_create_suc", "timestamp": now,
                "reportDelay": 0, "name": "每周五自动生成周报", "source": "manually",
                "modelId": "deepseek-v4-flash", "modelIsThinking": False,
                "expertId": "", "expertMarketplace": "", "connectorIds": "",
                "connectorCount": 0, "skills": "", "skillCount": 0,
                "scheduleType": "recurring", "pushToWeChat": False, "pushToWecomBot": False,
                "conversationId": cid, "requestId": rid,
                "schedule": {"type": "recurring", "rrule": "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0"},
                "prompt": "每周五自动整理本周工作，生成一份周报。", "userId": uid}

    if kind == "playbook":
        skills = m.get("skills") or []
        experts = m.get("experts") or []
        cat_id = (m.get("categories") or [""])[0] or ""
        return {"eventCode": "playbook_prompt_send", "timestamp": now, "reportDelay": 0,
                "id": obj_id, "name": m.get("title") or obj_id,
                "type": m.get("artifact_type") or "other",
                "promptLength": len(m.get("prompt") or ""), "isOfficial": 1,
                "skills": ",".join(s.get("skill_id", "") for s in skills if s.get("skill_id")),
                "skillNames": ",".join(s.get("name", "") for s in skills if s.get("name")),
                "expertId": (experts[0].get("expert_id") or experts[0].get("id")) if experts else "",
                "expertName": (experts[0].get("name") or "") if experts else "",
                "categoryId": cat_id, "categoryName": "", "query": "",
                "source": "discover", "conversationId": cid, "requestId": rid,
                "ext1": "discover", "userId": uid}

    if kind == "lighthouse":
        return {"eventCode": "expert_actual_use", "timestamp": now, "reportDelay": 0,
                "mode": "CLOUD", "id": obj_id, "name": m.get("name") or obj_id,
                "expertTitle": m.get("name") or "", "type": m.get("category") or "",
                "expertType": m.get("expertType") or "agent", "source": "builtin",
                "version": m.get("version") or "", "cost": 0, "characterCount": 12,
                "conversationId": cid, "requestId": rid, "messageId": rid,
                "requestModelId": "deepseek-v4-flash", "requestModelName": "DeepSeek V4 Flash",
                "userId": uid}

    if kind == "skin":
        return {"eventCode": "appearance_skin_apply", "timestamp": now, "reportDelay": 0,
                "action": "apply", "source": "settings_close", "id": obj_id,
                "vipLevel": m.get("vipLevel") or "free", "series": m.get("series") or "craft",
                "type": "unknown", "name": m.get("name") or obj_id, "userId": uid}

    if kind in ("chat", "glmchat", "cat"):
        model_id = "glm-5.2" if kind in ("glmchat", "cat") else "deepseek-v4-flash"
        model_name = "GLM-5.2" if kind in ("glmchat", "cat") else "DeepSeek V4 Flash"
        mode = "night" if kind == "cat" else "craft"
        return {"eventCode": "chat_request_send", "timestamp": now, "reportDelay": 0,
                "mode": mode, "conversationId": cid, "requestId": cid,
                "inputLength": 12, "requestModelId": model_id, "requestModelName": model_name,
                "isPlan": False, "isAutoExecuteTerminal": False, "isAutoModify": False,
                "codebaseEnable": False, "maxToken": 0, "maxSteps": 0, "temperature": 0,
                "maxRetries": 0, "mentionContexts": [], "knowledgeId": [],
                "knowledgeName": [], "codebaseId": "", "mentionContextCount": 0,
                "command": "", "expertId": "", "recommendId": "", "skillId": "",
                "skillCount": 0, "totalCount": 0, "fileUri": "", "presentAt": now,
                "traceId": "", "rootRequestId": cid, "parentConversationId": cid,
                "agentName": "default", "agentType": "conversation", "userId": uid}

    if kind == "minichat":
        # 小程序成长任务（Sequential_Tasks_1）判据：mini 指纹 chat_request_send，
        # 无 activityId（growth 域按 source=mini_program 指纹关联，源提交 8622910 实测
        # 0ceb9c7c 点亮）。形状对齐 school.mini_chat_event，仅去掉 activityId、
        # extVersion 由 SaaS 修正为 2.4.0（mp 口径实际版本）。
        return {"eventCode": "chat_request_send", "timestamp": now, "reportDelay": 0,
                "source": "mini_program", "ideName": "wx_app_cloud",
                "ideType": "WorkBuddy_MP", "extName": "workbuddy-mp",
                "extVersion": "2.4.0", "mode": "chat",
                "conversationId": cid, "requestId": cid, "inputLength": 12,
                "mentionContexts": [], "mentionContextCount": 0, "userId": uid}

    if kind == "schoolseason":
        # growth 域 school_season（校园日）判据：mini 指纹 chat_request_send +
        # activityId=school_open_day_2026（与 school 域开学季同 activityId 关联，
        # 源实测 0ceb9c7c 点亮；**无 activityId 的事件不点亮**）。
        # 复用 school 模块构造器保证字段与 school 段单一事实源（勿在此手抄第二份形状，
        # 移植 e45f39f 的「复用不复制」口径）。
        return school.mini_chat_event(auth, cid)

    raise ValueError(f"unknown kind: {kind}")


# --------------------------------------------------------------------------
# 领奖（M15 真实端点：POST {chat}/activity/growth/tasks/{code}/claim，无 body）
# 400 自动降级 web 域：POST https://www.workbuddy.cn/activity/growth/tasks/{code}/claim，
# 带 Origin/Referer/x-client-platform: web（fork ClaimReward 同款，web_claim_fallback）。
# --------------------------------------------------------------------------
def _claim_parse(auth, code, uid8, stats, gap, st, r, via_web=False):
    """解析 claim 响应信封；业务判定成功/已领/失败。via_web 仅用于日志标注。"""
    tag = " web" if via_web else ""
    if st != 200 or not isinstance(r, dict) or r.get("code") != 0:
        msg = r.get("msg") if isinstance(r, dict) else r
        print(f"[task_runner] {uid8} {code}: claim{tag} {st} {msg} -> ERR")
        stats["fail"] += 1
        return 0
    data = r.get("data") or {}
    credit = data.get("credit") or 0
    energy = data.get("energy") or 0
    if data.get("already_claimed"):
        print(f"[task_runner] {uid8} {code}: claim{tag} 200 already_claimed(credit=+{credit} energy=+{energy})")
        stats["already"] += 1
        time.sleep(gap)
        return 2
    print(f"[task_runner] {uid8} {code}: claim{tag} 200 ok(credit=+{credit} energy=+{energy})")
    stats["ok"] += 1
    stats["credit"] += credit
    stats["energy"] += energy
    time.sleep(gap)
    return 1


def _claim_via_web(auth, code, uid8, stats, gap):
    """web 域领奖（fork ClaimReward 同款头：Origin/Referer/x-client-platform: web）。"""
    st, r = tc.do_post(auth, WEB_BASE,
                       f"/activity/growth/tasks/{code}/claim", None,
                       headers=_web_claim_headers(auth))
    return _claim_parse(auth, code, uid8, stats, gap, st, r, via_web=True)


def claim_one(auth, code, uid8, stats, gap, mp=False):
    """领单个任务。返回 1=新入账 2=already_claimed 0=失败。

    chat 域（M15 实测成功）先行；400 则自动降级 web 域带完整头（web_claim_fallback）。
    幂等语义保持：already_claimed 不算失败（返回 2）。
    mp=True 时带 X-Client-Platform: miniprogram（小程序限定任务 claim 必需；缺头
    源提交 8622910 实测 accept 即 task not found，claim 同一口径）。
    """
    st, r = tc.do_post(auth, tc.chat_base(auth),
                       f"/activity/growth/tasks/{code}/claim", None,
                       headers=MP_PLATFORM_HEADER if mp else None)
    if st != 200 or not isinstance(r, dict) or r.get("code") != 0:
        msg = r.get("msg") if isinstance(r, dict) else r
        # 400 降级到 web 域（fork 实测 Web 成长中心端点）：chat 域路径对部分任务 400
        if st == 400:
            print(f"[task_runner] {uid8} {code}: claim 400 {msg} -> 降级 web 域")
            return _claim_via_web(auth, code, uid8, stats, gap)
        print(f"[task_runner] {uid8} {code}: claim {st} {msg} -> ERR")
        stats["fail"] += 1
        return 0
    return _claim_parse(auth, code, uid8, stats, gap, st, r)


# --------------------------------------------------------------------------
# 小程序成长任务（growth 域小程序限定，Sequential_Tasks_1）
# 源提交 8622910：accept → mini 指纹对话点亮 → claim，全程 X-Client-Platform: miniprogram。
# 该任务在默认（无 mp 头）列表里不下发，故专段处理，不进 process_task 主循环。
# --------------------------------------------------------------------------
def _mp_list_tasks(auth):
    """带 X-Client-Platform: miniprogram 拉任务列表（小程序限定任务仅在该口径下发）。"""
    st, r = tc.do_get(auth, tc.chat_base(auth), tc.PATH_LIST_TASKS,
                      headers=MP_PLATFORM_HEADER)
    if st != 200 or not isinstance(r, dict):
        raise RuntimeError(f"mp list_tasks http={st}")
    return (r.get("data") or {}).get("tasks") or []


def _mp_task_status(auth, code):
    """mp 口径查单任务；无此任务返回 None。"""
    return next((t for t in _mp_list_tasks(auth) if t.get("task_code") == code), None)


def process_minichat_task(auth, code, opts, stats):
    """小程序成长任务：mp 口径查询 → accept → mini 对话上报 → 回读 → claim。

    与 process_task 的 growth 主循环分开处理：该任务在默认（无 mp 头）列表里不存在，
    accept/claim 也要求同一头。实测结论（源提交 8622910）：缺 X-Client-Platform 头时
    accept 返回 task not found。

    同一 mp 下发口径覆盖两个 code（移植 e45f39f 的 spec 化分派）：
      Sequential_Tasks_1  判据 kind=minichat（无 activityId）
      school_season       判据 kind=schoolseason（mini chat + activityId）
    两者仅上报事件形状不同，链路（accept/claim/回读）完全一致。spec 由 MAPPING 提供，
    未映射的 mp 任务保守跳过（kind 缺省回落 minichat，保持旧行为）。
    """
    spec = MAPPING.get(code) or {}
    kind = spec.get("kind") or "minichat"
    uid8 = auth["uid"][:8]
    try:
        t = _mp_task_status(auth, code)
    except Exception as e:
        print(f"[task_runner] {uid8} {code}: mp list_tasks 失败: {e}")
        stats["fail"] += 1
        return
    if t is None:
        print(f"[task_runner] {uid8} {code}: mp 口径任务不存在，skip")
        stats["skip"] += 1
        return

    ast = t.get("accept_status")
    prog = t.get("progress") or {}
    cur = prog.get("current") or 0
    target = prog.get("target") or 1
    stats["total"] += 1

    if ast == "claimed":
        print(f"[task_runner] {uid8} {code}: query claimed({cur}/{target}) -> 已领，跳过")
        stats["already"] += 1
        return
    if ast == "completed" or cur >= target:
        if not opts.yes:
            print(f"[task_runner] {uid8} {code}: query completed({cur}/{target}) -> 可领(claim)，dry-run 跳过")
            stats["pending"] += 1
            return
        claim_one(auth, code, uid8, stats, opts.gap, mp=True)
        return

    if not opts.yes:
        print(f"[task_runner] {uid8} {code}: query {ast}({cur}/{target}) -> "
              f"可点亮({kind})，dry-run 跳过")
        stats["pending"] += 1
        return

    # 1) accept（mp 头；缺头实测 task not found，见源提交 8622910）
    #    移植 c793ae3：走同一 _accept_with_verify（读 results[].status + 回读 accept_status
    #    双重确认 + 重试一次）。mp 段此前只判 st/res，同样漏掉「200+未登记」形态。
    if ast == "not_accepted":
        if not _accept_with_verify(auth, code, uid8, opts.gap, mp=True):
            print(f"[task_runner] {uid8} {code}: accept 未登记生效，本轮跳过待下次")
            stats["fail"] += 1
            return

    # 2) 判据上报：mini 指纹 chat_request_send（minichat 无 activityId /
    #    schoolseason 带 activityId=school_open_day_2026），走 codebuddy.cn 域
    #    （本仓 report_mp_events 与源 school.report_events 同域同头）
    need = max(1, target - cur)
    for i in range(need):
        ev = build_event(auth, kind, "", {}, i)
        st, sc = report_mp_events(auth, [ev])
        print(f"[task_runner] {uid8} {code}: report {i + 1}/{need} {st} code={sc} (mini growth)")
        time.sleep(opts.gap)

    time.sleep(2.0)  # 服务端归账留时

    # 3) 回读 + claim（mp 头）
    t2 = _mp_task_status(auth, code) or t
    ast2 = t2.get("accept_status")
    prog2 = t2.get("progress") or {}
    cur2 = prog2.get("current", 0)
    print(f"[task_runner] {uid8} {code}: query re-read {cur2}/{prog2.get('target', target)} "
          f"accept_status={ast2}")
    if ast2 == "claimed":
        print(f"[task_runner] {uid8} {code}: {ast} -> claimed（本轮已入账）")
        stats["already"] += 1
        return
    if ast2 == "completed" or cur2 >= prog2.get("target", target):
        claim_one(auth, code, uid8, stats, opts.gap, mp=True)
        return
    print(f"[task_runner] {uid8} {code}: report 未达 target"
          f"（{cur2}/{prog2.get('target', target)}），WARN 待下次")
    stats["pending"] += 1


# --------------------------------------------------------------------------
# 单任务处理
# --------------------------------------------------------------------------
def process_task(auth, code, t, opts, stats):
    uid8 = auth["uid"][:8]
    spec = MAPPING.get(code)
    if spec is None:
        print(f"[task_runner] {uid8} {code}: query 非映射任务，skip")
        stats["total"] += 1
        stats["skip"] += 1
        return
    ast = t.get("accept_status")
    prog = t.get("progress") or {}
    cur = prog.get("current") or 0
    target = prog.get("target") or spec.get("target") or 1
    stats["total"] += 1

    # 不可伪造任务：跳过并如实标注
    if spec.get("unforgeable"):
        print(f"[task_runner] {uid8} {code}: query {ast}({cur}/{target}) -> 不可伪造({spec['reason']})，skip")
        stats["skip"] += 1
        return

    # 只领奖 模式：对已满足/已领任务执行 claim（已领->already_claimed 幂等），
    # 未满足任务跳过（服务端对未完成任务返回 task not completed，不强行）。
    if opts.only_claim:
        if ast != "claimed" and (cur < target and ast != "completed"):
            print(f"[task_runner] {uid8} {code}: query {ast}({cur}/{target}) -> 未 completed，only_claim 跳过")
            stats["pending"] += 1
            return
        if not opts.yes:
            print(f"[task_runner] {uid8} {code}: query {ast}({cur}/{target}) -> only_claim dry-run 跳过")
            stats["pending"] += 1
            return
        claim_one(auth, code, uid8, stats, opts.gap)
        return

    # 已领：跳过（除 only_claim 外不重复领）
    if ast == "claimed":
        print(f"[task_runner] {uid8} {code}: query claimed({cur}/{target}) -> 已领，跳过")
        stats["already"] += 1
        return

    claimed_or_done = (cur >= target or ast == "completed")

    # 已满足：走 claim
    if claimed_or_done:
        if not opts.yes:
            print(f"[task_runner] {uid8} {code}: query completed({cur}/{target}) -> 可领(claim)，dry-run 跳过")
            stats["pending"] += 1
            return
        claim_one(auth, code, uid8, stats, opts.gap)
        return

    # black_cat 特殊：时段敏感
    if code == "black_cat":
        in_window = within_night_window()
        if not in_window:
            print(f"[task_runner] {uid8} {code}: query in_progress({cur}/{target}) -> 非夜猫窗口(23-08 CST)，skip pending")
            stats["pending"] += 1
            return
        if not opts.yes:
            print(f"[task_runner] {uid8} {code}: query in_progress({cur}/{target}) -> 夜猫窗口内，可补 1 次，dry-run 跳过")
            stats["pending"] += 1
            return
        light_up(auth, code, spec, cur, target, uid8, opts, stats, cap=1)
        return

    # 可点亮：计算需要上报次数（按 target 补齐）
    need = max(0, target - cur)
    if need <= 0:
        if not opts.yes:
            print(f"[task_runner] {uid8} {code}: query {ast}({cur}/{target}) -> 可领(claim)，dry-run 跳过")
            stats["already"] += 1
            return
        claim_one(auth, code, uid8, stats, opts.gap)
        return

    if not opts.yes:
        ids = ids_for(spec["kind"], auth, need, offset=cur)
        shown = [i for i, _ in ids][:6]
        print(f"[task_runner] {uid8} {code}: query {ast}({cur}/{target}) -> 可点亮 need={need} "
              f"id源={spec['src']} ids={shown}，dry-run 跳过")
        stats["pending"] += 1
        return

    light_up(auth, code, spec, cur, target, uid8, opts, stats)


def _accept_with_verify(auth, code, uid8, gap, mp=False):
    """accept 并验证登记生效（移植 workbuddy2api c793ae3）。

    上游存在 **HTTP 200 + msg=OK 但 results[].status 非 accepted / 服务端未落账** 的
    形态（源实测 4f96ce49）：此时后续上报事件全部不归账——not_accepted 态上报
    progress 纹丝不动，accept 真正生效后同样事件立即 +1。这正是「13 个任务上报成功
    却永远点不亮」的根因；旧日志只打 msg，把失败掩盖成成功。

    返回 True=accept 已生效（本轮或此前）；False=重试后仍未生效。
    判定以**回读 accept_status** 为准（响应 status 只是初筛），失败重试一次。

    mp=True 时带 X-Client-Platform: miniprogram（本仓适配：mp 限定任务缺该头 accept
    返回 task not found，见源提交 8622910；源实现此 helper 未覆盖 mp 段，本仓把它
    参数化以便同一判据同时服务 growth 段与 mp 段）。
    """
    hdr = MP_PLATFORM_HEADER if mp else None
    for attempt in (1, 2):
        if mp:
            st, r = tc.do_post(auth, tc.chat_base(auth), tc.PATH_ACCEPT_TASKS,
                               {"task_codes": [code]}, headers=hdr)
        else:
            st, r = tc.accept_tasks(auth, [code])
        status = ""
        if isinstance(r, dict):
            results = ((r.get("data") or {}).get("results") or [])
            status = (results[0].get("status") or "") if results else (r.get("msg") or "")
        else:
            status = str(r)
        # 回读确认登记生效（响应可能说 accepted 但服务端未落账）
        if mp:
            t = _mp_task_status(auth, code) or {}
        else:
            t = tc.task_status(auth, code) or {}
        ast = t.get("accept_status") or "not_accepted"
        ok = (st == 200 and status == "accepted" and ast != "not_accepted")
        print(f"[task_runner] {uid8} {code}: accept 尝试{attempt} {st} status={status} "
              f"回读={ast}{' -> 生效' if ok else ''}")
        if ok:
            return True
        time.sleep(gap)
    return False


def light_up(auth, code, spec, cur, target, uid8, opts, stats, cap=0):
    """accept(若未接，带登记验证与重试) → 按 target 补齐上报 → 回读 → 已满则 claim。"""
    ast = tc.task_status(auth, code)
    ast = ast.get("accept_status") if ast else "not_accepted"
    if ast == "not_accepted":
        # 移植 c793ae3：accept 成功判定必须含登记验证，否则 200+未登记时上报全不归账
        if not _accept_with_verify(auth, code, uid8, opts.gap):
            print(f"[task_runner] {uid8} {code}: accept 未登记生效，本轮跳过待下次")
            stats["fail"] += 1
            return

    t_now = tc.task_status(auth, code) or {}
    prog = t_now.get("progress") or {}
    cur = prog.get("current") or cur
    tgt = prog.get("target") or target
    need = max(0, tgt - cur)
    if cap > 0:
        need = min(need, cap)
    if need <= 0:
        print(f"[task_runner] {uid8} {code}: report 无需上报（{cur}/{tgt}）")
    elif spec["kind"] == "richmeow":
        # 桌面指纹 6 连对话事件链（fork DesktopChatSequence），单组即一次完整对话
        for i in range(need):
            ms = int(time.time() * 1000)
            conv = f"wb-run-rm-{ms}-{i}"
            req = f"wb-run-rm-req-{ms}-{i}"
            msg = f"req-{ms}-{i}-user"
            events = desktop_chat_sequence(auth, conv, req, msg, "fast-model", "fast-model")
            st_r, sc = report_desktop_events(auth, events)
            print(f"[task_runner] {uid8} {code}: report {i + 1}/{need} {st_r} code={sc} "
                  f"deskchain conv={conv}")
            if i < need - 1:
                time.sleep(opts.gap)
        time.sleep(2.0)  # 服务端归账可能异步
    elif spec["kind"] == "buddy5":
        # 五连「进入 Buddy 应用」事件（fork DesktopBuddyAppSequence，两账号实测点亮）；
        # 上报失败（非 200 / code!=0）降级为单发 buddyapp_enter_click（旧形状兜底）。
        buddy_id, buddy_name = BUDDY_APPS.get(code, ("", "Buddy"))
        for i in range(need):
            events = desktop_buddy5_sequence(auth, buddy_id, buddy_name)
            st_r, sc = report_desktop_events(auth, events)
            if st_r != 200 or sc != 0:
                now = int(time.time() * 1000)
                single = {"eventCode": "buddyapp_enter_click", "timestamp": now,
                          "reportDelay": 0, "elementId": buddy_id,
                          "elementName": buddy_name, "position": 1,
                          "isFirstPage": "0", "userId": auth["uid"]}
                st2, sc2 = report_desktop_events(auth, [single])
                print(f"[task_runner] {uid8} {code}: report {i + 1}/{need} {st_r} code={sc} "
                      f"buddy5 失败 -> 降级单发 {st2} code={sc2}")
            else:
                print(f"[task_runner] {uid8} {code}: report {i + 1}/{need} {st_r} code={sc} "
                      f"buddy5 id={buddy_id}")
            if i < need - 1:
                time.sleep(opts.gap)
        time.sleep(2.0)  # 服务端归账可能异步
    elif spec["kind"] == "library":
        # web 域 web_element_click（fork ReportWebEvent），base 为 www.workbuddy.cn
        for i in range(need):
            st_r, sc = report_web_event(auth, "web_element_click", LIBRARY_DOC_URL,
                                        "library_doc_intro_click", "WorkBuddy资料库介绍")
            print(f"[task_runner] {uid8} {code}: report {i + 1}/{need} {st_r} code={sc} "
                  f"web_element_click")
            if i < need - 1:
                time.sleep(opts.gap)
        time.sleep(2.0)  # 服务端归账可能异步
    else:
        ids = ids_for(spec["kind"], auth, need, offset=cur)
        if not ids:
            print(f"[task_runner] {uid8} {code}: report 无可用对象 id，skip")
            stats["fail"] += 1
            return
        for i, (obj_id, m) in enumerate(ids):
            ev = build_event(auth, spec["kind"], obj_id, m, i)
            st_r, r_r = tc.do_post(auth, tc.billing_base(auth), tc.PATH_REPORT, [ev])
            sc = r_r.get("code") if isinstance(r_r, dict) else r_r
            print(f"[task_runner] {uid8} {code}: report {i + 1}/{need} {st_r} code={sc} id={obj_id}")
            if i < len(ids) - 1:
                time.sleep(opts.gap)
        time.sleep(2.0)  # 服务端归账可能异步

    # 回读确认
    t2 = tc.task_status(auth, code)
    prog2 = (t2.get("progress") or {}) if t2 else {}
    cur2 = prog2.get("current", 0)
    ast2 = t2.get("accept_status") if t2 else "?"
    print(f"[task_runner] {uid8} {code}: query re-read {cur2}/{prog2.get('target', tgt)} accept_status={ast2}")
    if ast2 != "claimed" and cur2 >= prog2.get("target", tgt):
        claim_one(auth, code, uid8, stats, opts.gap)
    elif ast2 != "claimed":
        # 未点亮：如实标注，不强行刷
        print(f"[task_runner] {uid8} {code}: report 未达 target（{cur2}/{prog2.get('target', tgt)}），WARN 待下次")


# --------------------------------------------------------------------------
# 账号级流程
# --------------------------------------------------------------------------
def process_account(auth, opts, stats):
    uid8 = auth["uid"][:8]
    print(f"== {uid8} ({auth['nick']}) ==")
    # 只读 oracle：能量余额（上下文参考，dry-run/REAL 都显示）
    try:
        st_e, r_e = tc.do_get(auth, tc.chat_base(auth), PATH_ENERGY)
        if st_e == 200 and isinstance(r_e, dict) and r_e.get("code") == 0:
            bal = (r_e.get("data") or {}).get("balance", "?")
            print(f"[task_runner] {uid8} query energy balance={bal}")
    except Exception:
        pass
    try:
        tasks = tc.list_tasks(auth)
    except Exception as e:
        print(f"ERR: [task_runner] {uid8} query list_tasks 失败: {e}")
        stats["fail"] += 1
        return

    by_code = {t.get("task_code"): t for t in tasks}
    # minichat 段（小程序限定任务）：这些 code 在默认（无 mp 头）growth 任务列表里不下发，
    # 由 process_minichat_task 专段处理，不进 process_task（否则必然 query 任务不存在）。
    # 移植 e45f39f：schoolseason 与 minichat 同属 mp 下发口径，一并纳入本段。
    minichat_in_map = [c for c in MAPPING if MAPPING[c].get("kind") in ("minichat", "schoolseason")]
    if opts.only_codes:
        codes = [c for c in opts.only_codes if c not in minichat_in_map]
        process_minichat = bool(set(opts.only_codes) & set(minichat_in_map))
    else:
        # mp 下发口径的两个 code 都排除在 growth 主循环外（它们在默认列表里不存在，
        # 进了主循环必然 query 任务不存在）；由下面的 mp 专段处理。
        codes = [c for c in MAPPING if MAPPING[c].get("kind") not in ("minichat", "schoolseason")]
        process_minichat = True
        # 未在映射表但存在于任务列表的（如 first_buddy）——只计数展示
        for t in tasks:
            c = t.get("task_code")
            if c and c not in MAPPING:
                ast = t.get("accept_status")
                if ast == "claimed":
                    print(f"[task_runner] {uid8} {c}: query claimed -> 已领，跳过(非映射任务)")
                    stats["total"] += 1
                    stats["already"] += 1
                else:
                    print(f"[task_runner] {uid8} {c}: query {ast} -> 非映射任务，skip")
                    stats["total"] += 1
                    stats["skip"] += 1

    for code in codes:
        t = by_code.get(code)
        if t is None:
            print(f"[task_runner] {uid8} {code}: query 任务不存在")
            stats["total"] += 1
            stats["skip"] += 1
            continue
        process_task(auth, code, t, opts, stats)

    # 小程序成长任务段（mp 口径）：已完成/可领状态下 only_claim 模式仍可入账（claim 幂等）；
    # 未完成则点亮判据属写操作，只在非 only_claim 模式触发（与 process_task 的 only_claim 同规则）。
    if process_minichat:
        if opts.only_claim and not opts.yes:
            # only_claim + dry-run：无写操作，专段内部亦只做 dry-run 跳过（源提交 8622910 同）
            print(f"[task_runner] {uid8} mp 段: only_claim dry-run 跳过")
        else:
            # --only 语义（移植 e45f39f）：指定了 mp code 时只跑指定的（与 growth/school 段一致）；
            # 未指定则遍历全部 mp 下发口径 code（Sequential_Tasks_1 + school_season）。
            mp_codes = ([c for c in opts.only_codes if c in minichat_in_map]
                        if opts.only_codes else minichat_in_map)
            for mp_code in mp_codes:
                try:
                    t = _mp_task_status(auth, mp_code)
                    ast = (t or {}).get("accept_status")
                    if opts.only_claim and ast not in ("completed", "claimed"):
                        # only_claim 只入账已完成/已领任务；未完成不点亮
                        print(f"[task_runner] {uid8} {mp_code}: only_claim 跳过（未 completed）")
                        stats["total"] += 1
                        stats["pending"] += 1
                    else:
                        process_minichat_task(auth, mp_code, opts, stats)
                except Exception as e:
                    print(f"[task_runner] {uid8} {mp_code}: mp 查询失败: {e}")
                    stats["fail"] += 1


# --------------------------------------------------------------------------
# 汇总
# --------------------------------------------------------------------------
def print_summary(stats):
    print(f"task_runner done: accounts={stats['accounts']} total={stats['total']} "
          f"ok={stats['ok']} already={stats['already']} skipped={stats['skip']} "
          f"pending={stats['pending']} fail={stats['fail']} "
          f"credit=+{stats['credit']} energy=+{stats['energy']}")


def main():
    ap = argparse.ArgumentParser(description="成长任务一体机：查询→完成(点亮)→领取")
    ap.add_argument("accounts", nargs="+", help="uid 前缀（可多个）或 ALL")
    ap.add_argument("--yes", action="store_true", help="真实执行写操作（默认 dry-run）")
    ap.add_argument("--only", action="append", default=None, dest="only_codes",
                    help="只处理指定 task_code（可多次）")
    ap.add_argument("--only-claim", action="store_true",
                    help="只领奖不点亮（已完成任务直接 claim，已领幂等）")
    ap.add_argument("--gap", type=float, default=1.0, help="动作间隔秒数（默认 1.0）")
    a = ap.parse_args()

    if a.gap < 1.0:
        a.gap = 1.0  # 写操作间隔 ≥1s

    stats = {"accounts": 0, "total": 0, "ok": 0, "already": 0,
             "skip": 0, "pending": 0, "fail": 0, "credit": 0, "energy": 0}

    prefixes = []
    for acc in a.accounts:
        if acc.upper() == "ALL":
            pattern1 = os.path.join(tc.AUTHS, "workbuddy-*.json")
            pattern2 = os.path.join(tc.AUTHS, "*.json")
            files = sorted(glob.glob(pattern1)) or sorted(glob.glob(pattern2))
            for p in files:
                base = os.path.basename(p)
                if base.startswith("workbuddy-"):
                    prefixes.append(base[10:].replace(".json", ""))
                else:
                    prefixes.append(base.replace(".json", ""))
        else:
            prefixes.append(acc)
    # 去重保序
    seen, prefixes2 = set(), []
    for p in prefixes:
        if p not in seen:
            seen.add(p)
            prefixes2.append(p)

    mode = "REAL" if a.yes else "DRY-RUN"
    print(f"mode={mode} accounts={prefixes2} only={a.only_codes or 'all'} "
          f"only_claim={a.only_claim} gap={a.gap}")
    if a.yes and len(prefixes2) > 2 and not a.only_codes and not a.only_claim:
        print("WARN: 全量批量 + --yes 未限定 --only，注意 54 号批量——请确认 Hermes 决策后再跑")

    for p in prefixes2:
        try:
            c = tc.load_auth(p)
        except SystemExit as e:
            print(f"ERR: {e}")
            continue
        stats["accounts"] += 1
        process_account(c, a, stats)

    print_summary(stats)


if __name__ == "__main__":
    main()