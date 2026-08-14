# 开发备忘（CODING_NOTES）

本项目迭代中反复踩坑的约定。改代码前先看这里，尤其是涉及管理后台页面模板时。

## ⚠️ SSR 内联 JS 转义铁律（最高优先级）

`src/pages.ts` 是用 **TypeScript 模板字符串（反引号）整体渲染成 `<script>` 内联脚本** 的 SSR 页面。
任何转义失误都会导致 **整块脚本语法错误 → 后台所有按钮/函数失效**，且错误只在浏览器控制台报
`xxx is not defined`，极难排查。已多次踩坑，铁律如下：

1. **单反斜杠陷阱**：想要渲染后 JS 里出现 `\'`（JS 字符串内的转义单引号），**源文件必须写 `\\'`（两个反斜杠）**。
   写单反斜杠 `\'` 会在模板字符串里被解释成裸单引号 `'`，使渲染出的 JS 单引号字符串提前闭合 → SyntaxError。
   ```ts
   // ✅ 正确（渲染后为 onclick="mcpSave('...')"）
   onclick="mcpSave(\\'' + id + '\\')"
   // ❌ 错误（渲染后单引号字符串提前闭合，必炸）
   onclick="mcpSave(\'' + id + '\')"
   ```

2. **JSON 注入一律用 `serializeForScript()`**，禁止裸 `JSON.stringify` 拼进模板：
   - 不转义 `<` 时，数据里的 `</script>` 会直接截断 HTML script 块；`<!--` 会开启 HTML 注释吞掉后续脚本。
   - 数据里的 U+2028 / U+2029（JS 行/段分隔符）会令字符串字面量非法（ES2019 前）。
   ```ts
   const X = ${serializeForScript(data)};   // ✅
   const X = ${JSON.stringify(data)};       // ❌
   ```
   该方法在 `renderAdminPage` 内定义，转义 `<` → `\u003c`、U+2028 → `\u2028`、U+2029 → `\u2029`。

3. **禁止裸反引号与裸 `${`**：页面 JS 内容里出现 `` ` `` 会结束 TS 模板字符串，出现 `${` 会被当作插值。

4. **转义函数选型（不要混用）**：
   - 字符串值进 HTML → `escapePageHtml()`
   - 字符串值进内联 JS 属性（onclick / onchange 等）→ `escapePageJs()` / `escapePageJsx()`

5. **改完必须验证**：重新渲染管理页，把生成的 `<script>` 内容存文件后 `node --check` 校验；
   或至少核对所有新写的 `\'` 都是 `\\'`。
   （诊断脚本示例：登录拿 cookie → fetch `/admin` → 正则抽取 script → `node --check`）

以上同样适用于经 `${SHARED_JS}` / `${ANALYTICS_JS}` 注入的 `shared.js.ts` / `analytics-ui.js.ts`。

## 其他约定

- **git 提交约定**：改完代码后**自动提交并推送**到仓库（用户约定，无需再询问）。提交前先 `git pull --rebase` 避免远程有更新。
- **避免新增 npm 依赖**：本仓库仅依赖 hono。需要并发限制等小工具时自实现（如 `mcp-gateway.ts` 的 `mapWithLimit`）。
- **类型检查**：`npx tsc --noEmit`（`npm run build` 的 wrangler dry-run 在部分环境会因日志写入权限退出非零，不代表构建失败）。
- **存储键隔离**：新增 KV 键在 `config.ts` 的 `KV_KEYS` 注册；新功能数据与现有 providers / proxyKeys 键隔离。
- **SSRF 防护**：新增外部 URL 配置统一过 `isSafeHttpUrl` 校验。
- **不破坏现有 API 契约**：路由、KV 结构、响应字段对客户端保持向后兼容；新字段一律可选。
