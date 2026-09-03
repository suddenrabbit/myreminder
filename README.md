# MyReminder

> 银行卡 + 网站会员到期提醒 PWA。原生 HTML/CSS/JS，Cloudflare Worker + D1，GitHub 连接 Cloudflare Dashboard 自动发布。

## 功能

- **两个 Tab**
  - **银行卡** 借记卡（仅银行 / 卡号）和信用卡（卡种类 / 卡组织 / 有效期 MM/YY / 额度 / 账单日 / 还款日 / 权益 / 年费）
  - **网站会员** 网站名 / 到期日，到期日远近自动排序，过期置顶
- **卡片交互**
  - 左侧大圆显示银行/网站首字（招商银行 → 招）
  - 卡片可调整边框色以匹配品牌色
  - 银行卡可拖拽 ⠿ 手柄调整顺序，会员按到期远近自动排序
  - 点击卡片进入编辑面板；点击眼睛临时展示完整卡号
- **品牌预设**： 中国大陆主流银行 / 网站会员列表 + "其他（手动输入）"
- **安全**： 数据明文存 D1，前端默认掩码（仅显示尾号 4 位）；通过访问口令 + HMAC Token 守护 API，登录失败按 IP 限流
- **PWA**： 缓存应用壳，可"添加到主屏幕"独立运行

## 技术栈

- Cloudflare Worker（ES module）—— `src/worker.js`
- D1 数据库 —— 单表迁移：`migrations/0001_init.sql`
- 原生 HTML/CSS/JS 前端 —— `public/`，无构建步骤
- Service Worker —— `public/sw.js`

## 本地开发

环境：Node.js ≥ 22.5（与 wrangler 4.x / node:test 兼容）。

```bash
npm install
npm run db:migrate:local   # 在本地 D1 上执行 migrations/0001_init.sql
npm run dev                # 启动 wrangler dev，监听 http://127.0.0.1:8787
```

首次启动前在仓库根创建 `.dev.vars`（已给出模板 `.dev.vars.example`），写入：

```
ACCESS_CODE=your-passphrase
```

打开浏览器访问 [http://127.0.0.1:8787](http://127.0.0.1:8787) → 输入上面那个访问口令即可登录。

> 本地模式下，Worker 通过 wrangler 的 Miniflare 使用本地 D1 SQLite 实例。每次 `npm run dev` 启动时自动应用 migration 到该实例。

## 部署到 Cloudflare

本项目按 **GitHub → Cloudflare Dashboard** 的 Git 集成方式发布（无 GitHub Actions 部署）。

1. **建远程仓库**
   在 GitHub 上新建一个仓库（例如 `myreminder`），将本地仓库推上去：
   ```bash
   git remote add origin git@github.com:<your-username>/myreminder.git
   git push -u origin main
   ```

2. **创建 D1 数据库**
   任意一种方式创建：
   - **CLI（推荐）**：
     ```bash
     npx wrangler d1 create myreminder
     ```
     把返回的 `database_id` 填到 `wrangler.jsonc` 的 `d1_databases[0].database_id`。
   - **Dashboard**：Workers & Pages → D1 → Create → Name: `myreminder`，记录 `database_id`，同样填入 `wrangler.jsonc`。

3. **远程执行迁移**
   ```bash
   npx wrangler d1 migrations apply myreminder --remote
   ```

4. **设置访问口令（ACCESS_CODE）**
   ```bash
   npx wrangler secret put ACCESS_CODE
   ```
   按提示输入口令并回车。建议至少 8 位。

5. **绑定 Git 仓库**
   - 登录 Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Workers** → 选 **Import a repository**
   - 选 `myreminder` 仓库，Build 设置保持默认（无需 build command，因为没有构建步骤）
   - 部署完成后会自动绑定 `wrangler.jsonc` 里的资源（D1 binding `DB`、Assets `ASSETS`）并应用 migrations

6. **访问应用**
   部署成功后 Dashboard 会显示 Worker 域名（例如 `myreminder.<sub>.workers.dev`）。打开后输入 **步骤 4** 设置的口令进入。

## 项目结构

```
myreminder/
├── .dev.vars.example
├── .gitignore
├── README.md
├── wrangler.jsonc                  # Worker 配置（D1 binding、静态资源、迁移目录）
├── migrations/
│   └── 0001_init.sql               # 银行卡 / 网站会员初始表
├── scripts/
│   └── gen_icons.py                # PWA 图标生成脚本
├── src/
│   └── worker.js                   # Cloudflare Worker API
└── public/                         # 静态资源（无构建步骤）
    ├── index.html
    ├── style.css
    ├── app.js
    ├── brands.js                   # 银行 / 网站品牌预设
    ├── sw.js                       # Service Worker
    ├── manifest.webmanifest
    ├── icon-192.png
    ├── icon-512.png
    └── apple-touch-icon.png
```

## API 速览

所有 `/api/*` 接口（除 `health` / `session`）需 `Authorization: Bearer <token>`，由 `/api/session` 登录成功后返回。

| Method  | Path                       | 说明                            |
|---------|----------------------------|---------------------------------|
| GET     | /api/health                | 健康检查 + ACCESS_CODE 是否配置 |
| POST    | /api/session               | 用访问口令换取 Bearer Token      |
| GET     | /api/cards                 | 银行卡列表（按 sort_order 升序）  |
| POST    | /api/cards                 | 新增银行卡                       |
| PUT     | /api/cards/:id             | 修改银行卡                       |
| DELETE  | /api/cards/:id             | 删除银行卡                       |
| POST    | /api/cards/reorder         | { ids } 持久化拖拽后的新顺序      |
| GET     | /api/memberships           | 会员列表（过期置顶，再按到期升序）|
| POST    | /api/memberships           | 新增会员                         |
| PUT     | /api/memberships/:id       | 修改会员                         |
| DELETE  | /api/memberships/:id       | 删除会员                         |

## 数据安全

- 访问口令由 Cloudflare secret 管理，前端从不缓存明文口令
- 登录 Token = HMAC(ACCESS_CODE, "myreminder.v1.{expiresAt}")，180 天过期；前端存 `localStorage`，跨设备共用同一口令即可同步
- 登录失败按 IP 限流：5 分钟内最多 6 次，超出锁定 10 分钟
- 卡片卡号按需求明文存 D1（前端默认掩码，仅展示尾号 4 位 + 眼睛按钮临时展开）
- 若需要更强保护，可以把 `wrangler.jsonc` 的 Worker 部署到 `*.workers.dev` 之外的私有域并开启 Cloudflare Access

## 维护提示

- 重新生成图标：`/Users/zm/.workbuddy/binaries/python/envs/default/bin/python scripts/gen_icons.py`
- 排查 Worker：`npm run tail`
- 本地清理数据：`rm -rf .wrangler/state/v3/d1/*`（仅本地 D1 数据）