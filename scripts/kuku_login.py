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

from playwright.sync_api import sync_playwright

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROFILE_DIR = os.path.join(BASE_DIR, "kuku_profile")   # 独立 profile，不污染系统 Chrome
OUT_FILE = os.path.join(BASE_DIR, "kuku_cookies.json")
TARGET = "https://kuku.baidu.com/genflowpro"
TIMEOUT_SECONDS = 10 * 60


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
        print("[kuku-login] 请在浏览器窗口内完成登录（扫码或账密均可），检测到 BDUSS 即自动导出。")

        deadline = time.time() + TIMEOUT_SECONDS
        logged_in = False
        while time.time() < deadline:
            time.sleep(2)
            try:
                cookies = ctx.cookies()
            except Exception:
                cookies = []
            if any(c.get("name") == "BDUSS" and c.get("value") for c in cookies):
                logged_in = True
                break

        cookies = ctx.cookies()
        data = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "current_url": page.url,
            "logged_in": logged_in,
            "cookies": cookies,
        }
        with open(OUT_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        raw = "; ".join(f"{c['name']}={c['value']}" for c in cookies if c.get("name") and c.get("value"))
        print(f"[kuku-login] logged_in={logged_in} 共 {len(cookies)} 个 Cookie")
        print(f"[kuku-login] 已保存 -> {OUT_FILE}")
        if raw:
            print("[kuku-login] 可粘贴的 Cookie 串：\n" + raw)
        ctx.close()

    if not logged_in:
        print("[kuku-login] 未检测到登录态（BDUSS 缺失），请重试。")
        return 1
    print("[kuku-login] 请把上方 Cookie 串（或 kuku_cookies.json 内容）粘到 ai-gateway Kuku 的 Key 输入框。")
    return 0


if __name__ == "__main__":
    sys.exit(main())