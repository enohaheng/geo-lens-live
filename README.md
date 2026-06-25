# GEO Lens Live Backend

这是 GEO Lens 的真实联网诊断版本。它会提供：

- `GET /api/status`：检查搜索 API 和豆包 API 是否已配置
- `POST /api/live-diagnose`：联网检索资料、识别行业品类、归纳竞品和卖点、调用豆包生成 AI 测试回答
- 静态前端页面：打开 `http://127.0.0.1:8790`

## 1. 配置 API Key

运行配置向导：

```powershell
.\setup-live-config.ps1
```

它会生成 `.env.local`。Key 只保存在本机，不要发到聊天窗口。

必须配置：

- `ARK_API_KEY`：火山方舟 API Key
- `ARK_MODEL`：火山方舟里的豆包模型/Endpoint 模型名

搜索资料至少配置一种：

- `BING_SEARCH_API_KEY`
- 或 `SERPAPI_KEY`

建议优先使用 `SERPAPI_KEY`。SerpApi 支持多个搜索引擎和本地搜索参数，适合这类商户诊断；Bing Search API 在微软文档中已归到 previous versions，后续可用性不如 SerpApi 稳。

如果豆包已经配置好，只想补搜索 Key，运行：

```powershell
.\setup-search-config.ps1
```

## 2. 启动

```powershell
.\start-live.ps1
```

打开：

```text
http://127.0.0.1:8790
```

## 3. 注意

如果没有配置搜索 API 或豆包 API，前端会降级到本地模拟探针。真实商业诊断必须配置搜索和豆包。

## 4. 公网部署前建议

`.env.local` 或服务器环境变量里建议设置：

```text
ACCESS_CODE=你的访问码
RATE_LIMIT_PER_HOUR=30
CACHE_TTL_HOURS=24
```

- `ACCESS_CODE`：防止别人直接消耗你的 API 额度
- `RATE_LIMIT_PER_HOUR`：按 IP 限流
- `CACHE_TTL_HOURS`：同一商户诊断缓存时间，节省搜索和豆包费用
