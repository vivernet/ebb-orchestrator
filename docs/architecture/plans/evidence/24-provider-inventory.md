---
id: reference-24-provider-inventory
kind: reference
title: Инвентаризация AI-провайдеров закреплённого LobeHub (plan-24, Task 0)
status: approved
type: evidence
created: 2026-10-23
updated: 2026-10-23
---

# Инвентаризация AI-провайдеров закреплённого источника LobeHub

Evidence-документ Task 0 плана [24-lobehub-provider-catalog-web-management](../24-lobehub-provider-catalog-web-management.md).
Фиксирует точный source-backed контракт каталога провайдеров (86 provider ID),
способы авторизации, credential/config-поля, модель-источники и семантику
subscription/refresh/disconnect для последующих задач плана (Task 1–7).

## 1. Закреплённый источник (source pin)

| Параметр | Значение |
|---|---|
| Репозиторий | LobeHub (`lobehub/lobe-chat`) |
| Commit (pin) | `d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1` |
| Enum provider ID | `packages/model-bank/src/const/modelProvider.ts` — ровно 86 уникальных ID |
| Provider cards | `packages/model-bank/src/modelProviders/<id>.ts` (86 файлов, по одному на ID) |
| Модельные списки | `packages/model-bank/src/aiModels/<id>.ts` (статичные builtin-списки; у `google`/`openai`/`openrouter` — каталоги с `index.ts`) |
| Runtime | `packages/model-runtime/src/providers/<id>/` (реализации протоколов) |
| Схема хранения | `packages/database/src/schemas/aiInfra.ts` (provider: `keyVaults` — секреты, `settings` — authType/oauthDeviceFlow/sdkType, `config` — несекретные настройки; model: `abilities`/`type`) |

Метод: детерминированный парсер перечисленных файлов (без сетевых вызовов,
без чтения секретов, без обращения к профилю пользователя). Статусы `enabled`
в карточках источника не имеют отношения к доступности провайдера в Ebb:
каталог Ebb содержит **все** 86 ID независимо от `enabled`.

## 2. Инвентаризация: 86 строк

Формат строки инвентаризации (Task 0):
{providerId, displayName, sourcePath, sourceVersion, authMethods, credentialFields,
configFields, modelSource, modelTypes, runtimeProtocol, capabilities,
subscriptionSemantics, refreshSemantics, disconnectSemantics}.

`sourceVersion` для всех строк — `d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1`;
`sourcePath` — путь к файлу provider card внутри закреплённого коммита.
Строки разбиты на две таблицы по ключу `providerId` (каждый ID — ровно одна
строка в каждой таблице).

### 2.1. Таблица A — identity, авторизация, credential/config-поля

| providerId | displayName | authMethods | credentialFields | configFields | sourcePath |
|---|---|---|---|---|---|
| ai21 | Ai21Labs | api-key | apiKey | — | `packages/model-bank/src/modelProviders/ai21.ts` |
| ai302 | 302.AI | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/ai302.ts` |
| ai360 | 360 AI | api-key | apiKey | fetcher | `packages/model-bank/src/modelProviders/ai360.ts` |
| aihubmix | AIHubMix | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/aihubmix.ts` |
| akashchat | AkashChat | api-key | apiKey | fetcher | `packages/model-bank/src/modelProviders/akashchat.ts` |
| antgroup | AntGroup | api-key | apiKey | — | `packages/model-bank/src/modelProviders/antgroup.ts` |
| anthropic | Anthropic | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/anthropic.ts` |
| azure | Azure OpenAI | api-key | apiKey | resourceName,deploymentName,apiVersion(optional) | `packages/model-bank/src/modelProviders/azure.ts` |
| azureai | Azure AI | api-key | apiKey | endpoint,deploymentName | `packages/model-bank/src/modelProviders/azureai.ts` |
| baichuan | Baichuan | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/baichuan.ts` |
| bailiancodingplan | Aliyun Bailian Coding Plan | subscription-token | apiKey | endpoint,deployName | `packages/model-bank/src/modelProviders/bailianCodingPlan.ts` |
| bedrock | Bedrock | credential-fields/cloud-identity | accessKeyId,secretAccessKey,sessionToken(optional) | region | `packages/model-bank/src/modelProviders/bedrock.ts` |
| bfl | Black Forest Labs | api-key | apiKey | — | `packages/model-bank/src/modelProviders/bfl.ts` |
| cerebras | Cerebras | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/cerebras.ts` |
| chatgpt | ChatGPT | oauth-device-code | oauthAccessToken,oauthRefreshToken | endpoint | `packages/model-bank/src/modelProviders/chatGPT.ts` |
| cloudflare | Cloudflare Workers AI | api-key | apiKey | accountId,endpoint,fetcher | `packages/model-bank/src/modelProviders/cloudflare.ts` |
| cohere | Cohere | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/cohere.ts` |
| cometapi | CometAPI | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/cometapi.ts` |
| comfyui | ComfyUI | local-endpoint/api-key(optional) | apiKey(optional) | endpoint | `packages/model-bank/src/modelProviders/comfyui.ts` |
| deepseek | DeepSeek | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/deepseek.ts` |
| fal | Fal | api-key | apiKey | — | `packages/model-bank/src/modelProviders/fal.ts` |
| fireworksai | Fireworks AI | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/fireworksai.ts` |
| giteeai | Gitee AI | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/giteeai.ts` |
| github | GitHub | api-key | apiKey(PAT) | endpoint,fetcher | `packages/model-bank/src/modelProviders/github.ts` |
| githubcopilot | GitHub Copilot | oauth-device-code | oauthAccessToken,oauthRefreshToken,bearerToken | endpoint | `packages/model-bank/src/modelProviders/githubCopilot.ts` |
| glmcodingplan | GLM Coding Plan | subscription-token | apiKey | endpoint,deployName | `packages/model-bank/src/modelProviders/glmCodingPlan.ts` |
| google | Google | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/google.ts` |
| groq | Groq | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/groq.ts` |
| higress | Higress | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/higress.ts` |
| huggingface | HuggingFace | api-key | apiKey(HF token) | endpoint,fetcher | `packages/model-bank/src/modelProviders/huggingface.ts` |
| hunyuan | Hunyuan | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/hunyuan.ts` |
| infiniai | InfiniAI | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/infiniai.ts` |
| internlm | InternLM | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/internlm.ts` |
| jina | Jina AI | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/jina.ts` |
| kimicodingplan | Kimi Code | subscription-token | apiKey | endpoint,deployName | `packages/model-bank/src/modelProviders/kimiCodingPlan.ts` |
| lmstudio | LM Studio | local-endpoint | — | endpoint,fetcher | `packages/model-bank/src/modelProviders/lmstudio.ts` |
| lobehub | LobeHub | subscription-token | apiKey | — | `packages/model-bank/src/modelProviders/lobehub.ts` |
| longcat | LongCat | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/longcat.ts` |
| meta | Meta | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/meta.ts` |
| minimax | Minimax | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/minimax.ts` |
| minimaxcodingplan | MiniMax Token Plan | subscription-token | apiKey | endpoint,deployName | `packages/model-bank/src/modelProviders/minimaxCodingPlan.ts` |
| mistral | Mistral | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/mistral.ts` |
| modelscope | ModelScope | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/modelscope.ts` |
| moonshot | Moonshot | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/moonshot.ts` |
| nebius | Nebius | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/nebius.ts` |
| newapi | New API | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/newapi.ts` |
| novita | Novita | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/novita.ts` |
| nvidia | Nvidia | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/nvidia.ts` |
| ollama | Ollama | local-endpoint | apiKey(optional) | endpoint,fetcher | `packages/model-bank/src/modelProviders/ollama.ts` |
| ollamacloud | Ollama Cloud | api-key | apiKey | fetcher | `packages/model-bank/src/modelProviders/ollamacloud.ts` |
| openai | OpenAI | api-key | apiKey | fetcher | `packages/model-bank/src/modelProviders/openai.ts` |
| opencodecodingplan | OpenCode Go | subscription-token | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/opencodeCodingPlan.ts` |
| opencodezen | OpenCode Zen | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/opencodeZen.ts` |
| openrouter | OpenRouter | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/openrouter.ts` |
| perplexity | Perplexity | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/perplexity.ts` |
| ppio | PPIO | api-key | apiKey | fetcher | `packages/model-bank/src/modelProviders/ppio.ts` |
| qiniu | Qiniu | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/qiniu.ts` |
| qwen | Aliyun Bailian | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/qwen.ts` |
| replicate | Replicate | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/replicate.ts` |
| sambanova | SambaNova | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/sambanova.ts` |
| search1api | Search1API | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/search1api.ts` |
| sensenova | SenseNova | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/sensenova.ts` |
| siliconcloud | SiliconCloud | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/siliconcloud.ts` |
| spark | Spark | api-key | apiKey | — | `packages/model-bank/src/modelProviders/spark.ts` |
| stepfun | Stepfun | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/stepfun.ts` |
| straico | Straico | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/straico.ts` |
| streamlake | StreamLake | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/streamlake.ts` |
| supergrok | SuperGrok | oauth-device-code | oauthAccessToken,oauthRefreshToken | endpoint | `packages/model-bank/src/modelProviders/superGrok.ts` |
| taichu | Taichu | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/taichu.ts` |
| tencentcloud | TencentCloud | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/tencentcloud.ts` |
| togetherai | Together AI | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/togetherai.ts` |
| unsloth | Unsloth | local-endpoint | — | endpoint,fetcher | `packages/model-bank/src/modelProviders/unsloth.ts` |
| upstage | Upstage | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/upstage.ts` |
| v0 | Vercel (v0) | api-key | apiKey | — | `packages/model-bank/src/modelProviders/v0.ts` |
| vercelaigateway | Vercel AI Gateway | api-key | apiKey | fetcher | `packages/model-bank/src/modelProviders/vercelaigateway.ts` |
| vertexai | Vertex AI | api-key/cloud-identity | apiKey | projectId,region(optional) | `packages/model-bank/src/modelProviders/vertexai.ts` |
| vllm | vLLM | local-endpoint | — | endpoint,fetcher | `packages/model-bank/src/modelProviders/vllm.ts` |
| volcengine | Volcengine | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/volcengine.ts` |
| volcenginecodingplan | Volcengine Coding Plan | subscription-token | apiKey | endpoint,deployName | `packages/model-bank/src/modelProviders/volcengineCodingPlan.ts` |
| wenxin | Wenxin | api-key | apiKey | endpoint | `packages/model-bank/src/modelProviders/wenxin.ts` |
| xai | xAI | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/xai.ts` |
| xiaomimimo | Xiaomi MiMo | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/xiaomimimo.ts` |
| xinference | Xinference | local-endpoint | — | endpoint | `packages/model-bank/src/modelProviders/xinference.ts` |
| zenmux | ZenMux | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/zenmux.ts` |
| zeroone | 01.AI | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/zeroone.ts` |
| zhipu | ZhiPu | api-key | apiKey | endpoint,fetcher | `packages/model-bank/src/modelProviders/zhipu.ts` |

### 2.2. Таблица B — модели, протокол, возможности, семантика

| providerId | modelSource | modelTypes | runtimeProtocol | capabilities | subscriptionSemantics | refreshSemantics | disconnectSemantics |
|---|---|---|---|---|---|---|---|
| ai21 | builtin:2 | chat | openai-compatible | chat,streaming,toolCalling | none | none | local-only |
| ai302 | remote+builtin:17 | chat | openai-compatible | chat,streaming | none | none | local-only |
| ai360 | remote+builtin:20 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| aihubmix | remote+builtin:68 | chat,image | openai-router | chat,imageGeneration,streaming,structuredOutput,toolCalling,videoGeneration,vision | none | none | local-only |
| akashchat | remote+builtin:7 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| antgroup | builtin:4 | chat | openai-compatible | chat,streaming,toolCalling | none | none | local-only |
| anthropic | remote+builtin:13 | chat | anthropic-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| azure | builtin:31 | chat,image | azure-openai | chat,imageGeneration,streaming,toolCalling,vision | none | none | local-only |
| azureai | builtin:13 | chat | azure-ai-inference | chat,streaming,toolCalling,vision | none | none | local-only |
| baichuan | remote+builtin:10 | chat | openai-compatible | chat,streaming,toolCalling | none | none | local-only |
| bailiancodingplan | builtin:8 | chat | openai-compatible | chat,streaming,toolCalling,videoGeneration,vision | plan-token | manual | local-only |
| bedrock | builtin:26 | chat | aws-bedrock | chat,streaming,toolCalling,vision | none | none | local-only |
| bfl | builtin:6 | image | image-rest | imageGeneration | none | none | local-only |
| cerebras | remote+builtin:2 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| chatgpt | builtin(derived from OpenAI) | chat | openai-compatible | chat,streaming | account-subscription | srv-refresh | local-only |
| cloudflare | remote+builtin:7 | chat | cloudflare-workers-ai | chat,streaming,toolCalling | none | none | local-only |
| cohere | builtin:7 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| cometapi | remote+builtin:28 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| comfyui | builtin:11+local | image | comfyui | imageGeneration | none | none | local-only |
| deepseek | remote+builtin:3 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| fal | builtin:12 | image,video | image-video-rest | imageGeneration,videoGeneration | none | none | local-only |
| fireworksai | remote+builtin:22 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| giteeai | remote+builtin:36 | chat,image | openai-compatible | chat,imageGeneration,streaming,toolCalling,vision | none | none | local-only |
| github | remote+builtin:44 | chat | azure-openai | chat,streaming,toolCalling,vision | none | none | local-only |
| githubcopilot | builtin:20 | chat | openai-compatible | chat,streaming,structuredOutput,toolCalling,vision | account-subscription | exchange-on-demand | local-only |
| glmcodingplan | builtin:7 | chat | openai-compatible | chat,streaming,toolCalling | plan-token | manual | local-only |
| google | remote+builtin:25 | chat,image,video | google-generative | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| groq | remote+builtin:9 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| higress | remote+builtin:199 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| huggingface | remote+builtin:9 | chat | huggingface-inference | chat,streaming | none | none | local-only |
| hunyuan | builtin:24 | chat,image,video | openai-compatible | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| infiniai | remote+builtin:42 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| internlm | remote+builtin:7 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| jina | remote+builtin:1 | chat | openai-compatible | chat,streaming | none | none | local-only |
| kimicodingplan | builtin:2 | chat | anthropic-compatible | chat,streaming,toolCalling,videoGeneration,vision | plan-token | manual | local-only |
| lmstudio | remote+builtin:2+local | chat | openai-compatible | chat,streaming | none | none | local-only |
| lobehub | static(platform) | chat | platform-cloud | chat,streaming | plan-token | manual | local-only |
| longcat | remote+builtin:1 | chat | openai-compatible | chat,streaming,toolCalling | none | none | local-only |
| meta | builtin:1 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| minimax | builtin:25 | chat,image,video | openai-compatible | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| minimaxcodingplan | builtin:6 | chat | openai-compatible | chat,streaming,toolCalling | plan-token | manual | local-only |
| mistral | remote+builtin:8 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| modelscope | remote+builtin:3 | chat | openai-compatible | chat,streaming,toolCalling | none | none | local-only |
| moonshot | remote+builtin:4 | chat | openai-compatible | chat,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| nebius | remote+builtin:4 | chat,embedding | openai-compatible | chat,embeddings,streaming,toolCalling,vision | none | none | local-only |
| newapi | remote | chat | openai-router | chat,streaming,structuredOutput | none | none | local-only |
| novita | remote+builtin:61 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| nvidia | remote+builtin:7 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| ollama | remote+builtin:52+local | chat | ollama-native | chat,streaming,toolCalling,vision | none | none | local-only |
| ollamacloud | remote+builtin:11 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| openai | remote+builtin:46 | chat | openai-compatible | chat,streaming,structuredOutput,toolCalling,vision | none | none | local-only |
| opencodecodingplan | remote+builtin:15 | chat | openai-compatible | chat,streaming,toolCalling,vision | plan-token | manual | local-only |
| opencodezen | remote+builtin:35 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| openrouter | remote+builtin:44 | chat | openai-compatible | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| perplexity | builtin:6 | chat | openai-compatible | chat,streaming,vision | none | none | local-only |
| ppio | remote+builtin:19 | chat | openai-compatible | chat,streaming,vision | none | none | local-only |
| qiniu | remote+builtin:8 | chat | openai-compatible | chat,streaming,toolCalling | none | none | local-only |
| qwen | remote+builtin:187 | chat,image,video | openai-compatible | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| replicate | remote+builtin:4 | image | replicate | imageGeneration | none | none | local-only |
| sambanova | builtin:7 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| search1api | remote+builtin:4 | chat | openai-compatible | chat,streaming | none | none | local-only |
| sensenova | remote+builtin:3 | chat,image | openai-compatible | chat,imageGeneration,streaming,toolCalling,vision | none | none | local-only |
| siliconcloud | remote+builtin:66 | chat,image,video | openai-compatible | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| spark | builtin:9 | chat | openai-compatible | chat,streaming,toolCalling | none | none | local-only |
| stepfun | remote+builtin:20 | chat,image | openai-compatible | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| straico | remote | chat | openai-compatible | chat,streaming | none | none | local-only |
| streamlake | builtin:13 | chat | openai-compatible | chat,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| supergrok | builtin:3 | chat | openai-compatible | chat,streaming,toolCalling,vision | account-subscription | srv-refresh | local-only |
| taichu | builtin:13 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| tencentcloud | remote+builtin:3 | chat | openai-compatible | chat,streaming | none | none | local-only |
| togetherai | remote+builtin:45 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| unsloth | remote+builtin:2+local | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| upstage | builtin:3 | chat | openai-compatible | chat,streaming,toolCalling | none | none | local-only |
| v0 | builtin:3 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| vercelaigateway | remote+builtin:91 | chat,embedding | gateway | chat,embeddings,streaming,toolCalling,vision | none | none | local-only |
| vertexai | builtin:28 | chat,image | google-vertex | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| vllm | remote+builtin:9+local | chat | openai-compatible | chat,streaming,toolCalling | none | none | local-only |
| volcengine | builtin:33 | chat,image,video | openai-compatible | chat,imageGeneration,streaming,structuredOutput,toolCalling,videoGeneration,vision | none | none | local-only |
| volcenginecodingplan | builtin:8 | chat | openai-compatible | chat,streaming,toolCalling,videoGeneration,vision | plan-token | manual | local-only |
| wenxin | builtin:52 | chat,image,video | openai-compatible | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| xai | remote+builtin:10 | chat,image,video | openai-compatible | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| xiaomimimo | remote+builtin:5 | chat | openai-compatible | chat,streaming,toolCalling,videoGeneration,vision | none | none | local-only |
| xinference | builtin:14+local | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| zenmux | remote+builtin:69 | chat | openai-router | chat,imageGeneration,streaming,toolCalling,vision | none | none | local-only |
| zeroone | remote+builtin:12 | chat | openai-compatible | chat,streaming,toolCalling,vision | none | none | local-only |
| zhipu | remote+builtin:51 | chat,image,video | openai-compatible | chat,imageGeneration,streaming,toolCalling,videoGeneration,vision | none | none | local-only |

## 3. Сводка вариантов авторизации (auth variants)

| Вариант | Провайдеры | Комментарий по источнику |
|---|---|---|
| `api-key` | большинство (по умолчанию) | `settings.authType` не задан или `apiKey`; credential-поле `apiKey` |
| `oauth-device-code` | `chatgpt`, `githubcopilot`, `supergrok` | `settings.authType: 'oauthDeviceFlow'`; deviceCode/token endpoints и scopes в карточке |
| `subscription-token` (coding/subscription plan) | `bailiancodingplan`, `glmcodingplan`, `kimicodingplan`, `minimaxcodingplan`, `opencodecodingplan`, `volcenginecodingplan`, `lobehub` | Токен плана/подписки передаётся как credential; у большинства coding-plan карточек `showDeployName: true`; у `lobehub` — `showConfig: false` (первый-party cloud) |
| `local-endpoint` | `ollama`, `lmstudio`, `vllm`, `xinference`, `unsloth`, `comfyui` | Локальный/self-hosted endpoint; секрет не требуется (у `comfyui` API-ключ опционален) |
| `credential-fields` / `cloud-identity` | `bedrock`, `vertexai` | `bedrock` — AWS-credentials (`accessKeyId`/`secretAccessKey`/`sessionToken`); `vertexai` — Google API-ключ или cloud-identity (project/region) |

Для `azure`/`azureai` используется `api-key` + endpoint/deployment-поля
(`resourceName`/`deploymentName`/`apiVersion`). Для `github` — PAT-токен
через Azure-совместимый gateway.

## 4. Семантика subscription/refresh/disconnect

- **Subscription (какие методы реально аутентифицируют):**
  - `account-subscription` — ChatGPT/Copilot/SuperGrok: OAuth Device Flow
    аутентифицирует аккаунт-подписку, а не API-ключ платформы.
  - `plan-token` — coding-plan/платформенные токены (`bailiancodingplan`,
    `glmcodingplan`, `kimicodingplan`, `minimaxcodingplan`, `opencodecodingplan`,
    `volcenginecodingplan`, `lobehub`).
  - `none` — остальные: обычный API-ключ, без subscription-семантики.
- **Refresh:** серверный refresh-пиплайн объявлен в источнике только через
  `oauthDeviceFlow.refreshTokenGrant: true` у `chatgpt` и `supergrok`
  (ротация refresh-токена, персист последней пары). У `githubcopilot` —
  `tokenExchangeEndpoint` (короткоживущий Copilot-токен чеканится из OAuth
  access token по требованию). Остальные — refresh не определён
  (`none`) или ручной (`manual`).
- **Disconnect:** в закреплённом источнике нет upstream revoke-эндпоинтов
  для провайдеров; disconnect означает локальное удаление credential/состояния
  (`local-only`), без ложного утверждения удалённой отмены.

## 5. Модельные источники и возможности

- `modelSource`: `builtin:N` — статичный список из `aiModels` (N моделей);
  `remote` — fetcher модели по API провайдера (`showModelFetcher: true`);
  `+custom` — пользовательские модели (`showAddNewModel`); `+local` — local
  endpoint; у `chatgpt` список выводится из списока OpenAI (`builtin(derived from OpenAI)`).
- `modelTypes` и `capabilities` выведены из полей модельных списков
  (`type`, `vision`, `video`, `imageOutput`, `functionCall`, `reasoning`,
  `search`, `files`) и протокола runtime. `streaming` указывается для
  chat-протоколов; `structuredOutput` — только там, где карточка объявляет
  `supportResponsesApi` (`openai`, `newapi`, `githubcopilot`, `aihubmix`, `volcengine`); остальной
  structured-output контракт проверяется на уровне адаптеров Task 3, а не
  заявляется по карточке.

## 6. Решения и disposition пользователя

| Инцидент | Disposition |
|---|---|
| IN-001 | Отложен — обслуживание навыков, к plan-24 отношения не имеет |
| IN-002 | Адресован — контракт Web-managed OS SecretStore (Task 2/4/6): Web управляет provider config и auth lifecycle, секреты — только в OS `SecretStore`, SQLite хранит references/несекретные настройки |
| IN-003 | Отложен — macOS CI как несвязанная работа; не является пропуском поддержки провайдеров |
| IN-004 | Plan20 lifecycle остаётся неизменным и независимым; Plan20 сохраняет process-supervision/reconciliation-инварианты, но больше не является единственным владельцем provider-конфигурации |

## 7. Сверка с локальным каталогом Ebb

Скрипт `scripts/provider-inventory-check.mjs` (создан в Task 0) сверяет
локальный набор provider ID с EXPECTED (86 ID). На baseline (до Task 1)
локальный набор — fallback из `hermes-provider-registry.ts` (`openai-api` →
`openai`, `anthropic` → `anthropic`): результат **FAIL**, missing = 84,
отсортированные ID отсутствующих — весь набор кроме `anthropic`/`openai`.
После Task 1 источником LOCAL становится `provider-catalog.ts`; проверка
завершается PASS при 86/86 без missing/duplicates.
