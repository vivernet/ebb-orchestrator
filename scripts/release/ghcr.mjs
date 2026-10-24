/* global Buffer, URL, URLSearchParams */

// plan-26 Task5: GHCR adapter (OCI registry token flow, manifest/version/
// digest parsing, ownership/public readback, deletion eligibility).
// Requests are built and responses parsed here; live registry verification
// happens in Task11. Mocks only in tests. Credentials are injected from
// approved runtime environment and never written to output/journal; tokens
// are sanitized out of error messages. No implicit repository visibility
// changes: a non-public package is a BLOCKED eligibility outcome, never a
// visibility mutation.

import { createHash } from 'node:crypto';
import { canonicalJson } from './policy.mjs';

export const GHCR_CODES = Object.freeze({
  TOKEN_UNAVAILABLE: 'GHCR_TOKEN_UNAVAILABLE',
  AUTH_FAILED: 'GHCR_AUTH_FAILED',
  NOT_FOUND: 'GHCR_NOT_FOUND',
  PRIVATE_IMAGE: 'GHCR_PRIVATE_IMAGE',
  UNKNOWN_PACKAGE_OWNER: 'GHCR_UNKNOWN_PACKAGE_OWNER',
  PERMISSION_DENIED: 'GHCR_PERMISSION_DENIED',
  NOT_PUBLIC: 'GHCR_NOT_PUBLIC',
  SERVER_REFUSAL: 'GHCR_SERVER_REFUSAL',
  PAGING_MISSING_IDS: 'GHCR_PAGING_MISSING_IDS',
  PAGING_UNEXPECTED_END: 'GHCR_PAGING_UNEXPECTED_END',
  AMBIGUOUS_SHARED_MANIFEST: 'GHCR_AMBIGUOUS_SHARED_MANIFEST',
  DOWNLOAD_RESTRICTION: 'GHCR_DOWNLOAD_RESTRICTION',
  ELIGIBILITY_UNKNOWN: 'GHCR_ELIGIBILITY_UNKNOWN',
  WRONG_VERSION_LABEL: 'GHCR_WRONG_VERSION_LABEL',
  WRONG_SOURCE_LABEL: 'GHCR_WRONG_SOURCE_LABEL',
  METADATA_MISSING: 'GHCR_METADATA_MISSING',
  UNKNOWN_TARGET_VERSION: 'GHCR_UNKNOWN_TARGET_VERSION',
  AMBIGUOUS_RESPONSE: 'GHCR_AMBIGUOUS_RESPONSE',
  API_ERROR: 'GHCR_API_ERROR',
});

export const GHCR_MEDIA = Object.freeze({
  DOCKER_MANIFEST_LIST: 'application/vnd.docker.distribution.manifest.list.v2+json',
  OCI_IMAGE_INDEX: 'application/vnd.oci.image.index.v1+json',
  DOCKER_MANIFEST: 'application/vnd.docker.distribution.manifest.v2+json',
  OCI_IMAGE_MANIFEST: 'application/vnd.oci.image.manifest.v1+json',
  DOCKER_CONFIG: 'application/vnd.docker.container.image.v1+json',
  OCI_CONFIG: 'application/vnd.oci.image.config.v1+json',
});

const LIST_MEDIA_TYPES = new Set([GHCR_MEDIA.DOCKER_MANIFEST_LIST, GHCR_MEDIA.OCI_IMAGE_INDEX]);
const SINGLE_MEDIA_TYPES = new Set([GHCR_MEDIA.DOCKER_MANIFEST, GHCR_MEDIA.OCI_IMAGE_MANIFEST]);
const DEFAULT_PER_PAGE = 100;
const MAX_PAGES = 100;
const DEFAULT_DOWNLOAD_RESTRICTION = 5000;

export class GhcrError extends Error {
  constructor(code, message, { field, status } = {}) {
    super(message);
    this.name = 'GhcrError';
    this.code = code;
    if (field !== undefined) this.field = field;
    if (status !== undefined) this.status = status;
  }
}

export function isListMediaType(mediaType) {
  return typeof mediaType === 'string' && LIST_MEDIA_TYPES.has(mediaType);
}

export function createGhcrAdapter({ request, registryUrl, apiBaseUrl, token }) {
  if (typeof request !== 'function') {
    throw new GhcrError(GHCR_CODES.API_ERROR, 'ghcr adapter requires an injected request function');
  }
  const registryBaseUrl = registryUrl ?? 'https://ghcr.io';
  const apiBase = apiBaseUrl ?? 'https://api.github.com';
  const githubToken = typeof token === 'string' && token.length > 0 ? token : null;

  let registryToken = null;
  let registryTokenExpiry = 0;

  function sanitize(message) {
    let text = String(message);
    if (githubToken) text = text.split(githubToken).join('<redacted>');
    if (registryToken) text = text.split(registryToken).join('<redacted>');
    return text;
  }

  async function rawBase(baseUrl, path, { method = 'GET', headers = {}, octetStream = false } = {}) {
    let res;
    try {
      res = await request(`${baseUrl}${path}`, { method, headers });
    } catch (error) {
      throw new GhcrError(GHCR_CODES.API_ERROR, sanitize(`HTTP request failed: ${error?.message ?? error}`));
    }
    const status = typeof res?.status === 'number' ? res.status : 0;
    const headerGet = typeof res?.headers?.get === 'function' ? res.headers.get.bind(res.headers) : () => null;
    if (octetStream) {
      const buffer = await res.arrayBuffer().catch(() => null);
      return { status, headers: { get: headerGet }, body: buffer ? Buffer.from(buffer) : null };
    }
    return { status, headers: { get: headerGet }, body: await res.json().catch(() => null) };
  }

  async function apiRequest(relPath, { method = 'GET', accept } = {}) {
    const headers = {};
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
    if (accept) headers.Accept = accept;
    const { status, headers: responseHeaders, body } = await rawBase(apiBase, relPath, { method, headers });
    return { status, headers: responseHeaders, body };
  }

  async function ensureRegistryToken(scopes) {
    if (registryToken && Date.now() < registryTokenExpiry) return registryToken;
    const host = new URL(registryBaseUrl).host;
    const qs = new URLSearchParams({ service: host });
    for (const scope of scopes) qs.append('scope', scope);
    const headers = {};
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
    const { status, body } = await rawBase(registryBaseUrl, `/token?${qs}`, { headers });
    if (status === 401 || status === 403) {
      throw new GhcrError(GHCR_CODES.AUTH_FAILED, 'registry token exchange refused by provider', { status });
    }
    if (status !== 200 || !body || typeof body.token !== 'string' || body.token.length === 0) {
      throw new GhcrError(GHCR_CODES.TOKEN_UNAVAILABLE, 'registry token response did not include a usable token', { status });
    }
    registryToken = body.token;
    const expiresIn = Number.isInteger(body.expires_in) && body.expires_in > 0 ? body.expires_in : 300;
    registryTokenExpiry = Date.now() + Math.max(60, expiresIn - 30) * 1000;
    return registryToken;
  }

  async function registryRequest(relPath, { method = 'GET', accept, scopes, octetStream = false } = {}) {
    const scopesRequired = scopes ?? [`repository:pull`];
    let attempts = 0;
    for (;;) {
      const token = await ensureRegistryToken(scopesRequired);
      const headers = { Authorization: `Bearer ${token}` };
      if (accept) headers.Accept = accept;
      const { status, headers: responseHeaders, body } = await rawBase(registryBaseUrl, relPath, { method, headers, octetStream });
      if (status === 401 && attempts === 0) {
        attempts += 1;
        registryToken = null;
        registryTokenExpiry = 0;
        continue;
      }
      if (status === 401) {
        throw new GhcrError(GHCR_CODES.AUTH_FAILED, 'registry authentication failed after token refresh', { status });
      }
      return { status, headers: responseHeaders, body };
    }
  }

  async function manifestInfo({ owner, name, reference, scopes }) {
    const accept = `${GHCR_MEDIA.DOCKER_MANIFEST_LIST}, ${GHCR_MEDIA.OCI_IMAGE_INDEX}, ${GHCR_MEDIA.DOCKER_MANIFEST}, ${GHCR_MEDIA.OCI_IMAGE_MANIFEST}`;
    const scopesRequired = scopes ?? [`repository:${owner}/${name}:pull`];
    const { status, headers, body } = await registryRequest(`/v2/${owner}/${name}/manifests/${encodeURIComponent(reference)}`, {
      accept,
      scopes: scopesRequired,
    });
    if (status === 404) return null;
    if (status !== 200) {
      throw new GhcrError(GHCR_CODES.API_ERROR, `manifest fetch for ${reference} failed with status ${status}`, { status });
    }
    const digest = headers.get('docker-content-digest');
    if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new GhcrError(GHCR_CODES.AMBIGUOUS_RESPONSE, `manifest ${reference} response has no canonical sha256 digest`);
    }
    return { digest, mediaType: body?.mediaType ?? headers.get('content-type'), body };
  }

  function buildDeletionActions({ owner, name, graphs, targets }) {
    const byVersion = new Map(graphs.map((graph) => [graph.version, graph]));
    const actions = [];
    for (const target of targets) {
      const graph = byVersion.get(target);
      if (!graph) {
        throw new GhcrError(GHCR_CODES.UNKNOWN_TARGET_VERSION, `target version ${target} is not in the inventory graphs`);
      }
      actions.push({
        kind: 'delete-manifest',
        owner,
        packageName: name,
        version: graph.version,
        tag: graph.tag,
        digest: graph.topDigest,
        reference: graph.topDigest,
      });
    }
    return actions;
  }

  async function executeDeletion(action) {
    const { status } = await registryRequest(`/v2/${action.owner}/${action.packageName}/manifests/${action.digest}`, {
      method: 'DELETE',
      scopes: [`repository:${action.owner}/${action.packageName}:delete`],
    });
    if (status === 202 || status === 204) return { ok: true, status: 'deleted', version: action.version };
    if (status === 404) return { ok: true, status: 'already-absent', version: action.version };
    if (status === 401 || status === 403) {
      throw new GhcrError(GHCR_CODES.PERMISSION_DENIED, `registry refused deletion of ${action.version} (${status})`, { status });
    }
    throw new GhcrError(GHCR_CODES.SERVER_REFUSAL, `registry deletion server refusal for ${action.version} (${status})`, { status });
  }

  return {
    getRegistryToken: ({ scopes }) => ensureRegistryToken(scopes),

    inventoryTags: async ({ owner, name }) => {
      const tags = [];
      let last = null;
      let pages = 0;
      while (pages < MAX_PAGES) {
        const qs = new URLSearchParams({ n: String(DEFAULT_PER_PAGE) });
        if (last !== null) qs.set('last', last);
        const { status, body } = await registryRequest(`/v2/${owner}/${name}/tags/list?${qs}`, {
          scopes: [`repository:${owner}/${name}:pull`],
        });
        if (status === 404) {
          throw new GhcrError(GHCR_CODES.NOT_FOUND, `image ${owner}/${name} not found in registry`, { status });
        }
        if (status !== 200) {
          throw new GhcrError(GHCR_CODES.API_ERROR, `registry tags list failed with status ${status}`, { status });
        }
        const list = body?.tags;
        if (!Array.isArray(list)) {
          throw new GhcrError(GHCR_CODES.AMBIGUOUS_RESPONSE, 'registry tags list response is missing the tags array');
        }
        if (list.length > 0) {
          if (last !== null && list[0] <= last) {
            throw new GhcrError(GHCR_CODES.PAGING_MISSING_IDS, `tags paging discontinuity: ${list[0]} after ${last}`);
          }
          last = list[list.length - 1];
          tags.push(...list);
        }
        pages += 1;
        if (list.length < DEFAULT_PER_PAGE) break;
      }
      if (pages >= MAX_PAGES) {
        throw new GhcrError(GHCR_CODES.PAGING_UNEXPECTED_END, 'tags pagination did not terminate');
      }
      return tags;
    },

    manifestInfo,

    resolveVersionGraph: async ({ owner, name, reference, scopes }) => {
      const info = await manifestInfo({ owner, name, reference, scopes });
      if (!info) throw new GhcrError(GHCR_CODES.NOT_FOUND, `manifest ${reference} not found in registry`);
      if (isListMediaType(info.mediaType)) {
        const { manifests } = parseManifestList(info.body);
        const children = [];
        for (const child of manifests) {
          const childInfo = await manifestInfo({ owner, name, reference: child.digest, scopes });
          if (!childInfo) {
            throw new GhcrError(GHCR_CODES.AMBIGUOUS_RESPONSE, `child manifest ${child.digest} of ${reference} is unreadable`);
          }
          const parsed = parseImageManifest(childInfo.body);
          children.push({ digest: child.digest, mediaType: child.mediaType, platform: child.platform, config: parsed.config });
        }
        return { top: { reference, digest: info.digest, mediaType: info.mediaType }, children };
      }
      const parsed = parseImageManifest(info.body);
      return {
        top: { reference, digest: info.digest, mediaType: info.mediaType },
        children: [{ digest: info.digest, mediaType: info.mediaType, platform: null, config: parsed.config }],
      };
    },

    fetchConfig: async ({ owner, name, digest, scopes }) => {
      const { status, body } = await registryRequest(`/v2/${owner}/${name}/blobs/${digest}`, {
        scopes: scopes ?? [`repository:${owner}/${name}:pull`],
      });
      if (status !== 200 || !body || typeof body !== 'object') {
        throw new GhcrError(GHCR_CODES.API_ERROR, `config blob ${digest} fetch failed with status ${status}`, { status });
      }
      return body;
    },

    validateSourceLabels: ({ labels, version, sourceSha, sourceUrl }) => {
      const imageVersion = labels?.['org.opencontainers.image.version'];
      const revision = labels?.['org.opencontainers.image.revision'];
      const source = labels?.['org.opencontainers.image.source'];
      if (typeof imageVersion !== 'string' || imageVersion.length === 0) {
        throw new GhcrError(GHCR_CODES.METADATA_MISSING, 'image version label missing (org.opencontainers.image.version)', { field: 'labels' });
      }
      if (imageVersion !== version) {
        throw new GhcrError(GHCR_CODES.WRONG_VERSION_LABEL, `image version label ${imageVersion} does not match target version ${version}`, { field: 'labels' });
      }
      if (typeof revision !== 'string' || revision.length === 0 || typeof source !== 'string' || source.length === 0) {
        throw new GhcrError(GHCR_CODES.METADATA_MISSING, 'image source/revision labels missing (org.opencontainers.image.revision/source)', { field: 'labels' });
      }
      if (revision !== sourceSha) {
        throw new GhcrError(GHCR_CODES.WRONG_SOURCE_LABEL, `image revision label does not match pinned source SHA`, { field: 'labels' });
      }
      if (source !== sourceUrl && !source.startsWith(sourceUrl)) {
        throw new GhcrError(GHCR_CODES.WRONG_SOURCE_LABEL, `image source label ${source} does not match source URL ${sourceUrl}`, { field: 'labels' });
      }
      return { imageVersion, revision, source };
    },

    readPackage: async ({ owner, name }) => {
      const { status, body } = await apiRequest(`/repos/${owner}/${name}/packages/container/${name}`);
      if (status === 404) throw new GhcrError(GHCR_CODES.NOT_FOUND, `package ${owner}/${name} not found via REST API`, { status });
      if (status === 401 || status === 403) {
        throw new GhcrError(GHCR_CODES.PERMISSION_DENIED, `token lacks access to package ${owner}/${name}`, { status });
      }
      if (status !== 200 || !body || typeof body !== 'object') {
        throw new GhcrError(GHCR_CODES.API_ERROR, `package read failed with status ${status}`, { status });
      }
      if (body.owner?.login !== owner) {
        throw new GhcrError(GHCR_CODES.UNKNOWN_PACKAGE_OWNER, `package owner ${body.owner?.login} is not ${owner}`, { field: 'owner' });
      }
      if (body.visibility !== 'public') {
        throw new GhcrError(GHCR_CODES.NOT_PUBLIC, `package ${owner}/${name} is not public (${body.visibility}); repository/package visibility is never changed implicitly`);
      }
      return {
        id: body.id,
        owner: body.owner.login,
        name: body.name,
        visibility: body.visibility,
        htmlUrl: body.html_url,
        createdAt: body.created_at,
        updatedAt: body.updated_at,
      };
    },

    inferOwnership: ({ pkg, expectedOwner }) => ({ owner: pkg.owner, owned: pkg.owner === expectedOwner }),

    listPackageVersions: async ({ owner, name }) => {
      const { status, body } = await apiRequest(`/user/packages/container/${name}/versions`);
      if (status === 404) throw new GhcrError(GHCR_CODES.NOT_FOUND, `package versions for ${owner}/${name} not found`, { status });
      if (status === 401 || status === 403) {
        throw new GhcrError(GHCR_CODES.PERMISSION_DENIED, `token lacks read:packages for ${owner}/${name}`, { status });
      }
      if (status !== 200 || !Array.isArray(body)) {
        throw new GhcrError(GHCR_CODES.AMBIGUOUS_RESPONSE, `package versions response is not an array (status ${status})`);
      }
      return body.map((version) => ({
        id: version.id,
        name: version.name,
        tags: version.metadata?.container?.tags ?? [],
        url: version.url,
        htmlUrl: version.html_url,
        createdAt: version.created_at,
        updatedAt: version.updated_at,
        // The documented Packages REST version response carries no download_count;
        // eligibility must be disclosed as uncertainty unless a validated count
        // is supplied externally (e.g. GitHub Support). Never invented here.
        downloadCount: null,
        metadata: version.metadata ?? {},
      }));
    },

    sharedManifestAmbiguity: ({ graphs, targetVersion }) => {
      const target = graphs.find((graph) => graph.version === targetVersion);
      if (!target) {
        throw new GhcrError(GHCR_CODES.UNKNOWN_TARGET_VERSION, `target version ${targetVersion} is not in the inventory`);
      }
      for (const graph of graphs) {
        if (graph.version === targetVersion) continue;
        if (graph.topDigest === target.topDigest) {
          return {
            ambiguous: true,
            code: GHCR_CODES.AMBIGUOUS_SHARED_MANIFEST,
            detail: `top manifest digest ${target.topDigest} is shared with version ${graph.version}; deleting it would destroy a surviving publication`,
          };
        }
      }
      // Child/manifest-list children are physical deduplicated blobs; they are
      // retained for surviving owners and are not the deleted version identity.
      return { ambiguous: false, code: null, detail: null };
    },

    buildDeletionActions,

    executeDeletion,

    withdrawVersions: async ({ owner, name, graphs, targets }) => {
      const actions = buildDeletionActions({ owner, name, graphs, targets });
      const deleted = [];
      const remaining = [...targets];
      for (const action of actions) {
        try {
          const result = await executeDeletion(action);
          if (result.status === 'deleted' || result.status === 'already-absent') {
            deleted.push(action.version);
            remaining.splice(remaining.indexOf(action.version), 1);
          }
        } catch (error) {
          // Provider refusal / permission stops later steps; earlier confirmed
          // deletions yield PARTIAL with exact deleted/remaining identities.
          return {
            status: deleted.length > 0 ? 'PARTIAL' : 'BLOCKED',
            deleted,
            remaining,
            refusal: { code: error instanceof GhcrError ? error.code : GHCR_CODES.SERVER_REFUSAL, version: action.version },
          };
        }
      }
      return { status: 'OK', deleted, remaining, refusal: null };
    },

    buildInventory: ({ pkg, versions, graphs, now }) => ({
      packages: [{ id: pkg.id, name: pkg.name, visibility: pkg.visibility, owner: pkg.owner }],
      versions: versions.map((version) => ({ ...version, eligibility: deletionEligibility({ version }) })),
      ociObjects: graphs.map((graph) => ({
        version: graph.version,
        tag: graph.tag,
        topDigest: graph.topDigest,
        childDigests: graph.childDigests,
      })),
      ownership: { owner: pkg.owner, owned: true, public: pkg.visibility === 'public' },
      observedAt: now ?? new Date().toISOString(),
    }),

    mapErrorToReport: (error) => {
      const typed = error instanceof GhcrError;
      const code = typed ? error.code : GHCR_CODES.API_ERROR;
      const message = sanitize(error instanceof Error ? error.message : String(error));
      const report = { code, message };
      if (typed && error.field !== undefined) report.field = error.field;
      return report;
    },
  };
}

export function parseManifestList(body) {
  if (!body || typeof body !== 'object') {
    throw new GhcrError(GHCR_CODES.AMBIGUOUS_RESPONSE, 'manifest list body is not an object');
  }
  if (!isListMediaType(body.mediaType)) {
    throw new GhcrError(GHCR_CODES.AMBIGUOUS_RESPONSE, `unexpected manifest mediaType ${body.mediaType}`);
  }
  if (!Array.isArray(body.manifests)) {
    throw new GhcrError(GHCR_CODES.AMBIGUOUS_RESPONSE, 'manifest list body has no manifests array');
  }
  return {
    mediaType: body.mediaType,
    manifests: body.manifests.map((child) => ({
      digest: child.digest,
      mediaType: child.mediaType,
      platform: child.platform ?? null,
    })),
  };
}

export function parseImageManifest(body) {
  if (!body || typeof body !== 'object') {
    throw new GhcrError(GHCR_CODES.AMBIGUOUS_RESPONSE, 'image manifest body is not an object');
  }
  if (!SINGLE_MEDIA_TYPES.has(body.mediaType)) {
    throw new GhcrError(GHCR_CODES.AMBIGUOUS_RESPONSE, `unexpected image manifest mediaType ${body.mediaType}`);
  }
  if (!body.config || typeof body.config.digest !== 'string' || !Array.isArray(body.layers)) {
    throw new GhcrError(GHCR_CODES.AMBIGUOUS_RESPONSE, 'image manifest body lacks config/layers');
  }
  return {
    mediaType: body.mediaType,
    config: { digest: body.config.digest, mediaType: body.config.mediaType },
    layers: body.layers.map((layer) => ({ digest: layer.digest, mediaType: layer.mediaType })),
  };
}

export function parseConfigLabels(configBlob) {
  if (!configBlob || typeof configBlob !== 'object') {
    throw new GhcrError(GHCR_CODES.METADATA_MISSING, 'config blob is not an object');
  }
  const labels = configBlob.config?.Labels ?? {};
  if (!labels || typeof labels !== 'object') {
    throw new GhcrError(GHCR_CODES.METADATA_MISSING, 'config blob has no labels object');
  }
  return {
    labels,
    imageVersion: labels['org.opencontainers.image.version'] ?? null,
    revision: labels['org.opencontainers.image.revision'] ?? null,
    source: labels['org.opencontainers.image.source'] ?? null,
    created: labels['org.opencontainers.image.created'] ?? configBlob.created ?? null,
  };
}

export function deletionEligibility({ version: _version, knownDownloadCount, restrictionThreshold }) {
  const threshold = restrictionThreshold ?? DEFAULT_DOWNLOAD_RESTRICTION;
  if (knownDownloadCount !== undefined && knownDownloadCount !== null) {
    if (!Number.isInteger(knownDownloadCount) || knownDownloadCount < 0) {
      throw new GhcrError(GHCR_CODES.API_ERROR, 'knownDownloadCount must be a non-negative integer');
    }
    if (knownDownloadCount > threshold) {
      return {
        eligible: false,
        uncertainty: false,
        count: knownDownloadCount,
        code: GHCR_CODES.DOWNLOAD_RESTRICTION,
        reason: `REQUIRES_GITHUB_SUPPORT (>${threshold} downloads)`,
      };
    }
    return { eligible: true, uncertainty: false, count: knownDownloadCount, code: null, reason: null };
  }
  return {
    eligible: false,
    uncertainty: true,
    count: null,
    code: GHCR_CODES.ELIGIBILITY_UNKNOWN,
    reason: 'DOWNLOAD_COUNT_UNAVAILABLE (Packages REST version response documents no download_count)',
  };
}

export function inventoryHashOf(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export { canonicalJson };
