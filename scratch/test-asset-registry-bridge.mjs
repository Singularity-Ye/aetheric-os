import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

class MockTFile {
  constructor(path, size = 0, mtime = 1) {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
    this.extension = this.name.includes(".") ? this.name.split(".").pop() : "";
    this.stat = { size, mtime, ctime: mtime };
  }
}

function compileCommonJs(url, requireStub) {
  const source = fs.readFileSync(url, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true,
  });
  assert.equal(
    (result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length,
    0,
  );
  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputText)(loaded, loaded.exports, requireStub);
  return { exports: loaded.exports, source };
}

function bytes(values) {
  return Uint8Array.from(values).buffer;
}

const realWindow = globalThis.window;
const realFetch = globalThis.fetch;
globalThis.window = { setTimeout, clearTimeout };

try {
  const adapterCompiled = compileCommonJs(new URL("../src/aetheric/HamasxiangAdapter.ts", import.meta.url), name => {
    if (name === "./LogBus") return {};
    if (name === "./types") return {};
    throw new Error(`Unexpected adapter dependency: ${name}`);
  });
  const { HamasxiangAdapter } = adapterCompiled.exports;
  const requests = [];
  let statusPayload = {
    ok: true,
    service: "asset-upload",
    checked_at: "2026-08-01T01:02:03Z",
    provider: "tencent_cos",
    enabled: true,
    configured: true,
    credentials: { configured: true },
    running: false,
    active_job_id: null,
    state: "pending",
    last_success_at: "2026-08-01T00:58:00Z",
    outbox: {
      total: 1,
      by_status: { queued: 1, leased: 0, failed: 0, succeeded: 0 },
      due: 1,
      retryable_failed: 0,
      terminal_failed: 0,
      expired_leases: 0,
      next_attempt_at: "2026-08-01T01:03:00Z",
    },
    remote_objects: {
      total: 2,
      verified_assets: 1,
      by_status: { pending: 1, uploaded: 0, verified: 1, failed: 0, tombstoned: 0 },
    },
    restore: {
      running: true,
      last_success_at: "2026-08-01T00:45:00Z",
      last_role: "display",
      last_error: {
        layer: "asset.restore.verify",
        code: "restore_probe_failed",
        message: "restored object checksum mismatch",
        retryable: true,
        updated_at: "2026-08-01T00:46:00Z",
      },
    },
    last_error: null,
  };
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith("/asset-registry/summary")) {
      return new Response(JSON.stringify({
        ok: true,
        schema_version: 5,
        total: 1,
        by_status: { discovered: 0, derivative_ready: 1, failed: 0, uploaded: 0, verified: 0 },
        bytes_original: 8,
        bytes_display: 3,
        upload_outbox: {
          total: 1,
          by_status: { queued: 1, leased: 0, failed: 0, succeeded: 0 },
          by_provider: { tencent_cos: 1 },
        },
        remote_objects: {
          total: 0,
          by_status: { pending: 0, uploaded: 0, verified: 0, failed: 0, tombstoned: 0 },
          by_provider: {},
        },
      }), { status: 200 });
    }
    if (url.endsWith("/asset-upload/status")) {
      return new Response(JSON.stringify(statusPayload), { status: 200 });
    }
    if (url.endsWith("/asset-registry/enqueue-upload")) {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        ok: true,
        upload: {
          upload_id: "upl_0123456789abcdef",
          asset_id: body.asset_id,
          provider: "tencent_cos",
          status: "queued",
          reused: false,
        },
      }), { status: 200 });
    }
    if (url.endsWith("/asset-upload/run")) {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        ok: true,
        queued: true,
        job_id: "asset-job-1",
        status: "queued",
        provider: "tencent_cos",
        limit: body.limit,
      }), { status: 202 });
    }
    if (url.endsWith("/asset-restore/drill")) {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        ok: true,
        queued: true,
        job_id: "restore-job-1",
        status: "queued",
        provider: "tencent_cos",
        role: body.role,
      }), { status: 202 });
    }
    const body = JSON.parse(String(init.body));
    const derivative = url.endsWith("/register-derivative");
    return new Response(JSON.stringify({
      ok: true,
      asset: {
        asset_id: "ast_0123456789abcdef01234567",
        status: derivative ? "derivative_ready" : "discovered",
        note_ref_count: derivative ? 1 : body.note_refs?.length ?? 0,
      },
    }), { status: 200 });
  };

  const adapter = new HamasxiangAdapter({ append() {} }, "http://127.0.0.1:8765", "secret-token");
  const discovered = await adapter.discoverImageAsset("91_assets/source.png", ["notes/example.md"]);
  await adapter.registerImageDerivative(discovered.asset_id, "91_assets/source.webp");
  const enqueued = await adapter.enqueueImageAssetUpload(
    discovered.asset_id,
    "91_assets/source.png",
    "91_assets/source.webp",
  );
  const registrySummary = await adapter.getAssetRegistrySummary();
  const uploadStatus = await adapter.getAssetUploadStatus();
  const runReceipt = await adapter.runAssetUpload(99);
  const restoreReceipt = await adapter.runAssetRestoreDrill("display", discovered.asset_id);
  assert.equal(enqueued.status, "queued");
  assert.equal(registrySummary.by_status.derivative_ready, 1);
  assert.equal(registrySummary.upload_outbox?.by_status.queued, 1);
  assert.equal(uploadStatus.queued, 1);
  assert.equal(uploadStatus.remoteVerified, 1);
  assert.equal(uploadStatus.remoteVerifiedAssets, 1);
  assert.equal(uploadStatus.configured, true);
  assert.equal(uploadStatus.lastSuccessAt, "2026-08-01T00:58:00Z");
  assert.deepEqual(uploadStatus.restore, {
    running: true,
    lastSuccessAt: "2026-08-01T00:45:00Z",
    lastRole: "display",
    lastError: {
      layer: "asset.restore.verify",
      code: "restore_probe_failed",
      message: "restored object checksum mismatch",
      retryable: true,
      updated_at: "2026-08-01T00:46:00Z",
    },
  });
  assert.equal(runReceipt.limit, 20, "The workbench must never request more than the daemon bound");
  assert.equal(restoreReceipt.jobId, "restore-job-1");
  assert.equal(restoreReceipt.status, "queued");
  assert.equal(restoreReceipt.provider, "tencent_cos");
  assert.equal(restoreReceipt.role, "display");
  assert.deepEqual(
    requests.map(item => new URL(item.url).pathname),
    [
      "/asset-registry/discover",
      "/asset-registry/register-derivative",
      "/asset-registry/enqueue-upload",
      "/asset-registry/summary",
      "/asset-upload/status",
      "/asset-upload/run",
      "/asset-restore/drill",
    ],
  );
  assert.ok(requests.every(item => new Headers(item.init.headers).get("Authorization") === "Bearer secret-token"));
  assert.equal(JSON.parse(String(requests[0].init.body)).original_path, "91_assets/source.png");
  assert.equal(JSON.parse(String(requests[1].init.body)).display_path, "91_assets/source.webp");
  assert.deepEqual(JSON.parse(String(requests[2].init.body)), {
    asset_id: discovered.asset_id,
    original_path: "91_assets/source.png",
    display_path: "91_assets/source.webp",
  }, "The renderer must not send provider names or cloud credentials to the enqueue endpoint");
  assert.deepEqual(JSON.parse(String(requests[5].init.body)), { limit: 20 });
  const restoreBody = JSON.parse(String(requests[6].init.body));
  assert.deepEqual(
    restoreBody,
    { role: "display", asset_id: discovered.asset_id },
    "Exact restore drills may select one registry asset but no storage coordinate",
  );
  assert.equal(
    Object.keys(restoreBody).some(key => /object|key|path|provider|credential|secret|token/i.test(key)),
    false,
    "Restore drill requests must not expose storage selectors, provider internals, paths, or credentials",
  );
  assert.equal(
    String(requests[6].init.body).includes("secret-token"),
    false,
    "The bearer credential must stay in the Authorization header and never enter the JSON body",
  );
  assert.match(
    adapterCompiled.source,
    /assetId\?: string/,
    "The renderer contract must support one exact Registry asset selector for SLA evidence",
  );
  assert.match(
    adapterCompiled.source,
    /asset_id: assetId/,
    "The restore adapter must serialize only the exact Registry asset id",
  );

  statusPayload = {
    ...statusPayload,
    configured: false,
    credentials: { configured: true },
    state: "blocked",
  };
  const sdkMissing = await adapter.getAssetUploadStatus();
  assert.equal(
    sdkMissing.configured,
    false,
    "Top-level effective readiness must win when credentials exist but the COS SDK is missing",
  );
  const { configured: _effectiveConfigured, ...legacyStatusPayload } = statusPayload;
  statusPayload = { ...legacyStatusPayload, credentials: { configured: true } };
  const legacyDaemon = await adapter.getAssetUploadStatus();
  assert.equal(legacyDaemon.configured, true, "Only a legacy response without top-level configured may use credential fallback");
  const { verified_assets: _verifiedAssets, ...legacyRemoteObjects } = statusPayload.remote_objects;
  statusPayload = { ...statusPayload, remote_objects: legacyRemoteObjects };
  const providerCountUnknown = await adapter.getAssetUploadStatus();
  assert.equal(
    providerCountUnknown.remoteVerifiedAssets,
    undefined,
    "A legacy daemon must remain unknown instead of borrowing the global verified asset count",
  );

  const serviceCompiled = compileCommonJs(new URL("../src/aetheric/ImageGovernanceService.ts", import.meta.url), name => {
    if (name === "obsidian") return { TFile: MockTFile };
    if (name === "./LogBus") return {};
    throw new Error(`Unexpected service dependency: ${name}`);
  });
  const { ImageGovernanceService } = serviceCompiled.exports;

  function makeHarness(assetRegistry) {
    const files = new Map();
    const binary = new Map();
    const notes = new Map();
    const trashed = [];
    const logs = [];
    const source = new MockTFile("91_assets/source.png", 8, 10);
    const note = new MockTFile("notes/example.md", 16, 1);
    files.set(source.path, source);
    files.set(note.path, note);
    binary.set(source.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    notes.set(note, "![[91_assets/source.png]]");
    const vault = {
      on() { return {}; },
      getFiles() { return [...files.values()]; },
      getMarkdownFiles() { return [note]; },
      getAbstractFileByPath(path) { return files.get(path) ?? null; },
      async readBinary(file) { return binary.get(file.path); },
      async createBinary(path, data) {
        const file = new MockTFile(path, data.byteLength, 11);
        files.set(path, file);
        binary.set(path, data.slice(0));
        return file;
      },
      async trash(file) {
        trashed.push(file.path);
        files.delete(file.path);
        binary.delete(file.path);
      },
      async read(file) { return notes.get(file) ?? ""; },
      async modify(file, value) { notes.set(file, value); },
    };
    const service = new ImageGovernanceService(
      { vault, metadataCache: { resolvedLinks: { [note.path]: { [source.path]: 1 } } } },
      { registerEvent() {} },
      { append(level, channel, message) { logs.push({ level, channel, message }); } },
      () => ({
        enabled: true,
        autoCompress: false,
        minBytes: 1,
        quality: 0.82,
        maxDimension: 2400,
        minSavingsRatio: 0.9,
        debounceMs: 100,
      }),
      assetRegistry,
    );
    service.encodeWebp = async () => ({
      data: bytes([9, 8, 7]), mime: "image/webp", width: 1, height: 1,
    });
    return { binary, files, logs, note, notes, service, source, trashed, vault };
  }

  {
    const calls = [];
    const registry = {
      async discoverImageAsset(path, refs) {
        calls.push(["discover", path, refs]);
        return { asset_id: "ast_0123456789abcdef01234567", status: "discovered", note_ref_count: refs.length };
      },
      async registerImageDerivative(assetId, path) {
        calls.push(["derivative", assetId, path]);
        return { asset_id: assetId, status: "derivative_ready", note_ref_count: 1 };
      },
      async enqueueImageAssetUpload(assetId, originalPath, displayPath) {
        calls.push(["enqueue", assetId, originalPath, displayPath]);
        return { upload_id: "upl_1", asset_id: assetId, provider: "tencent_cos", status: "queued", reused: false };
      },
      async getAssetRegistrySummary() {
        return {
          total: 1,
          by_status: { discovered: 0, derivative_ready: 1, failed: 0, uploaded: 0, verified: 0 },
        };
      },
    };
    const harness = makeHarness(registry);
    await harness.service.optimizeFile(harness.source);
    assert.deepEqual(calls[0], ["discover", "91_assets/source.png", ["notes/example.md"]]);
    assert.deepEqual(calls[1], ["derivative", "ast_0123456789abcdef01234567", "91_assets/source.webp"]);
    assert.deepEqual(calls[2], [
      "enqueue",
      "ast_0123456789abcdef01234567",
      "91_assets/source.png",
      "91_assets/source.webp",
    ]);
    assert.equal(harness.notes.get(harness.note), "![[91_assets/source.webp]]");
    assert.ok(harness.files.has("91_assets/source.png"));
    assert.ok(harness.files.has("91_assets/source.webp"));
    assert.deepEqual(harness.trashed, []);
    await harness.service.refreshRegistrySummary();
    assert.equal(harness.service.getSnapshot().registry.derivativeReady, 1);
    assert.equal(harness.service.getSnapshot().registry.uploaded, 0);
    assert.equal(harness.service.getSnapshot().registry.verified, 0);
  }

  {
    const registry = {
      async discoverImageAsset() { throw new Error("daemon offline"); },
      async registerImageDerivative() { throw new Error("must not run"); },
      async getAssetRegistrySummary() { throw new Error("daemon offline"); },
    };
    const harness = makeHarness(registry);
    await harness.service.optimizeFile(harness.source);
    assert.equal(harness.notes.get(harness.note), "![[91_assets/source.webp]]");
    assert.ok(harness.files.has("91_assets/source.png"), "Registry failure must retain the original");
    assert.ok(harness.files.has("91_assets/source.webp"), "Registry failure must retain the derivative");
    assert.deepEqual(harness.trashed, [], "Registry failure must not enter conversion rollback");
    assert.equal(harness.service.getSnapshot().converted, 1);
    assert.ok(harness.logs.some(item => item.channel === "image.asset-registry" && item.level === "error"));
    assert.match(harness.service.getSnapshot().lastError, /Asset Registry 登记失败/);
  }

  {
    const calls = [];
    const registry = {
      async discoverImageAsset(path, refs) {
        calls.push(["discover", path, refs]);
        return { asset_id: "ast_0123456789abcdef01234567", status: "discovered", note_ref_count: refs.length };
      },
      async registerImageDerivative(assetId, path) {
        calls.push(["derivative", assetId, path]);
        return { asset_id: assetId, status: "derivative_ready", note_ref_count: 1 };
      },
      async enqueueImageAssetUpload() {
        calls.push(["enqueue-failed"]);
        throw new Error("COS credentials unavailable");
      },
      async getAssetRegistrySummary() {
        return { total: 1, by_status: { derivative_ready: 1 } };
      },
      async getAssetUploadStatus() {
        return {
          checkedAt: Date.now(), provider: "tencent_cos", enabled: true, configured: false, running: false,
          state: "blocked", queued: 0, leased: 0, failed: 0, succeeded: 0, due: 0,
          retryableFailed: 0, terminalFailed: 0, expiredLeases: 0, remoteTotal: 0,
          remotePending: 0, remoteUploaded: 0, remoteVerified: 0, remoteFailed: 0,
          restore: { running: false },
        };
      },
    };
    const harness = makeHarness(registry);
    await harness.service.optimizeFile(harness.source);
    assert.equal(harness.notes.get(harness.note), "![[91_assets/source.webp]]");
    assert.ok(harness.files.has("91_assets/source.png"));
    assert.ok(harness.files.has("91_assets/source.webp"));
    assert.deepEqual(harness.trashed, [], "An enqueue outage must never enter the conversion rollback");
    assert.equal(harness.service.getSnapshot().converted, 1);
    assert.match(harness.service.getSnapshot().cloud.lastError?.message ?? "", /credentials unavailable/);
    assert.ok(harness.logs.some(item => item.channel === "image.cloud-store" && item.level === "error"));
  }

  {
    const calls = [];
    const registry = {
      async discoverImageAsset(path, refs) {
        calls.push(["discover", path, refs]);
        return { asset_id: "ast_0123456789abcdef01234567", status: "discovered", note_ref_count: refs.length };
      },
      async registerImageDerivative(assetId, path) {
        calls.push(["derivative", assetId, path]);
        return { asset_id: assetId, status: "derivative_ready", note_ref_count: 1 };
      },
      async enqueueImageAssetUpload(assetId, originalPath, displayPath) {
        calls.push(["enqueue", assetId, originalPath, displayPath]);
        return { upload_id: "upl_1", asset_id: assetId, provider: "tencent_cos", status: "queued", reused: true };
      },
      async getAssetRegistrySummary() {
        return { total: 1, by_status: { derivative_ready: 1 } };
      },
      async getAssetUploadStatus() {
        return {
          checkedAt: Date.now(), provider: "tencent_cos", enabled: true, configured: true, running: false,
          state: "pending", queued: 1, leased: 0, failed: 0, succeeded: 0, due: 1,
          retryableFailed: 0, terminalFailed: 0, expiredLeases: 0, remoteTotal: 0,
          remotePending: 0, remoteUploaded: 0, remoteVerified: 0, remoteFailed: 0,
          restore: { running: false },
        };
      },
    };
    const harness = makeHarness(registry);
    const existingWebp = new MockTFile("91_assets/source.webp", 3, 11);
    harness.files.set(existingWebp.path, existingWebp);
    harness.binary.set(existingWebp.path, bytes([9, 8, 7]));
    await harness.service.reconcileExistingDerivativesNow(20);
    assert.ok(calls.some(item => item[0] === "discover"), "The explicit existing-WebP action must reconcile the pair");
    assert.ok(calls.some(item => item[0] === "enqueue"), "A reconciled derivative must enter the durable upload outbox");
    assert.equal(harness.notes.get(harness.note), "![[91_assets/source.png]]", "Reconcile must not rewrite Markdown");
    assert.deepEqual(harness.trashed, [], "Reconcile must not delete either local image");
  }

  {
    const calls = [];
    const registry = {
      async discoverImageAsset(path) {
        calls.push(["discover", path]);
        return { asset_id: "ast_0123456789abcdef01234567", status: "discovered", note_ref_count: 0 };
      },
      async registerImageDerivative(assetId, path) {
        calls.push(["derivative", path]);
        return { asset_id: assetId, status: "derivative_ready", note_ref_count: 0 };
      },
      async enqueueImageAssetUpload(assetId, originalPath, displayPath) {
        calls.push(["enqueue", originalPath, displayPath]);
        return { upload_id: "upl_safe", asset_id: assetId, provider: "tencent_cos", status: "queued", reused: false };
      },
      async getAssetRegistrySummary() { return { total: 1, by_status: { derivative_ready: 1 } }; },
      async getAssetUploadStatus() {
        return {
          checkedAt: Date.now(), provider: "tencent_cos", enabled: true, configured: true, running: false,
          state: "pending", queued: 1, leased: 0, failed: 0, succeeded: 0, due: 1,
          retryableFailed: 0, terminalFailed: 0, expiredLeases: 0, remoteTotal: 0,
          remotePending: 0, remoteUploaded: 0, remoteVerified: 0, remoteVerifiedAssets: 0, remoteFailed: 0,
          restore: { running: false },
        };
      },
    };
    const harness = makeHarness(registry);
    const existingWebp = new MockTFile("91_assets/source.webp", 3, 11);
    harness.files.set(existingWebp.path, existingWebp);
    harness.binary.set(existingWebp.path, bytes([9, 8, 7]));
    let createCalls = 0;
    let modifyCalls = 0;
    let encodeCalls = 0;
    harness.vault.createBinary = async () => { createCalls += 1; throw new Error("reconcile must not create files"); };
    harness.vault.modify = async () => { modifyCalls += 1; throw new Error("reconcile must not rewrite notes"); };
    harness.service.encodeWebp = async () => { encodeCalls += 1; throw new Error("reconcile must not encode images"); };

    await harness.service.scanNow(false);
    assert.equal(calls.filter(item => item[0] === "discover").length, 0, "Read-only scan must not register cloud assets");
    await harness.service.reconcileExistingDerivativesNow(20);
    assert.equal(calls.filter(item => item[0] === "discover").length, 1);
    assert.equal(calls.filter(item => item[0] === "enqueue").length, 1);
    assert.equal(createCalls, 0, "Independent reconcile must not create or replace images");
    assert.equal(modifyCalls, 0, "Independent reconcile must not modify Markdown");
    assert.equal(encodeCalls, 0, "Independent reconcile must not invoke WebP encoding");
    assert.equal(harness.notes.get(harness.note), "![[91_assets/source.png]]");
    assert.deepEqual(harness.trashed, []);
  }

  {
    const discoveredPaths = [];
    const registry = {
      async discoverImageAsset(path) {
        discoveredPaths.push(path);
        return { asset_id: `ast_${String(discoveredPaths.length).padStart(24, "0")}`, status: "discovered", note_ref_count: 0 };
      },
      async registerImageDerivative(assetId) {
        return { asset_id: assetId, status: "derivative_ready", note_ref_count: 0 };
      },
      async enqueueImageAssetUpload(assetId) {
        return { upload_id: `upl_${assetId}`, asset_id: assetId, provider: "tencent_cos", status: "queued", reused: false };
      },
      async getAssetRegistrySummary() { return { total: 25, by_status: { derivative_ready: 25 } }; },
      async getAssetUploadStatus() {
        return {
          checkedAt: Date.now(), provider: "tencent_cos", enabled: true, configured: true, running: false,
          state: "pending", queued: 25, leased: 0, failed: 0, succeeded: 0, due: 25,
          retryableFailed: 0, terminalFailed: 0, expiredLeases: 0, remoteTotal: 0,
          remotePending: 0, remoteUploaded: 0, remoteVerified: 0, remoteFailed: 0,
          restore: { running: false },
        };
      },
    };
    const harness = makeHarness(registry);
    harness.files.clear();
    harness.binary.clear();
    harness.notes.clear();
    for (let index = 1; index <= 25; index += 1) {
      const stem = `91_assets/reconcile-${String(index).padStart(2, "0")}`;
      const original = new MockTFile(`${stem}.png`, 8, 10);
      const display = new MockTFile(`${stem}.webp`, 3, 11);
      harness.files.set(original.path, original);
      harness.files.set(display.path, display);
      harness.binary.set(original.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
      harness.binary.set(display.path, bytes([9, 8, 7]));
    }
    await harness.service.reconcileExistingDerivativesNow(20);
    assert.equal(discoveredPaths.length, 20, "A single reconciliation pass must be bounded to 20 existing pairs");
    await harness.service.reconcileExistingDerivativesNow(20);
    for (let index = 21; index <= 25; index += 1) {
      assert.ok(
        discoveredPaths.includes(`91_assets/reconcile-${String(index).padStart(2, "0")}.png`),
        "The reconciliation cursor must eventually reach assets after the first bounded page",
      );
    }
  }

  {
    const calls = [];
    const harness = makeHarness({
      async registerImageInPlace(path, refs) {
        calls.push({ path, refs });
        return { asset_id: "ast_0123456789abcdef01234567", status: "discovered", note_ref_count: refs.length };
      },
      async getAssetRegistrySummary() { return { total: 1, by_status: { discovered: 1 } }; },
      async enqueueImageAssetUpload() { throw new Error("registration must not enqueue uploads"); },
      async registerImageDerivative() { throw new Error("registration must not assume a derivative relationship"); },
    });
    const before = [...harness.files.keys()];
    const receipt = await harness.service.registerFileImagesInPlace(harness.note);
    assert.deepEqual(receipt, { total: 1, registered: 1, failed: 0 });
    assert.deepEqual(calls, [{ path: harness.source.path, refs: [harness.note.path] }]);
    assert.deepEqual([...harness.files.keys()], before);
    assert.deepEqual(harness.trashed, []);
    assert.equal(harness.notes.get(harness.note), "![[91_assets/source.png]]");
    const webp = new MockTFile("notes/assets/standalone.webp", 3);
    harness.files.set(webp.path, webp);
    harness.files.set("assets/.source-png/hidden.png", new MockTFile("assets/.source-png/hidden.png", 3));
    const inventory = harness.service.getLocalImageInventory();
    assert.equal(inventory.length, 2, "Inventory must include standalone WebP but exclude hidden source files");
    assert.equal(inventory.find(item => item.path === harness.source.path).noteCount, 1);
    await harness.service.registerFileImagesInPlace(webp);
    assert.equal(calls[1].path, webp.path);
  }

  {
    let attempts = 0;
    const registry = {
      async discoverImageAsset() {
        attempts += 1;
        if (attempts === 1) throw new Error("daemon temporarily offline");
        return { asset_id: "ast_0123456789abcdef01234567", status: "discovered", note_ref_count: 0 };
      },
      async registerImageDerivative(assetId) {
        return { asset_id: assetId, status: "derivative_ready", note_ref_count: 0 };
      },
      async enqueueImageAssetUpload(assetId) {
        return { upload_id: "upl_retry", asset_id: assetId, provider: "tencent_cos", status: "queued", reused: false };
      },
      async getAssetRegistrySummary() { return { total: 1, by_status: { derivative_ready: 1 } }; },
      async getAssetUploadStatus() {
        return {
          checkedAt: Date.now(), provider: "tencent_cos", enabled: true, configured: true, running: false,
          state: "pending", queued: 1, leased: 0, failed: 0, succeeded: 0, due: 1,
          retryableFailed: 0, terminalFailed: 0, expiredLeases: 0, remoteTotal: 0,
          remotePending: 0, remoteUploaded: 0, remoteVerified: 0, remoteFailed: 0,
          restore: { running: false },
        };
      },
    };
    const harness = makeHarness(registry);
    const existingWebp = new MockTFile("91_assets/source.webp", 3, 11);
    harness.files.set(existingWebp.path, existingWebp);
    harness.binary.set(existingWebp.path, bytes([9, 8, 7]));
    await harness.service.reconcileExistingDerivativesNow(20);
    await harness.service.reconcileExistingDerivativesNow(20);
    assert.equal(attempts, 2, "A failed reconcile must remain eligible for the next bounded pass");
    assert.ok(harness.logs.some(item => item.message.includes("补登记失败，下轮可重试")));
    assert.ok(harness.logs.some(item => item.message.includes("补登记与云上传排队")));
  }
} finally {
  globalThis.window = realWindow;
  globalThis.fetch = realFetch;
}

console.log("Asset Registry + cloud outbox bridge contract: 74/74 passed");
