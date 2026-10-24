/* global Buffer */

// plan-26 Task5: GitHub adapter (authoritative repo/refs/releases/assets/checks).
// Pure adapter: validated repository/policy -> RemoteInventory slice; typed
// request identity -> provider response/reconciliation; wrong tag/Release
// asset hashes detected; immutable Release tag refusal detected; permission/
// ownership checks before any operation. Full pagination loops per_page until
// exhausted; missing/overlapping IDs in paging -> typed error. Credentials are
// injected from approved runtime environment (token passed by the caller),
// never written to output/journal and sanitized out of error messages.
// No real network calls here: all HTTP goes through the injected `request` —
// tests use mocked fixtures; live verification happens in Task11.

import { createHash } from 'node:crypto';
import { canonicalJson } from './policy.mjs';

export const GITHUB_CODES = Object.freeze({
  REPOSITORY_MISMATCH: 'GITHUB_REPOSITORY_MISMATCH',
  OWNER_MISMATCH: 'GITHUB_OWNER_MISMATCH',
  NOT_FOUND: 'GITHUB_NOT_FOUND',
  PERMISSION_DENIED: 'GITHUB_PERMISSION_DENIED',
  RATE_LIMITED: 'GITHUB_RATE_LIMITED',
  PAGING_MISSING_IDS: 'GITHUB_PAGING_MISSING_IDS',
  PAGING_UNEXPECTED_END: 'GITHUB_PAGING_UNEXPECTED_END',
  RELEASE_ASSET_HASH_MISMATCH: 'GITHUB_RELEASE_ASSET_HASH_MISMATCH',
  ASSET_HASH_UNAVAILABLE: 'GITHUB_ASSET_HASH_UNAVAILABLE',
  IMMUTABLE_RELEASE_TAG: 'GITHUB_IMMUTABLE_RELEASE_TAG',
  STALE_INVENTORY: 'GITHUB_STALE_INVENTORY',
  AMBIGUOUS_RESPONSE: 'GITHUB_AMBIGUOUS_RESPONSE',
  API_ERROR: 'GITHUB_API_ERROR',
});

const DEFAULT_PER_PAGE = 100;
const MAX_PAGES = 100;

export class GithubError extends Error {
  constructor(code, message, { field, status } = {}) {
    super(message);
    this.name = 'GithubError';
    this.code = code;
    if (field !== undefined) this.field = field;
    if (status !== undefined) this.status = status;
  }
}

export function createGithubAdapter({ request, baseUrl, token }) {
  if (typeof request !== 'function') {
    throw new GithubError(GITHUB_CODES.API_ERROR, 'github adapter requires an injected request function');
  }
  const apiBaseUrl = baseUrl ?? 'https://api.github.com';
  const authToken = typeof token === 'string' && token.length > 0 ? token : null;

  function sanitize(message) {
    let text = String(message);
    if (authToken) text = text.split(authToken).join('<redacted>');
    return text;
  }

  async function raw(url, { method = 'GET', headers = {}, accept, octetStream = false } = {}) {
    const finalHeaders = { ...headers };
    if (authToken && !finalHeaders.Authorization) finalHeaders.Authorization = `Bearer ${authToken}`;
    if (accept) finalHeaders.Accept = accept;
    let res;
    try {
      res = await request(url, { method, headers: finalHeaders });
    } catch (error) {
      throw new GithubError(GITHUB_CODES.API_ERROR, sanitize(`GitHub request failed: ${error?.message ?? error}`));
    }
    const status = typeof res?.status === 'number' ? res.status : 0;
    const headerGet = typeof res?.headers?.get === 'function' ? res.headers.get.bind(res.headers) : () => null;
    if (octetStream) {
      const buffer = await res.arrayBuffer().catch(() => null);
      return { status, headers: { get: headerGet }, body: buffer ? Buffer.from(buffer) : null };
    }
    return { status, headers: { get: headerGet }, body: await res.json().catch(() => null) };
  }

  function mapHttpError({ status, headers, path }) {
    if (status === 401 || status === 403) {
      if (status === 403 && Number(headers.get('x-ratelimit-remaining')) === 0) {
        return new GithubError(GITHUB_CODES.RATE_LIMITED, `rate limited by GitHub API (${path})`, { status });
      }
      return new GithubError(GITHUB_CODES.PERMISSION_DENIED, `permission denied by GitHub API (${path})`, { status });
    }
    if (status === 404) return new GithubError(GITHUB_CODES.NOT_FOUND, `not found on GitHub API (${path})`, { status });
    return new GithubError(GITHUB_CODES.API_ERROR, `GitHub API request failed with status ${status} (${path})`, { status });
  }

  function nextLink(headers) {
    const link = headers.get('link');
    if (!link) return null;
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  }

  async function paginate(path, { idKey = 'id' } = {}) {
    const separator = path.includes('?') ? '&' : '?';
    let url = `${apiBaseUrl}${path}${separator}per_page=${DEFAULT_PER_PAGE}`;
    const items = [];
    let lastId = null;
    let pages = 0;
    while (url && pages < MAX_PAGES) {
      const { status, headers, body } = await raw(url);
      if (status !== 200) throw mapHttpError({ status, headers, path: url });
      if (!Array.isArray(body)) {
        throw new GithubError(GITHUB_CODES.AMBIGUOUS_RESPONSE, `expected an array response from GitHub API (${url})`);
      }
      if (idKey && lastId !== null) {
        for (const item of body) {
          const id = item?.[idKey];
          if ((typeof id === 'number' || typeof id === 'string') && id <= lastId) {
            throw new GithubError(
              GITHUB_CODES.PAGING_MISSING_IDS,
              `paged response at ${url} contains ${idKey} ${id} at/before the previous page tail ${lastId}`,
            );
          }
        }
      }
      if (idKey && body.length > 0) lastId = body[body.length - 1][idKey];
      items.push(...body);
      pages += 1;
      if (body.length < DEFAULT_PER_PAGE) break;
      url = nextLink(headers);
    }
    if (pages >= MAX_PAGES) {
      throw new GithubError(GITHUB_CODES.PAGING_UNEXPECTED_END, `pagination did not terminate at ${path}`);
    }
    return items;
  }

  async function fetchReleaseByTag({ owner, repo, tag }) {
    const path = `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
    const { status, headers, body } = await raw(`${apiBaseUrl}${path}`);
    if (status === 404) return null;
    if (status !== 200) throw mapHttpError({ status, headers, path });
    if (!body || typeof body !== 'object') {
      throw new GithubError(GITHUB_CODES.AMBIGUOUS_RESPONSE, 'release response is not an object');
    }
    return body;
  }

  return {
    fetchRepository: async ({ policy }) => {
      const repositoryPolicy = policy?.repository;
      if (!repositoryPolicy || typeof repositoryPolicy !== 'object') {
        throw new GithubError(GITHUB_CODES.API_ERROR, 'fetchRepository requires a validated policy.repository');
      }
      const path = `/repos/${repositoryPolicy.owner}/${repositoryPolicy.name}`;
      const { status, headers, body } = await raw(`${apiBaseUrl}${path}`);
      if (status !== 200) throw mapHttpError({ status, headers, path });
      if (!body || typeof body !== 'object') {
        throw new GithubError(GITHUB_CODES.AMBIGUOUS_RESPONSE, 'repository response is not an object');
      }
      if (body.id !== repositoryPolicy.id) {
        throw new GithubError(GITHUB_CODES.REPOSITORY_MISMATCH, `repository id ${body.id} does not match policy id ${repositoryPolicy.id}`, { field: 'repository.id' });
      }
      if (body.name !== repositoryPolicy.name) {
        throw new GithubError(GITHUB_CODES.REPOSITORY_MISMATCH, `repository name ${body.name} does not match policy name ${repositoryPolicy.name}`, { field: 'repository.name' });
      }
      if (body.owner?.login !== repositoryPolicy.owner) {
        throw new GithubError(GITHUB_CODES.OWNER_MISMATCH, `repository owner ${body.owner?.login} does not match policy owner ${repositoryPolicy.owner}`, { field: 'repository.owner' });
      }
      const canPush = body.permissions?.push === true;
      if (!canPush) {
        throw new GithubError(GITHUB_CODES.PERMISSION_DENIED, `token lacks push permission on ${repositoryPolicy.owner}/${repositoryPolicy.name}`);
      }
      return {
        repositoryId: body.id,
        owner: body.owner.login,
        name: body.name,
        visibility: body.visibility ?? (body.private ? 'private' : 'public'),
        defaultBranch: body.default_branch,
        htmlUrl: body.html_url,
        canPush,
        repository: body,
      };
    },

    fetchRefs: async ({ owner, repo }) => {
      const refs = await paginate(`/repos/${owner}/${repo}/git/matching-refs/refs/heads/develop`, { idKey: null });
      return refs.map(({ ref, object }) => ({ ref, sha: object?.sha ?? null }));
    },

    fetchReleases: async ({ owner, repo }) => {
      const releases = await paginate(`/repos/${owner}/${repo}/releases`);
      for (const release of releases) {
        release.assets = await paginate(`/repos/${owner}/${repo}/releases/${release.id}/assets`);
      }
      return releases;
    },

    fetchReleaseByTag,

    hasImmutableReleaseForTag: async ({ owner, repo, tag }) => {
      const release = await fetchReleaseByTag({ owner, repo, tag });
      return release !== null;
    },

    guardTagRemovable: async ({ owner, repo, tag }) => {
      const release = await fetchReleaseByTag({ owner, repo, tag });
      if (release) {
        throw new GithubError(
          GITHUB_CODES.IMMUTABLE_RELEASE_TAG,
          `Release ${release.id} exists for tag ${tag}; the tag cannot be mutated while the Release exists`,
          { field: 'tag' },
        );
      }
      return { tag, removable: true };
    },

    verifyReleaseAssetHash: async ({ asset, expectedSha256 }) => {
      const { status, body } = await raw(asset.url, { accept: 'application/octet-stream', octetStream: true });
      if (status !== 200 || !body) {
        throw new GithubError(GITHUB_CODES.ASSET_HASH_UNAVAILABLE, `asset ${asset.name} download failed with status ${status}`, { field: 'assets' });
      }
      const actual = createHash('sha256').update(body).digest('hex');
      if (actual !== String(expectedSha256).toLowerCase()) {
        throw new GithubError(
          GITHUB_CODES.RELEASE_ASSET_HASH_MISMATCH,
          `asset ${asset.name} sha256 ${actual} does not match expected ${String(expectedSha256).toLowerCase()}`,
          { field: 'assets' },
        );
      }
      return { assetId: asset.id, sha256: actual };
    },

    guardFreshInventory: ({ observedAt, maxAgeMs, now }) => {
      const at = Date.parse(observedAt);
      const reference = now ?? Date.now();
      if (Number.isNaN(at) || reference - at > maxAgeMs) {
        throw new GithubError(GITHUB_CODES.STALE_INVENTORY, 'inventory is stale; refresh provider readback before any operation', { field: 'inventory' });
      }
      return { fresh: true, observedAt: new Date(at).toISOString() };
    },

    buildInventory: ({ repository, refs, releases, now }) => ({
      repositoryId: repository.repositoryId,
      refs,
      releases,
      assets: releases.flatMap((release) => release.assets ?? []),
      ownership: { owner: repository.owner, visibility: repository.visibility, canPush: repository.canPush },
      observedAt: now ?? new Date().toISOString(),
    }),

    mapErrorToReport: (error) => {
      const typed = error instanceof GithubError;
      const code = typed ? error.code : GITHUB_CODES.API_ERROR;
      const message = sanitize(error instanceof Error ? error.message : String(error));
      const report = { code, message };
      if (typed && error.field !== undefined) report.field = error.field;
      return report;
    },
  };
}

export function inventoryHashOf(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export { canonicalJson };
