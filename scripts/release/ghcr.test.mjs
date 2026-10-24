/* global Buffer */

// plan-26 Task5: GHCR adapter tests (test-first RED). Mocked OCI/registry HTTP
// fixtures only — no real registry/network calls. Fixtures: private image,
// untested/missing image metadata, shared multiarch manifest ownership, unknown
// package owner, no deletion permission, known >5,000 download restriction,
// API response without download_count, deletion server refusal, ambiguous
// response, multi-version PARTIAL semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGhcrAdapter,
  GHCR_CODES,
  GHCR_MEDIA,
  GhcrError,
  deletionEligibility,
  inventoryHashOf,
  parseConfigLabels,
  parseImageManifest,
  parseManifestList,
} from './ghcr.mjs';

const REG = 'https://ghcr.io';
const API = 'https://api.github.com';
const GH_TOKEN = 'ghp_github_account_token';
const TOKEN_RESPONSE = { token: 'ghcr_registry_token', expires_in: 300 };

const OWNER = 'vivernet';
const NAME = 'ebb-orchestrator';
const SOURCE_SHA = '9'.repeat(40);
const SOURCE_URL = `https://github.com/${OWNER}/${NAME}`;

const DIGEST = {
  list123: 'a'.repeat(40),
  list124: 'b'.repeat(40),
  amd64: 'c'.repeat(40),
  arm64: 'd'.repeat(40),
  shared: 'e'.repeat(40),
  config: 'f'.repeat(40),
  config124: 'f'.repeat(40),
};

const CONFIG_LABELS = {
  'org.opencontainers.image.version': '1.2.3',
  'org.opencontainers.image.revision': SOURCE_SHA,
  'org.opencontainers.image.source': SOURCE_URL,
  'org.opencontainers.image.created': '2026-10-24T10:00:00Z',
};

function configBlob(labels = CONFIG_LABELS) {
  return {
    architecture: 'amd64',
    os: 'linux',
    config: { Labels: labels },
    rootfs: { type: 'layers', diff_ids: [] },
    created: '2026-10-24T10:00:00Z',
  };
}

function manifestListBody(children) {
  return {
    schemaVersion: 2,
    mediaType: GHCR_MEDIA.DOCKER_MANIFEST_LIST,
    manifests: children,
  };
}

function singleManifestBody(configDigest = `sha256:${DIGEST.config}`) {
  return {
    schemaVersion: 2,
    mediaType: GHCR_MEDIA.DOCKER_MANIFEST,
    config: { mediaType: GHCR_MEDIA.DOCKER_CONFIG, size: 100, digest: configDigest },
    layers: [],
  };
}

function defaultChildren(shared = false) {
  const children = [
    { digest: `sha256:${DIGEST.amd64}`, mediaType: GHCR_MEDIA.DOCKER_MANIFEST, platform: { os: 'linux', architecture: 'amd64' } },
    { digest: `sha256:${DIGEST.arm64}`, mediaType: GHCR_MEDIA.DOCKER_MANIFEST, platform: { os: 'linux', architecture: 'arm64' } },
  ];
  if (shared) {
    children.push({ digest: `sha256:${DIGEST.shared}`, mediaType: GHCR_MEDIA.DOCKER_MANIFEST, platform: { os: 'linux', architecture: 'riscv64' } });
  }
  return children;
}

const PACKAGE_BODY = {
  id: 12345,
  name: NAME,
  package_type: 'container',
  visibility: 'public',
  owner: { login: OWNER },
  html_url: `https://github.com/users/${OWNER}/packages/container/package/${NAME}`,
  created_at: '2026-10-20T10:00:00Z',
  updated_at: '2026-10-24T10:00:00Z',
};

function versionBody(id, version, { tags } = {}) {
  const tagList = tags ?? [version];
  return {
    id,
    name: version,
    url: `${API}/user/packages/container/${NAME}/versions/${id}`,
    package_html_url: `https://github.com/users/${OWNER}/packages/container/package/${NAME}`,
    html_url: `https://github.com/users/${OWNER}/packages/container/package/${NAME}?version=${version}`,
    created_at: '2026-10-24T10:00:00Z',
    updated_at: '2026-10-24T10:00:00Z',
    metadata: { container: { tags: tagList } },
  };
}

const VERSIONS = [
  versionBody(701, '1.2.3'),
  versionBody(702, '1.2.4'),
];

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
  const request = makeFakeRequest(matcher);
  const adapter = createGhcrAdapter({
    request,
    registryUrl: REG,
    apiBaseUrl: API,
    token: GH_TOKEN,
    ...overrides,
  });
  adapter.__request = request;
  return adapter;
}

function regPath(url) {
  return url.startsWith(REG) ? url.slice(REG.length) : url;
}
function apiPath(url) {
  return url.startsWith(API) ? url.slice(API.length) : url;
}

function registryRouteMatcher(overrides = {}) {
  const routes = {
    [`^${REG}/token\\?service=`]: () => ({ status: 200, body: TOKEN_RESPONSE }),
    [`^${REG}/v2/${OWNER}/${NAME}/tags/list`]: (url, _init) => {
      if (_init && _init.method === 'GET' && url.includes('last=')) {
        return { status: 200, body: { name: NAME, tags: ['1.2.50', '1.2.51'] } };
      }
      const tags = Array.from({ length: 100 }, (_, index) => `1.0.${index}`);
      return { status: 200, body: { name: NAME, tags } };
    },
    [`^${REG}/v2/${OWNER}/${NAME}/manifests/1\\.2\\.3$`]: () => ({
      status: 200,
      body: manifestListBody(defaultChildren(false)),
      headers: { 'Docker-Content-Digest': `sha256:${DIGEST.list123}` },
    }),
    [`^${REG}/v2/${OWNER}/${NAME}/manifests/1\\.2\\.4$`]: () => ({
      status: 200,
      body: manifestListBody(defaultChildren(true)),
      headers: { 'Docker-Content-Digest': `sha256:${DIGEST.list124}` },
    }),
    [`^${REG}/v2/${OWNER}/${NAME}/manifests/sha256:${DIGEST.amd64}$`]: () => ({
      status: 200,
      body: singleManifestBody(`sha256:${DIGEST.config}`),
      headers: { 'Docker-Content-Digest': `sha256:${DIGEST.amd64}` },
    }),
    [`^${REG}/v2/${OWNER}/${NAME}/manifests/sha256:${DIGEST.arm64}$`]: () => ({
      status: 200,
      body: singleManifestBody(`sha256:${DIGEST.config}`),
      headers: { 'Docker-Content-Digest': `sha256:${DIGEST.arm64}` },
    }),
    [`^${REG}/v2/${OWNER}/${NAME}/manifests/sha256:${DIGEST.shared}$`]: () => ({
      status: 200,
      body: singleManifestBody(`sha256:${DIGEST.config}`),
      headers: { 'Docker-Content-Digest': `sha256:${DIGEST.shared}` },
    }),
    [`^${REG}/v2/${OWNER}/${NAME}/blobs/sha256:${DIGEST.config}$`]: () => ({
      status: 200,
      body: configBlob(),
    }),
    [`^${API}/repos/${OWNER}/${NAME}/packages/container/${NAME}$`]: () => ({
      status: 200,
      body: PACKAGE_BODY,
    }),
    [`^${API}/user/packages/container/${NAME}/versions$`]: () => ({
      status: 200,
      body: VERSIONS,
    }),
    ...overrides,
  };
  return (url, _init) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (new RegExp(pattern).test(url)) return handler(url, _init);
    }
    return null;
  };
}

function makeGraph(version, tag, topDigest, childDigests) {
  return { version, tag, topDigest, childDigests };
}

const GRAPH_123 = makeGraph('1.2.3', '1.2.3', `sha256:${DIGEST.list123}`, [`sha256:${DIGEST.amd64}`, `sha256:${DIGEST.arm64}`]);
const GRAPH_124 = makeGraph('1.2.4', '1.2.4', `sha256:${DIGEST.list124}`, [
  `sha256:${DIGEST.amd64}`,
  `sha256:${DIGEST.arm64}`,
  `sha256:${DIGEST.shared}`,
]);

test('getRegistryToken exchanges the GitHub token for an OCI registry token', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  const token = await adapter.getRegistryToken({ scopes: [`repository:${OWNER}/${NAME}:pull`] });
  assert.equal(token, 'ghcr_registry_token');
  const call = adapter.__request.calls.find((entry) => regPath(entry.url).startsWith('/token'));
  assert.ok(call, 'token endpoint was called');
  assert.ok(regPath(call.url).includes('service=ghcr.io'));
  assert.ok(decodeURIComponent(regPath(call.url)).includes(`scope=repository:${OWNER}/${NAME}:pull`));
  assert.equal(call.init.headers.Authorization, `Bearer ${GH_TOKEN}`);
});

test('token response without a token field maps to TOKEN_UNAVAILABLE', async () => {
  const adapter = makeAdapter((url) => {
    if (regPath(url).startsWith('/token')) return { status: 200, body: { expires_in: 300 } };
    return null;
  });
  await assert.rejects(
    () => adapter.getRegistryToken({ scopes: [] }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.TOKEN_UNAVAILABLE,
  );
});

test('token endpoint refusal maps to AUTH_FAILED', async () => {
  const adapter = makeAdapter((url) => {
    if (regPath(url).startsWith('/token')) return { status: 401, body: { message: 'Bad credentials' } };
    return null;
  });
  await assert.rejects(
    () => adapter.getRegistryToken({ scopes: [] }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.AUTH_FAILED,
  );
});

test('registry 401 refreshes the token once and retries', async () => {
  let registryCalls = 0;
  const adapter = makeAdapter((url) => {
    const path = regPath(url);
    if (path.startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (path.startsWith('/v2/')) {
      registryCalls += 1;
      if (registryCalls === 1) return { status: 401, body: { message: 'unauthorized' } };
      return { status: 200, body: { name: NAME, tags: [] } };
    }
    return null;
  });
  await adapter.inventoryTags({ owner: OWNER, name: NAME });
  assert.ok(registryCalls >= 2);
});

test('repeated registry 401 maps to AUTH_FAILED', async () => {
  const adapter = makeAdapter((url) => {
    const path = regPath(url);
    if (path.startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (path.startsWith('/v2/')) return { status: 401, body: { message: 'unauthorized' } };
    return null;
  });
  await assert.rejects(
    () => adapter.inventoryTags({ owner: OWNER, name: NAME }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.AUTH_FAILED,
  );
});

test('tags pagination aggregates all pages via last token', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  const tags = await adapter.inventoryTags({ owner: OWNER, name: NAME });
  assert.equal(tags.length, 102);
  assert.equal(tags[0], '1.0.0');
  assert.equal(tags[100], '1.2.50');
  assert.equal(tags[101], '1.2.51');
});

test('tags paging discontinuity maps to PAGING_MISSING_IDS', async () => {
  const adapter = makeAdapter((url, _init) => {
    const path = regPath(url);
    if (path.startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (path.startsWith('/v2/') && path.includes('tags/list')) {
      if (_init && _init.method === 'GET' && url.includes('last=')) {
        return { status: 200, body: { name: NAME, tags: ['1.0.0', '1.0.1'] } };
      }
      return { status: 200, body: { name: NAME, tags: Array.from({ length: 100 }, (_, index) => `1.0.${index}`) } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.inventoryTags({ owner: OWNER, name: NAME }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.PAGING_MISSING_IDS,
  );
});

test('parseManifestList yields digest/platform metadata for every child', () => {
  const parsed = parseManifestList(manifestListBody(defaultChildren(false)));
  assert.equal(parsed.mediaType, GHCR_MEDIA.DOCKER_MANIFEST_LIST);
  assert.equal(parsed.manifests.length, 2);
  assert.equal(parsed.manifests[0].platform.architecture, 'amd64');
  assert.equal(parsed.manifests[1].platform.architecture, 'arm64');
  assert.equal(parsed.manifests[0].digest, `sha256:${DIGEST.amd64}`);
});

test('parseManifestList rejects non-list manifest bodies as ambiguous', () => {
  assert.throws(
    () => parseManifestList(singleManifestBody()),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.AMBIGUOUS_RESPONSE,
  );
});

test('parseImageManifest extracts config and layer digests', () => {
  const parsed = parseImageManifest(singleManifestBody());
  assert.equal(parsed.config.digest, `sha256:${DIGEST.config}`);
  assert.deepEqual(parsed.layers, []);
});

test('parseConfigLabels reads OCI source/version labels', () => {
  const { labels, imageVersion, revision, source } = parseConfigLabels(configBlob());
  assert.equal(labels['org.opencontainers.image.version'], '1.2.3');
  assert.equal(imageVersion, '1.2.3');
  assert.equal(revision, SOURCE_SHA);
  assert.equal(source, SOURCE_URL);
});

test('missing image metadata fails closed with METADATA_MISSING', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  await assert.rejects(
    async () => adapter.validateSourceLabels({ labels: {}, version: '1.2.3', sourceSha: SOURCE_SHA, sourceUrl: SOURCE_URL }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.METADATA_MISSING,
  );
});

test('wrong version label maps to WRONG_VERSION_LABEL', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  const labels = { ...CONFIG_LABELS, 'org.opencontainers.image.version': '9.9.9' };
  await assert.rejects(
    async () => adapter.validateSourceLabels({ labels, version: '1.2.3', sourceSha: SOURCE_SHA, sourceUrl: SOURCE_URL }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.WRONG_VERSION_LABEL,
  );
});

test('wrong source revision label maps to WRONG_SOURCE_LABEL', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  const labels = { ...CONFIG_LABELS, 'org.opencontainers.image.revision': '0'.repeat(40) };
  await assert.rejects(
    async () => adapter.validateSourceLabels({ labels, version: '1.2.3', sourceSha: SOURCE_SHA, sourceUrl: SOURCE_URL }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.WRONG_SOURCE_LABEL,
  );
});

test('readPackage infers ownership and reads back public visibility', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  const pkg = await adapter.readPackage({ owner: OWNER, name: NAME });
  assert.equal(pkg.id, 12345);
  assert.equal(pkg.owner, OWNER);
  assert.equal(pkg.visibility, 'public');
  const ownership = adapter.inferOwnership({ pkg, expectedOwner: OWNER });
  assert.deepEqual(ownership, { owner: OWNER, owned: true });
});

test('package owned by another user maps to UNKNOWN_PACKAGE_OWNER', async () => {
  const adapter = makeAdapter((url) => {
    if (apiPath(url) === `/repos/${OWNER}/${NAME}/packages/container/${NAME}`) {
      return { status: 200, body: { ...PACKAGE_BODY, owner: { login: 'mallory' } } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.readPackage({ owner: OWNER, name: NAME }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.UNKNOWN_PACKAGE_OWNER,
  );
});

test('private package visibility maps to NOT_PUBLIC (never changes visibility implicitly)', async () => {
  const adapter = makeAdapter((url) => {
    if (apiPath(url) === `/repos/${OWNER}/${NAME}/packages/container/${NAME}`) {
      return { status: 200, body: { ...PACKAGE_BODY, visibility: 'private' } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.readPackage({ owner: OWNER, name: NAME }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.NOT_PUBLIC,
  );
});

test('package REST 404 maps to NOT_FOUND', async () => {
  const adapter = makeAdapter((url) => {
    if (apiPath(url) === `/repos/${OWNER}/${NAME}/packages/container/${NAME}`) {
      return { status: 404, body: { message: 'Not Found' } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.readPackage({ owner: OWNER, name: NAME }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.NOT_FOUND,
  );
});

test('version list without download_count leaves downloadCount null and eligibility uncertain', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  const versions = await adapter.listPackageVersions({ owner: OWNER, name: NAME });
  assert.equal(versions.length, 2);
  for (const version of versions) {
    assert.equal(version.downloadCount, null);
    assert.equal('download_count' in version.metadata, false);
  }
  const eligibility = deletionEligibility({ version: versions[0] });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.uncertainty, true);
  assert.equal(eligibility.code, GHCR_CODES.ELIGIBILITY_UNKNOWN);
  assert.ok(eligibility.reason.includes('DOWNLOAD_COUNT_UNAVAILABLE'));
  assert.equal(eligibility.count, null);
});

test('known >5,000 download restriction blocks eligibility', () => {
  const eligibility = deletionEligibility({ version: { name: '1.2.3' }, knownDownloadCount: 6000 });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.uncertainty, false);
  assert.equal(eligibility.code, GHCR_CODES.DOWNLOAD_RESTRICTION);
  assert.equal(eligibility.count, 6000);
});

test('documented small download count does not block eligibility', () => {
  const eligibility = deletionEligibility({ version: { name: '1.2.3' }, knownDownloadCount: 120 });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.uncertainty, false);
  assert.equal(eligibility.count, 120);
});

test('shared multiarch manifest ownership is detected before any deletion', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  const duplicateIdentity = { ...GRAPH_124, topDigest: `sha256:${DIGEST.list123}` };
  const result = adapter.sharedManifestAmbiguity({ graphs: [GRAPH_123, duplicateIdentity], targetVersion: '1.2.4' });
  assert.equal(result.ambiguous, true);
  assert.equal(result.code, GHCR_CODES.AMBIGUOUS_SHARED_MANIFEST);
  const cleanResult = adapter.sharedManifestAmbiguity({ graphs: [GRAPH_123, GRAPH_124], targetVersion: '1.2.4' });
  assert.equal(cleanResult.ambiguous, false);
});

test('buildDeletionActions builds exact target-only version deletion actions', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  const actions = adapter.buildDeletionActions({ owner: OWNER, name: NAME, graphs: [GRAPH_123, GRAPH_124], targets: ['1.2.3'] });
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    kind: 'delete-manifest',
    owner: OWNER,
    packageName: NAME,
    version: '1.2.3',
    tag: '1.2.3',
    digest: `sha256:${DIGEST.list123}`,
    reference: `sha256:${DIGEST.list123}`,
  });
});

test('buildDeletionActions rejects unknown target versions', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  assert.throws(
    () => adapter.buildDeletionActions({ owner: OWNER, name: NAME, graphs: [GRAPH_123], targets: ['1.2.99'] }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.UNKNOWN_TARGET_VERSION,
  );
});

test('executeDeletion maps 202 success and 404 already-absent', async () => {
  const adapter = makeAdapter((url, _init) => {
    const path = regPath(url);
    if (path.startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (path === `/v2/${OWNER}/${NAME}/manifests/sha256:${DIGEST.list123}`) {
      return { status: 202, body: {} };
    }
    return null;
  });
  const deleted = await adapter.executeDeletion({
    kind: 'delete-manifest',
    owner: OWNER,
    packageName: NAME,
    version: '1.2.3',
    tag: '1.2.3',
    digest: `sha256:${DIGEST.list123}`,
    reference: `sha256:${DIGEST.list123}`,
  });
  assert.equal(deleted.status, 'deleted');
  const adapter2 = makeAdapter((url, _init) => {
    const path = regPath(url);
    if (path.startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (path === `/v2/${OWNER}/${NAME}/manifests/sha256:${DIGEST.list123}`) {
      return { status: 404, body: {} };
    }
    return null;
  });
  const absent = await adapter2.executeDeletion({
    kind: 'delete-manifest',
    owner: OWNER,
    packageName: NAME,
    version: '1.2.3',
    tag: '1.2.3',
    digest: `sha256:${DIGEST.list123}`,
    reference: `sha256:${DIGEST.list123}`,
  });
  assert.equal(absent.status, 'already-absent');
});

test('deletion permission refusal maps to PERMISSION_DENIED and stops later steps', async () => {
  const adapter = makeAdapter((url, _init) => {
    const path = regPath(url);
    if (path.startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (path === `/v2/${OWNER}/${NAME}/manifests/sha256:${DIGEST.list123}`) {
      return { status: 403, body: { message: 'forbidden' } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.executeDeletion({
      kind: 'delete-manifest',
      owner: OWNER,
      packageName: NAME,
      version: '1.2.3',
      tag: '1.2.3',
      digest: `sha256:${DIGEST.list123}`,
      reference: `sha256:${DIGEST.list123}`,
    }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.PERMISSION_DENIED,
  );
});

test('server refusal maps to SERVER_REFUSAL', async () => {
  const adapter = makeAdapter((url, _init) => {
    const path = regPath(url);
    if (path.startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (path === `/v2/${OWNER}/${NAME}/manifests/sha256:${DIGEST.list123}`) {
      return { status: 500, body: { message: 'internal error' } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.executeDeletion({
      kind: 'delete-manifest',
      owner: OWNER,
      packageName: NAME,
      version: '1.2.3',
      tag: '1.2.3',
      digest: `sha256:${DIGEST.list123}`,
      reference: `sha256:${DIGEST.list123}`,
    }),
    (error) => error instanceof GhcrError && error.code === GHCR_CODES.SERVER_REFUSAL,
  );
});

test('withdrawVersions succeeds with OK when every target deletes', async () => {
  const adapter = makeAdapter((url, _init) => {
    const path = regPath(url);
    if (path.startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (path.startsWith(`/v2/${OWNER}/${NAME}/manifests/sha256:`)) {
      return { status: 202, body: {} };
    }
    return null;
  });
  const result = await adapter.withdrawVersions({
    owner: OWNER,
    name: NAME,
    graphs: [GRAPH_123, GRAPH_124],
    targets: ['1.2.3', '1.2.4'],
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.deleted, ['1.2.3', '1.2.4']);
  assert.deepEqual(result.remaining, []);
});

test('multi-version deletion yields PARTIAL after a confirmed delete then server refusal', async () => {
  const deleteCalls = [];
  const adapter = makeAdapter((url, _init) => {
    const path = regPath(url);
    if (path.startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (path === `/v2/${OWNER}/${NAME}/manifests/sha256:${DIGEST.list123}`) {
      deleteCalls.push('1.2.3');
      return { status: 202, body: {} };
    }
    if (path === `/v2/${OWNER}/${NAME}/manifests/sha256:${DIGEST.list124}`) {
      deleteCalls.push('1.2.4');
      return { status: 403, body: { message: 'forbidden' } };
    }
    return null;
  });
  const result = await adapter.withdrawVersions({
    owner: OWNER,
    name: NAME,
    graphs: [GRAPH_123, GRAPH_124],
    targets: ['1.2.3', '1.2.4'],
  });
  assert.equal(result.status, 'PARTIAL');
  assert.deepEqual(result.deleted, ['1.2.3']);
  assert.deepEqual(result.remaining, ['1.2.4']);
  assert.deepEqual(deleteCalls, ['1.2.3', '1.2.4']);
});

test('server refusal on the first version blocks the whole withdrawal and later delete steps never run', async () => {
  const deleteCalls = [];
  const adapter = makeAdapter((url, _init) => {
    const path = regPath(url);
    if (path.startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (path.startsWith(`/v2/${OWNER}/${NAME}/manifests/sha256:`)) {
      deleteCalls.push(path);
      return { status: 403, body: { message: 'forbidden' } };
    }
    return null;
  });
  const result = await adapter.withdrawVersions({
    owner: OWNER,
    name: NAME,
    graphs: [GRAPH_123, GRAPH_124],
    targets: ['1.2.3', '1.2.4'],
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.remaining, ['1.2.3', '1.2.4']);
  assert.equal(deleteCalls.length, 1);
});

test('buildInventory assembles packages/versions/ociObjects/ownership with observedAt', async () => {
  const adapter = makeAdapter(registryRouteMatcher());
  const pkg = await adapter.readPackage({ owner: OWNER, name: NAME });
  const versions = await adapter.listPackageVersions({ owner: OWNER, name: NAME });
  const graphs = [GRAPH_123, GRAPH_124];
  const now = '2026-10-24T12:00:00.000Z';
  const inventory = adapter.buildInventory({ pkg, versions, graphs, now });
  assert.equal(inventory.packages.length, 1);
  assert.equal(inventory.packages[0].visibility, 'public');
  assert.equal(inventory.versions.length, 2);
  assert.equal(inventory.versions[0].downloadCount, null);
  assert.equal(inventory.ociObjects.length, 2);
  assert.equal(inventory.ownership.owner, OWNER);
  assert.equal(inventory.ownership.owned, true);
  assert.equal(inventory.ownership.public, true);
  assert.equal(inventory.observedAt, now);
  assert.match(inventoryHashOf(inventory), /^[0-9a-f]{64}$/);
});

test('inventoryHashOf is deterministic and content-sensitive', () => {
  const inventory = { packages: [{ id: 1 }], versions: [], ociObjects: [], ownership: { owner: OWNER }, observedAt: 't' };
  assert.equal(inventoryHashOf(inventory), inventoryHashOf(inventory));
  assert.notEqual(inventoryHashOf(inventory), inventoryHashOf({ ...inventory, observedAt: 't2' }));
});

test('mapErrorToReport maps typed errors and never leaks credentials', async () => {
  const adapter = makeAdapter((url) => {
    if (regPath(url).startsWith('/token')) return { status: 200, body: TOKEN_RESPONSE };
    if (regPath(url).startsWith('/v2/')) {
      return { status: 500, body: { message: `registry leaked ${TOKEN_RESPONSE.token}` } };
    }
    return null;
  });
  await assert.rejects(
    () => adapter.inventoryTags({ owner: OWNER, name: NAME }),
    (error) => {
      const report = adapter.mapErrorToReport(error);
      assert.equal(report.code, GHCR_CODES.API_ERROR);
      assert.equal(report.message.includes(TOKEN_RESPONSE.token), false);
      assert.equal(report.message.includes(GH_TOKEN), false);
      return true;
    },
  );
});
