# WorkBuddy 一次性活动任务与成长中心脚本库

本目录包含针对 WorkBuddy / CodeBuddy 平台的**一次性活动**与**成长任务中心**自动化处理脚本。

> [!NOTE]
> **每日例行任务无需手动运行脚本！**
> 网关系统已内置每日自动化调度（连登签到 + 对话活跃度上报 + 猫猫旅行出游与到站领奖）。
> 您也可直接在网关 Web 管理界面的 WorkBuddy 提供商卡片中点击 **「一键日常（签到+活跃+旅行）」**、**「活跃上报」**、**「猫猫旅行」** 按钮实时触发。
> 
> 本目录脚本专门用于处理**一次性新手/成长中心任务**以及**限时运营活动（如开学季）**的批量点亮与领奖。

---

## 目录结构

| 文件 | 说明 |
| :--- | :--- |
| [`task_common.py`](./task_common.py) | 核心通信工具库，封装双域请求、JWT 自主解析与多格式凭证加载。零第三方依赖（仅需 Python 3 内置模块）。 |
| [`task_runner.py`](./task_runner.py) | 成长任务中心（Growth Center）自动化脚本：支持任务查询、合规事件伪造点亮、幂等真实领奖。 |
| [`school_open_day_2026.py`](./school_open_day_2026.py) | 微信小程序「开学季活动」任务中心自动化：打通分享、对话、桌面端 6 连指纹、开学季分类专家等任务。 |

---

## 凭证配置（三选一）

所有脚本均默认从当前目录下的 `auths/` 目录中读取凭证。支持以下三种极为便捷的配置方式：

### 方式 A：凭证文件（推荐批量）

在 `scripts/workbuddy/auths/` 目录下创建以 `workbuddy-<uid>.json` 或 `<uid>.json` 命名的文件。
脚本智能兼容以下任意一种 JSON 结构：

1. **网关账号导出格式**（直接使用网关池数据）：
   ```json
   {
     "uid": "wb_user_12345",
     "token": {
       "access_token": "eyJhbGciOi..."
     }
   }
   ```
2. **workbuddy2api 格式**：
   ```json
   {
     "account": { "uid": "wb_user_12345", "nickname": "我的昵称" },
     "auth": { "accessToken": "eyJhbGciOi...", "domain": "copilot.tencent.com" }
   }
   ```
3. **极简 Token 格式**（自动解析 JWT 提取 UID 与 Domain）：
   ```json
   {
     "access_token": "eyJhbGciOi..."
   }
   ```

### 方式 B：环境变量（适合单账号快速执行）

无需生成任何本地文件，直接在终端中设置环境变量：
```bash
# Linux / macOS
export WORKBUDDY_TOKEN="eyJhbGciOi..."
python scripts/workbuddy/task_runner.py env --yes

# Windows PowerShell
$env:WORKBUDDY_TOKEN="eyJhbGciOi..."
python scripts\workbuddy\task_runner.py env --yes
```

### 方式 C：CLI 命令行参数（针对活动脚本）

`school_open_day_2026.py` 支持直接通过 `--token` 参数传入：
```bash
python scripts/workbuddy/school_open_day_2026.py --token "eyJhbGciOi..." --run --yes
```

---

## 使用指南

### 1. 成长任务中心（task_runner.py）

本脚本打通了成长任务中心 14+ 项常规与进阶任务（画板、模板、专家使用、团队协作、技能调用、GLM-5.2 对话、桌面端指纹会话、资料库浏览等）。所有写动作默认均为 **Dry-Run（只读模拟）**，必须显式附加 `--yes` 才会真实上报并领奖。

#### 常见用法示例：

- **只读查询任务状态（Dry-Run 安全模式）：**
  ```bash
  # 查询单个账号
  python scripts/workbuddy/task_runner.py <uid_前缀>

  # 批量盘点全部账号
  python scripts/workbuddy/task_runner.py ALL
  ```

- **全量执行（接任务 → 事件上报点亮 → 回读验证 → 真实领奖）：**
  ```bash
  python scripts/workbuddy/task_runner.py <uid_前缀> --yes
  ```

- **只领奖不点亮（对已经达到完成态的任务直接领取奖励，服务端天然幂等）：**
  ```bash
  python scripts/workbuddy/task_runner.py <uid_前缀> --yes --only-claim
  ```

- **只处理指定单项任务（如 template_5 或 create_canvas）：**
  ```bash
  python scripts/workbuddy/task_runner.py <uid_前缀> --yes --only template_5
  ```

- **控制请求间隔（默认 1.0 秒）：**
  ```bash
  python scripts/workbuddy/task_runner.py <uid_前缀> --yes --gap 1.5
  ```

---

### 2. 开学季限时活动（school_open_day_2026.py）

针对微信小程序端「开学季活动」任务中心（涵盖 `share_invite` 分享、`chat_3_times` 小程序对话、`desktop_chat_1_time` 桌面端对话、`expert_use` 开学季分类专家对话）。

#### 常见用法示例：

- **只读盘点活动任务进度：**
  ```bash
  python scripts/workbuddy/school_open_day_2026.py <uid_前缀> --list
  ```

- **模拟运行（检查点亮参数，不发写请求）：**
  ```bash
  python scripts/workbuddy/school_open_day_2026.py <uid_前缀> --run
  ```

- **正式执行点亮并领取抽奖机会：**
  ```bash
  python scripts/workbuddy/school_open_day_2026.py <uid_前缀> --run --yes
  ```

- **批量对所有账号执行：**
  ```bash
  python scripts/workbuddy/school_open_day_2026.py ALL --run --yes
  ```

> [!WARNING]
> - `task_student_verify`（学生认证）属于人工核验环节，脚本已设计为自动跳过，绝不伪造。
> - 领奖接口（`claim`）会真实发放抽奖机会，属于有价权益，请合规合理使用。
