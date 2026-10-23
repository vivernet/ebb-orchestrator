/**
 * Ожидаемый набор из 86 provider ID — enum `ModelProvider` закреплённого
 * коммита LobeHub `d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1`
 * (`packages/model-bank/src/const/modelProvider.ts`). Набор повторяет контракт
 * скрипта `scripts/provider-inventory-check.mjs` и используется тестами
 * каталога провайдеров и модельного каталога.
 */
export const EXPECTED_PROVIDER_IDS: readonly string[] = Object.freeze([
  'ai21', 'ai302', 'ai360', 'aihubmix', 'akashchat', 'antgroup', 'anthropic',
  'azure', 'azureai', 'baichuan', 'bailiancodingplan', 'bedrock', 'bfl',
  'cerebras', 'chatgpt', 'cloudflare', 'cohere', 'cometapi', 'comfyui',
  'deepseek', 'fal', 'fireworksai', 'giteeai', 'github', 'githubcopilot',
  'glmcodingplan', 'google', 'groq', 'higress', 'huggingface', 'hunyuan',
  'infiniai', 'internlm', 'jina', 'kimicodingplan', 'lmstudio', 'lobehub',
  'longcat', 'meta', 'minimax', 'minimaxcodingplan', 'mistral', 'modelscope',
  'moonshot', 'nebius', 'newapi', 'novita', 'nvidia', 'ollama',
  'ollamacloud', 'openai', 'opencodecodingplan', 'opencodezen', 'openrouter',
  'perplexity', 'ppio', 'qiniu', 'qwen', 'replicate', 'sambanova',
  'search1api', 'sensenova', 'siliconcloud', 'spark', 'stepfun', 'straico',
  'streamlake', 'supergrok', 'taichu', 'tencentcloud', 'togetherai',
  'unsloth', 'upstage', 'v0', 'vercelaigateway', 'vertexai', 'vllm',
  'volcengine', 'volcenginecodingplan', 'wenxin', 'xai', 'xiaomimimo',
  'xinference', 'zenmux', 'zeroone', 'zhipu',
]);
