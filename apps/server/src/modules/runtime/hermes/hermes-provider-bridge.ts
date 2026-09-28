/** Фиксированная категория SecretStore для ключа provider, используемого Hermes. */
export const HERMES_PROVIDER_SECRET_SERVICE = "hermes-provider";
/** Единственное имя environment variable, передаваемое provider API key в Hermes. */
export const HERMES_PROVIDER_SECRET_ENV = "EBB_HERMES_PROVIDER_API_KEY";

export interface HermesProviderBridgeConfig {
  /** HTTPS endpoint provider; loopback HTTP разрешён только для local development. */
  baseUrl: string;
  /** Имя секрета в фиксированной категории `hermes-provider`. */
  secretName: string;
}

export interface HermesProviderBridgeEnvironment {
  /** Публичный non-secret URL OpenAI-compatible provider API. */
  EBB_HERMES_PROVIDER_BASE_URL?: string;
  /** Имя provider key в SecretStore, без plaintext значения. */
  EBB_HERMES_PROVIDER_SECRET_NAME?: string;
}

/**
 * Проверяет non-secret параметры provider bridge из production environment.
 *
 * Endpoint и SecretStore name задаются вместе. Сам ключ остаётся в SecretStore
 * и разрешается только перед run; startup не копирует provider credentials.
 */
export function resolveHermesProviderBridgeConfig(
  env: HermesProviderBridgeEnvironment,
): HermesProviderBridgeConfig | undefined {
  const baseUrl = env.EBB_HERMES_PROVIDER_BASE_URL?.trim();
  const secretName = env.EBB_HERMES_PROVIDER_SECRET_NAME?.trim();
  if (!baseUrl && !secretName) return undefined;
  if (!baseUrl || !secretName) throw new Error("Hermes provider bridge configuration is incomplete");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(secretName)) {
    throw new Error("Hermes provider secret name is invalid");
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Hermes provider base URL is invalid");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
    throw new Error("Hermes provider base URL must use HTTPS or loopback HTTP without embedded credentials");
  }
  return { baseUrl: parsed.toString().replace(/\/$/, ""), secretName };
}
