# IEEE 投稿状态识别系统

这个站点用于监控 IEEE ScholarOne 投稿状态。你可以登记期刊名称、投稿平台网址、ScholarOne 账号、密码和通知邮箱，系统会保存监控任务，支持手动检测，也可以通过定时任务每天北京时间 08:00 检测一次。状态与上一次不一致时，系统会记录历史并发送邮件通知。

## 架构

- `app/`：网站页面和 API。
- `lib/monitoring.ts`：任务保存、手动检测、批量检测和状态历史。
- `lib/checker.ts`：调用外部 IEEE 检测服务。
- `lib/email.ts`：通过 Resend HTTP API 发送邮件。
- `db/schema.ts` 和 `drizzle/0000_initial_submission_monitor.sql`：D1 数据库表结构。
- `.openai/hosting.json`：Sites D1 绑定，当前为 `DB`。

Cloudflare Worker/Sites 不能直接运行完整浏览器自动化，所以实际登录 `mc.manuscriptcentral.com` 的步骤通过 `IEEE_CHECKER_ENDPOINT` 接入一个独立检测服务。这个服务可以部署在 VPS、容器、Browserless、Apify 或其他支持 Playwright 的环境中。

## 环境变量

参考 `.env.example` 填写运行时变量。本地 `vinext dev`/Wrangler 读取 `.dev.vars`，生产环境变量在 Sites/Cloudflare 后台配置：

```bash
APP_SECRET="至少 32 个随机字符，用于加密 ScholarOne 密码"
CRON_SECRET="定时接口鉴权 token"
RESEND_API_KEY="Resend API Key"
MAIL_FROM="IEEE 投稿状态识别 <status@hits.asia>"
IEEE_CHECKER_ENDPOINT="https://your-checker.example.com/check"
IEEE_CHECKER_TOKEN="检测服务鉴权 token，可选"
```

`APP_SECRET` 必须长期保持不变，否则已保存的投稿平台密码无法解密。真实密码不要写进代码、README、`.env.example` 或 Git。

## IEEE 检测服务接口

主站会向 `IEEE_CHECKER_ENDPOINT` 发送：

```json
{
  "journalName": "IEEE Transactions on Systems, Man, and Cybernetics: Systems",
  "manuscriptUrl": "https://mc.manuscriptcentral.com/systems",
  "username": "account@example.com",
  "password": "runtime password"
}
```

检测服务应返回：

```json
{
  "status": "Awaiting Reviewer Scores",
  "detail": "可选，投稿编号、标题或页面摘要",
  "rawExcerpt": "可选，截断后的原始页面片段",
  "checkedAt": "2026-06-26T00:00:00.000Z"
}
```

当 `status` 与上一轮不同时，主站会发送通知邮件。

## 定时检测

每天北京时间 08:00 等于 UTC 00:00。部署后可以用任一方式触发：

- Cloudflare Cron Trigger 调用 Worker 的 `scheduled` handler。
- 外部定时器向 `/api/run-daily` 发 `POST` 请求，并带上 `x-cron-secret: CRON_SECRET`。

## 本地开发

```bash
npm.cmd install
npm.cmd run dev
npm.cmd run build
npm.cmd run lint
```

PowerShell 如果拦截 `npm.ps1`，使用 `npm.cmd`。

## hits.asia

部署完成后，在 Cloudflare DNS 中把 `hits.asia` 或子域名 CNAME 到 Sites 生产域名，并在 Sites/Worker 侧绑定自定义域名。发信域名 `status@hits.asia` 需要在 Resend 或你选择的邮件平台完成 SPF、DKIM、DMARC 验证。
