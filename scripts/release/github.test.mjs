/* global Buffer */

// plan-26 Task5: GitHub adapter tests (test-first RED). Mocked HTTP fixtures
// only — no real network calls. Fixtures: repo/owner mismatch, paging missing
// IDs, stale inventory, wrong tag/Release asset hashes, immutable Release tag
// refusal, permission/ownership checks, ambiguous responses, typed errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createGithubAdapter,
  GITHUB_CODES,
  GithubError,
  inventoryHashOf,
} from './github.mjs';

const BASE = 'https://api.github.com';
const TOKEN = 'ghp_secr3t_test_token';

const REPO = {
  id: 1372710981,
  name: 'ebb-orchestrator',
  full_name: 'vivernet/ebb-orchestrator',
  owner: { login: 'vivernet' },
  visibility: 'public',
  private: false,
  default_branch: 'develop',
  permissions: { admin: false, push: true, pull: true },
  html_url: 'https://github.com/vivernet/ebb-orchestrator',
};

function policyWith(overrides = {}) {
  return {
    repository: {
      id: 1372710981,
      owner: 'vivernet',
      name: 'ebb-orchestrator',
      remote: 'https://github.com/vivernet/ebb-orchestrator.git',
      defaultBranch: 'develop',
      releaseBranch: 'refs/heads/master',
      ...overrides,
    },
  };
}

class FakeResponse {
  constructor(status, body, { headers = {}, buffer } = {}) {
    this.status = status;
    this._body = body;
    this._headers = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
    );
    this._buffer = buffer;
  }

  get headers() {
    return { get: (name) => this._headers[String(name).toLowerCase()] ?? null };
  }

  async json() {
    return this._body;
  }

  async text() {
    return typeof this._body === 'string' ? this._body : JSON.stringify(this._body);
  }

  async arrayBuffer() {
    return this._buffer ?? Buffer.from(await this.text()).buffer;
  }
}

function makeFakeRequest(matcher) {
  const calls = [];
  const request = async (url, init = {}) => {
    calls.push({ url, init });
    const route = matcher(url, init);
    if (!route) throw new Error(`NO_ROUTE: ${url}`);
    if (route.error) throw route.error;
    return new FakeResponse(route.status, route.body, { headers: route.headers, buffer: route.buffer });
  };
  request.calls = calls;
  return request;
}

function makeAdapter(matcher, overrides = {}) {
  return createGithubAdapter({
    request: makeFakeRequest(matcher),
    baseUrl: BASE,
    token: TOKEN,
    ...overrides,
  });
}

function apiPath(url) {
  return url.startsWith(BASE) ? url.slice(BASE.length) : url;
}

function releaseBody(id, tag, { assets = [], target = 'develop' } = {}) {
  return {
    id,
    tag_name: tag,
    target_commitish: target,
    draft: false,
    prerelease: false,
    name: `Release ${tag}`,
    html_url: `https://github.com/vivernet/ebb-orchestrator/releases/tag/${tag}`,
    assets_url: `${BASE}/repos/vivernet/ebb-orchestrator/releases/${id}/assets`,
    assets,
  };
}

const RELEASE_1 = releaseBody(101, 'v1.2.3', {
  assets: [
    {
      id: 901,
      name: 'ebb-orchestrator-1.2.3.zip',
      url: `${BASE}/repos/vivernet/ebb-orchestrator/releases/assets/901`,
      browser_download_url: 'https://github.com/vivernet/ebb-orchestrator/releases/download/v1.2.3/ebb-orchestrator-1.2.3.zip',
      size: 42,
      content_type: 'application/zip',
    },
  ],
});
const RELEASE_2 = releaseBody(102, 'v1.2.2', { assets: [] });

function assetBuffer() {
  return Buffer.from('ebb asset payload 1.2.3');
}
function assetSha256() {
  return createHash('sha256').update(assetBuffer()).digest('hex');
}

function repoRouteMatcher(overrides = {}) {
  const routes = {
    [`^${BASE}/repos/vivernet/ebb-orchestrator$`]: () => ({ status: 200, body: REPO }),
    [`^${BASE}/repos/vivernet/ebb-orchestrator/git/matching-refs/refs/heads/develop`]: () => ({
      status: 200,
      body: [
        { ref: 'refs/heads/develop', object: { sha: '1111111111111111111111111111111111111111', type: 'commit' }, url: 'x' },
      ],
    }),
    [`^${BASE}/repos/vivernet/ebb-orchestrator/releases\\?per_page=`]: () => ({
      status: 200,
      body: [RELEASE_1, RELEASE_2],
    }),
    [`^${BASE}/repos/vivernet/ebb-orchestrator/releases/101/assets`]: () => ({
      status: 200,
      body: RELEASE_1.assets,
    }),
    [`^${BASE}/repos/vivernet/ebb-orchestrator/releases/102/assets`]: () => ({
      status: 200,
      body: [],
    }),
    [`^${BASE}/repos/vivernet/ebb-orchestrator/releases/assets/901$`]: () => ({
      status: 200,
      buffer: assetBuffer(),
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
    [`^${BASE}/repos/vivernet/ebb-orchestrator/releases/tags/v1\\.2\\.3$`]: () => ({ status: 404, body: {} }),
    ...overrides,
  };
  return (url) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (new RegExp(pattern).test(url)) return handler();
    }
    return null;
  };
}

test('fetchRepository returns exact repository identity when policy matches the API', async () => {
  const adapter = makeAdapter(repoRouteMatcher());
  const result = await adapter.fetchRepository({ policy: policyWith() });
  assert.equal(result.repositoryId, 1372710981);
  assert.equal(result.owner, 'vivernet');
  assert.equal(result.name, 'ebb-orchestrator');
  assert.equal(result.visibility, 'public');
  assert.equal(result.defaultBranch, 'develop');
  assert.equal(result.canPush, true);
});

test('fetchRepository rejects repository id mismatch with typed code', async () => {
  const adapter = makeAdapter(repoRouteMatcher());
  await assert.rejects(
    () => adapter.fetchRepository({ policy: policyWith({ id: 999999999 }) }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.REPOSITORY_MISMATCH,
  );
});

test('fetchRepository rejects owner mismatch (no invented/fake owner)', async () => {
  const adapter = makeAdapter((url) => {
    if (apiPath(url) === '/repos/vivernet/ebb-orchestrator') {
      return { status: 200, body: { ...REPO, owner: { login: 'mallory' }, full_name: 'mallory/ebb-orchestrator' } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.fetchRepository({ policy: policyWith() }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.OWNER_MISMATCH,
  );
});

test('fetchRepository maps 404 to NOT_FOUND', async () => {
  const adapter = makeAdapter((url) => {
    if (apiPath(url) === '/repos/vivernet/ebb-orchestrator') return { status: 404, body: { message: 'Not Found' } };
    return null;
  });
  await assert.rejects(
    () => adapter.fetchRepository({ policy: policyWith() }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.NOT_FOUND,
  );
});

test('fetchRepository maps missing push permission to PERMISSION_DENIED', async () => {
  const adapter = makeAdapter((url) => {
    if (apiPath(url) === '/repos/vivernet/ebb-orchestrator') {
      return { status: 200, body: { ...REPO, permissions: { admin: false, push: false, pull: true } } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.fetchRepository({ policy: policyWith() }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.PERMISSION_DENIED,
  );
});

test('fetchRepository maps rate-limit 403 with zero remaining to RATE_LIMITED', async () => {
  const adapter = makeAdapter((url) => {
    if (apiPath(url) === '/repos/vivernet/ebb-orchestrator') {
      return {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' },
      };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.fetchRepository({ policy: policyWith() }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.RATE_LIMITED,
  );
});

test('fetchReleases paginates fully and expands assets per release', async () => {
  const page1 = Array.from({ length: 100 }, (_, index) => releaseBody(1000 + index, `v0.0.${index}`, { assets: [] }));
  const page2 = [
    releaseBody(1100, 'v0.0.100', { assets: [RELEASE_1.assets[0]] }),
    releaseBody(1101, 'v0.0.101', { assets: [] }),
  ];
  const adapter = makeAdapter((url) => {
    const path = apiPath(url);
    if (path.startsWith('/repos/vivernet/ebb-orchestrator/releases?per_page=')) {
      if (path.includes('page=2')) {
        return { status: 200, body: page2 };
      }
      return {
        status: 200,
        body: page1,
        headers: { Link: `<${BASE}/repos/vivernet/ebb-orchestrator/releases?per_page=100&page=2>; rel="next"` },
      };
    }
    if (path.startsWith('/repos/vivernet/ebb-orchestrator/releases/') && path.includes('/assets')) {
      const id = Number(path.match(/releases\/(\d+)\/assets/)[1]);
      if (id === 1100) return { status: 200, body: [RELEASE_1.assets[0]] };
      return { status: 200, body: [] };
    }
    return null;
  });
  const releases = await adapter.fetchReleases({ owner: 'vivernet', repo: 'ebb-orchestrator' });
  assert.equal(releases.length, 102);
  assert.equal(releases[0].id, 1000);
  assert.equal(releases[101].id, 1101);
  const withAssets = releases.find((release) => release.id === 1100);
  assert.equal(withAssets.assets.length, 1);
  assert.equal(withAssets.assets[0].id, 901);
});

test('paging with missing/overlapping IDs raises PAGING_MISSING_IDS', async () => {
  const page1 = Array.from({ length: 100 }, (_, index) => releaseBody(1000 + index, `v0.0.${index}`, { assets: [] }));
  const page2 = [
    releaseBody(1050, 'v0.0.50', { assets: [] }), // id already seen in page 1 -> torn read
    releaseBody(1100, 'v0.0.100', { assets: [] }),
  ];
  const adapter = makeAdapter((url) => {
    const path = apiPath(url);
    if (path.startsWith('/repos/vivernet/ebb-orchestrator/releases?per_page=')) {
      if (path.includes('page=2')) return { status: 200, body: page2 };
      return {
        status: 200,
        body: page1,
        headers: { Link: `<${BASE}/repos/vivernet/ebb-orchestrator/releases?per_page=100&page=2>; rel="next"` },
      };
    }
    if (path.endsWith('/assets')) return { status: 200, body: [] };
    return null;
  });
  await assert.rejects(
    () => adapter.fetchReleases({ owner: 'vivernet', repo: 'ebb-orchestrator' }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.PAGING_MISSING_IDS,
  );
});

test('non-array paging response maps to AMBIGUOUS_RESPONSE', async () => {
  const adapter = makeAdapter((url) => {
    const path = apiPath(url);
    if (path.startsWith('/repos/vivernet/ebb-orchestrator/releases?per_page=')) {
      return { status: 200, body: { message: 'not an array' } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.fetchReleases({ owner: 'vivernet', repo: 'ebb-orchestrator' }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.AMBIGUOUS_RESPONSE,
  );
});

test('fetchRefs reads matching refs for develop', async () => {
  const adapter = makeAdapter(repoRouteMatcher());
  const refs = await adapter.fetchRefs({ owner: 'vivernet', repo: 'ebb-orchestrator' });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref, 'refs/heads/develop');
  assert.equal(refs[0].sha, '1111111111111111111111111111111111111111');
});

test('verifyReleaseAssetHash accepts the exact digest and rejects wrong hashes', async () => {
  const adapter = makeAdapter(repoRouteMatcher());
  const asset = RELEASE_1.assets[0];
  await adapter.verifyReleaseAssetHash({ asset, expectedSha256: assetSha256() });
  await assert.rejects(
    () => adapter.verifyReleaseAssetHash({ asset, expectedSha256: '0'.repeat(64) }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.RELEASE_ASSET_HASH_MISMATCH,
  );
});

test('verifyReleaseAssetHash maps unavailable asset download to ASSET_HASH_UNAVAILABLE', async () => {
  const adapter = makeAdapter((url) => {
    if (apiPath(url) === '/repos/vivernet/ebb-orchestrator/releases/assets/901') {
      return { status: 404, body: { message: 'Not Found' } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.verifyReleaseAssetHash({ asset: RELEASE_1.assets[0], expectedSha256: assetSha256() }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.ASSET_HASH_UNAVAILABLE,
  );
});

test('immutable Release tag refusal is detected before any tag/Release deletion', async () => {
  const adapter = makeAdapter((url) => {
    const path = apiPath(url);
    if (path === '/repos/vivernet/ebb-orchestrator/releases/tags/v1.2.3') {
      return { status: 200, body: releaseBody(101, 'v1.2.3') };
    }
    return null;
  });
  assert.equal(await adapter.hasImmutableReleaseForTag({ owner: 'vivernet', repo: 'ebb-orchestrator', tag: 'v1.2.3' }), true);
  await assert.rejects(
    () => adapter.guardTagRemovable({ owner: 'vivernet', repo: 'ebb-orchestrator', tag: 'v1.2.3' }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.IMMUTABLE_RELEASE_TAG,
  );
});

test('absent Release for a tag leaves the tag removable', async () => {
  const adapter = makeAdapter(repoRouteMatcher());
  assert.equal(await adapter.hasImmutableReleaseForTag({ owner: 'vivernet', repo: 'ebb-orchestrator', tag: 'v1.2.3' }), false);
  await adapter.guardTagRemovable({ owner: 'vivernet', repo: 'ebb-orchestrator', tag: 'v1.2.3' });
});

test('stale inventory is BLOCKED via guardFreshInventory', async () => {
  const adapter = makeAdapter(repoRouteMatcher());
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  const observedAt = new Date(now - 10 * 60 * 1000).toISOString();
  await assert.rejects(
    async () => adapter.guardFreshInventory({ observedAt, maxAgeMs: 5 * 60 * 1000, now }),
    (error) => error instanceof GithubError && error.code === GITHUB_CODES.STALE_INVENTORY,
  );
  await adapter.guardFreshInventory({ observedAt: new Date(now - 60 * 1000).toISOString(), maxAgeMs: 5 * 60 * 1000, now });
});

test('buildInventory produces a RemoteInventory slice with observedAt, assets and ownership', async () => {
  const adapter = makeAdapter(repoRouteMatcher());
  const repository = await adapter.fetchRepository({ policy: policyWith() });
  const refs = await adapter.fetchRefs({ owner: 'vivernet', repo: 'ebb-orchestrator' });
  const releases = [RELEASE_1, RELEASE_2];
  const now = '2026-10-24T12:00:00.000Z';
  const inventory = adapter.buildInventory({ repository, refs, releases, now });
  assert.equal(inventory.repositoryId, 1372710981);
  assert.deepEqual(inventory.refs, refs);
  assert.equal(inventory.releases.length, 2);
  assert.equal(inventory.assets.length, 1);
  assert.equal(inventory.ownership.owner, 'vivernet');
  assert.equal(inventory.ownership.visibility, 'public');
  assert.equal(inventory.ownership.canPush, true);
  assert.equal(inventory.observedAt, now);
});

test('inventoryHashOf is deterministic and changes with inventory content', () => {
  const slice = { repositoryId: 1, refs: [{ ref: 'a', sha: 'x' }], assets: [], observedAt: 't' };
  const hashA = inventoryHashOf(slice);
  const hashB = inventoryHashOf(slice);
  assert.equal(hashA, hashB);
  assert.match(hashA, /^[0-9a-f]{64}$/);
  const hashC = inventoryHashOf({ ...slice, assets: [{ id: 1 }] });
  assert.notEqual(hashA, hashC);
});

test('mapErrorToReport maps typed errors to report fields', () => {
  const adapter = makeAdapter(repoRouteMatcher());
  const error = new GithubError(GITHUB_CODES.REPOSITORY_MISMATCH, 'id mismatch', { field: 'repository.id' });
  const report = adapter.mapErrorToReport(error);
  assert.deepEqual(report, { code: GITHUB_CODES.REPOSITORY_MISMATCH, message: 'id mismatch', field: 'repository.id' });
  const generic = adapter.mapErrorToReport(new Error('boom'));
  assert.equal(generic.code, GITHUB_CODES.API_ERROR);
  assert.equal(generic.message, 'boom');
});

test('credentials never leak into errors or outputs', async () => {
  const adapter = makeAdapter((url) => {
    if (apiPath(url) === '/repos/vivernet/ebb-orchestrator') {
      return { status: 500, body: { message: `bad upstream ${TOKEN}` } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.fetchRepository({ policy: policyWith() }),
    (error) => {
      assert.ok(error instanceof GithubError);
      assert.equal(error.message.includes(TOKEN), false, `token leaked into error: ${error.message}`);
      return true;
    },
  );
  const adapter2 = makeAdapter(repoRouteMatcher());
  const repository = await adapter2.fetchRepository({ policy: policyWith() });
  const refs = await adapter2.fetchRefs({ owner: 'vivernet', repo: 'ebb-orchestrator' });
  const inventory = adapter2.buildInventory({ repository, refs, releases: [], now: '2026-10-24T12:00:00.000Z' });
  const json = JSON.stringify(inventory);
  assert.equal(json.includes(TOKEN), false);
  assert.equal(json.includes('Authorization'), false);
});
