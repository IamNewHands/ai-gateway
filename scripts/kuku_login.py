#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kuku.baidu.com (GenFlow Pro) 扫码/登录 + Cookie 导出 —— 本地桌面脚本。

为什么需要它：ai-gateway 后端的「后台扫码登录」由 Cloudflare Worker 调百度 passport，
百度对数据中心出口 IP 有风控（表现为超时吊起）。本脚本用【本机浏览器】登录，
住宅 IP 稳定，规避该风控——这与参考项目 kuku2api 采用 CloakBrowser 的思路一致。

用法：
  pip install playwright
  python -m playwright install chromium
  python scripts/kuku_login.py

跑起来会打开一个 Chromium 窗口访问 https://kuku.baidu.com/genflowpro，
在窗口里用百度账号扫码/登录即可；检测到 BDUSS 后自动落盘：
  scripts/kuku_cookies.json   ← 结构 { cookies:[{name,value,...}] }，与后端
                                 normalizeKukuCookie 兼容（整段 JSON 直接粘贴即可）
并在终端打印可直接粘贴的 Cookie 串。
拿到结果后粘到 ai-gateway 后台 Kuku 提供商的 Key 输入框即可。
"""
import os
import sys
import time
import json
import urllib.parse

from playwright.sync_api import sync_playwright

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROFILE_DIR = os.path.join(BASE_DIR, "kuku_profile")   # 独立 profile，不污染系统 Chrome
OUT_FILE = os.path.join(BASE_DIR, "kuku_cookies.json")
TARGET = "https://kuku.baidu.com/genflowpro"
TIMEOUT_SECONDS = 10 * 60


def _cookie_str(cookies: list) -> str:
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies if c.get("name") and c.get("value"))


def _kuku_logged_in(ctx, cookies: list) -> bool:
    """用浏览器上下文自己的请求打 kuku userreport（走真正的 Chrome 网络栈/指纹，
    并复用上下文 Cookie），errno==0 才算真正登录。

    注意：不能用 urllib/requests 这类非浏览器 HTTP 客户端——kuku 的 WAF 会按
    TLS/HTTP2 指纹识别并发风控，非 Chrome 指纹即使带有效 Cookie 也返回 未登录。
    原仓库正是用 curl_cffi 的 Session(impersonate="chrome") 来规避这一点。"""
    raw = _cookie_str(cookies)
    if not raw:
        return False
    query = urllib.parse.urlencode({
        "clienttype": 400, "app_id": 123971023, "web": 1,
        "channel": "chunlei", "version": "1.4.4",
    })
    url = "https://kuku.baidu.com/api/genflowpro/common/userreport?" + query
    try:
        resp = ctx.request.get(url, headers={
            "Cookie": raw,
            "Referer": "https://kuku.baidu.com/genflowpro",
            "Origin": "https://kuku.baidu.com",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }, timeout=15000)
        data = resp.json()
        return isinstance(data, dict) and data.get("errno") == 0
    except Exception:
        return False


def main() -> int:
    print("[kuku-login] 启动浏览器…若未安装 chromium 请先运行: python -m playwright install chromium")
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            headless=False,
            args=["--no-sandbox"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        print(f"[kuku-login] 打开 {TARGET}")
        page.goto(TARGET, timeout=60000)
        print("[kuku-login] 请在浏览器窗口内完成登录（扫码或账密均可）。脚本会用捕获的 Cookie 校验")
        print("[kuku-login] kuku userreport，errno==0 才视为登录成功并自动导出。")

        deadline = time.time() + TIMEOUT_SECONDS
        logged_in = False
        while time.time() < deadline:
            time.sleep(2)
            try:
                cookies = ctx.cookies()
            except Exception:
                cookies = []
            if any(c.get("name") == "BDUSS" and c.get("value") for c in cookies):
                if _kuku_logged_in(ctx, cookies):
                    logged_in = True
                    break
                print("[kuku-login] 已检测到 BDUSS，但 kuku userreport 仍未登录（可能是登录未完成需确认，正在等待…）")

        cookies = ctx.cookies()
        data = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "current_url": page.url,
            "logged_in": logged_in,
            "cookies": cookies,
        }
        with open(OUT_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        raw = _cookie_str(cookies)
        print(f"[kuku-login] logged_in={logged_in} 共 {len(cookies)} 个 Cookie")
        print(f"[kuku-login] 已保存 -> {OUT_FILE}")
        if logged_in and raw:
            print("[kuku-login] 可粘贴的 Cookie 串：\n" + raw)
        ctx.close()

    if not logged_in:
        print("[kuku-login] 未通过 kuku userreport 登录校验。请确认在窗口里真正完成登录后重试。")
        print("[kuku-login] 若反复导出的 Cookie 无效，请删除缓存目录后重试：")
        print(f"[kuku-login]    del /s /q {PROFILE_DIR}")
        return 1
    print("[kuku-login] 请把上方 Cookie 串（或 kuku_cookies.json 内容）粘到 ai-gateway Kuku 的 Key 输入框。")
    return 0


if __name__ == "__main__":
    sys.exit(main())