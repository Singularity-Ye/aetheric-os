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

const settingsCompiled = compileCommonJs(new URL("../src/settings.ts", import.meta.url), name => {
  if (name === "obsidian") {
    return {
      PluginSettingTab: class {},
      Setting: class {},
    };
  }
  if (name === "./main") return {};
  if (name === "./aetheric/types") {
    return {
      DEFAULT_SHELL_STATE: { moduleLayout: [], logDock: { open: true } },
      DEFAULT_WORKSPACES: [],
      normalizeModuleLayout: value => value ?? [],
    };
  }
  if (name === "./aetheric/WorkspaceKeymap") {
    return {
      DEFAULT_WORKSPACE_SHORTCUTS: { openOverview: "1" },
      migrateLegacyWorkspaceShortcuts: value => value ?? { openOverview: "1" },
      normalizeWorkspaceShortcuts: value => value ?? { openOverview: "1" },
    };
  }
  throw new Error(`Unexpected settings dependency: ${name}`);
});

const {
  DEFAULT_IMAGE_GOVERNANCE,
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeImageGovernanceHistory,
} = settingsCompiled.exports;
assert.equal(DEFAULT_SETTINGS.schemaVersion, 9);
assert.equal(DEFAULT_IMAGE_GOVERNANCE.autoCompress, false);
assert.equal(DEFAULT_IMAGE_GOVERNANCE.minBytes, 192 * 1024);
assert.equal(mergeSettings(null).imageGovernance.autoCompress, false);
assert.equal(
  mergeSettings({ schemaVersion: 6, imageGovernance: { ...DEFAULT_IMAGE_GOVERNANCE, autoCompress: true } })
    .imageGovernance.autoCompress,
  false,
  "A pre-v7 true value came from the old unsafe default and must be migrated off",
);
assert.equal(
  mergeSettings({ schemaVersion: 7, imageGovernance: { ...DEFAULT_IMAGE_GOVERNANCE, autoCompress: true } })
    .imageGovernance.autoCompress,
  true,
  "An explicit v7 opt-in must be preserved",
);
const dirtyHistory = Array.from({ length: 22 }, (_, index) => ({
  manifestId: `batch-${index}`,
  createdAt: index,
  finishedAt: index + 1,
  paths: ["assets/good.png", "../escape.png", ...Array.from({ length: 12 }, (__, item) => `assets/${item}.png`)],
  totalBytes: -1,
  bytesBefore: Number.NaN,
  bytesAfter: 2,
  results: [
    { path: "assets/good.png", status: "converted", beforeBytes: 10, afterBytes: 4, rewrittenNoteCount: 1, rewrittenTokenCount: 2 },
    { path: "../escape.png", status: "failed", beforeBytes: 0, error: "x" },
    { path: "assets/bad.png", status: "unknown", beforeBytes: 2 },
    { path: "assets/fails.png", status: "failed", beforeBytes: -5, error: "z".repeat(500) },
  ],
}));
const normalizedHistory = normalizeImageGovernanceHistory(dirtyHistory);
assert.equal(normalizedHistory.length, 20, "Persistent history must retain at most 20 batches");
assert.equal(normalizedHistory[0].paths.length, 10, "Each persisted manifest must retain at most 10 legal paths");
assert.deepEqual(normalizedHistory[0].results.map(item => item.status), ["converted", "failed"]);
assert.equal(normalizedHistory[0].results[0].rewrittenNoteCount, 1);
assert.equal(normalizedHistory[0].results[0].rewrittenTokenCount, 2);
    assert.equal(normalizedHistory[0].results[1].beforeBytes, 0);
assert.equal(normalizedHistory[0].results[1].error.length, 300);
    assert.equal(normalizedHistory[0].totalBytes, 0);
assert.deepEqual(normalizeImageGovernanceHistory(null), []);
assert.ok(settingsCompiled.source.includes("当前绝不自动删除或移入回收站"));
const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
assert.ok(
  mainSource.includes("(raw?.schemaVersion ?? 0) !== this.settings.schemaVersion")
    && mainSource.includes("await this.saveData(this.settings)"),
  "Safety migrations must be persisted immediately instead of living only in memory",
);
assert.ok(
  mainSource.includes("image-governance-compress-active-image")
    && mainSource.includes("governSingleImageNow(file.path, { ignoreMinBytes: true })"),
  "The explicit one-image command must not fall back to a whole-Vault batch",
);
assert.ok(
  mainSource.includes("图片治理：打开历史图片候选清单")
    && mainSource.includes("showImageGovernanceCandidates()")
    && !mainSource.includes("callback: () => void this.imageGovernance.scanNow(true)"),
  "The legacy batch command id must open the preview surface instead of mutating the Vault blindly",
);
const shellSource = fs.readFileSync(new URL("../src/aetheric/AethericShellView.ts", import.meta.url), "utf8");
assert.ok(
  shellSource.includes("加载候选清单")
    && shellSource.includes("governSelectedImagesNow(")
    && !shellSource.includes("压缩一批（最多 10 张）"),
  "The workbench must preview explicit candidates instead of launching a blind whole-Vault batch",
);
assert.ok(
  shellSource.includes("visibleImageGovernanceCandidates()")
    && shellSource.includes("filter(item => item.selectableByDefault)")
    && shellSource.includes("getBatchHistory().slice(0, 5)")
    && shellSource.includes("退役来源")
    && shellSource.includes("运维证据"),
  "The workbench must filter and sort candidates, avoid auto-selecting risk items, and render persisted history",
);
assert.ok(
  mainSource.includes("normalizeImageGovernanceHistory(history)")
    && mainSource.includes("this.settings.imageGovernanceHistory"),
  "All service entry points must share the plugin data.json batch ledger",
);

const serviceCompiled = compileCommonJs(new URL("../src/aetheric/ImageGovernanceService.ts", import.meta.url), name => {
  if (name === "obsidian") return { TFile: MockTFile };
  if (name === "./LogBus") return {};
  throw new Error(`Unexpected service dependency: ${name}`);
});
const {
  ImageGovernanceService,
  classifyImageGovernanceCandidate,
  sortImageGovernanceCandidates,
} = serviceCompiled.exports;
assert.ok(!serviceCompiled.source.includes("this.app.vault.trash(file"));
assert.ok(serviceCompiled.source.includes("原图保留待 Asset Registry 云端验签"));
assert.ok(serviceCompiled.source.includes("MAX_NEW_CONVERSIONS_PER_PASS = 10"));
assert.ok(serviceCompiled.source.includes("hasHiddenDirectorySegment"));

class FakeClock {
  now = 0;
  nextId = 1;
  tasks = new Map();

  setTimeout(callback, delay = 0) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, at: this.now + Math.max(0, Number(delay) || 0) });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  async advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const ready = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!ready) break;
      const [id, task] = ready;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
      await flushAsync();
    }
    this.now = target;
    await flushAsync();
  }
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

function bytes(values) {
  return Uint8Array.from(values).buffer;
}

function makeHarness({
  debounceMs = 100,
  autoCompress = true,
  assetRegistry,
  batchHistory = [],
  persistBatchHistory,
} = {}) {
  const files = new Map();
  const binary = new Map();
  const notes = new Map();
  const trashed = [];
  const logs = [];
  let history = normalizeImageGovernanceHistory(batchHistory);
  const historyWrites = [];
  const settings = {
    enabled: true,
    autoCompress,
    minBytes: 1,
    quality: 0.82,
    maxDimension: 2400,
    minSavingsRatio: 0.9,
    debounceMs,
  };
  const vault = {
    on() { return {}; },
    getFiles() { return [...files.values()]; },
    getMarkdownFiles() { return [...notes.keys()]; },
    getAbstractFileByPath(path) { return files.get(path) ?? null; },
    async readBinary(file) { return binary.get(file.path); },
    async createBinary(path, data) {
      const file = new MockTFile(path, data.byteLength, 1);
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
  const app = {
    vault,
    metadataCache: {
      resolvedLinks: {},
      getFirstLinkpathDest() { return null; },
    },
  };
  const service = new ImageGovernanceService(
    app,
    { registerEvent() {} },
    { append(level, channel, message) { logs.push({ level, channel, message }); } },
      () => settings,
      assetRegistry,
      () => history,
      async next => {
        if (persistBatchHistory) await persistBatchHistory(next);
        history = normalizeImageGovernanceHistory(next);
        historyWrites.push(history);
      },
    );
  return {
    app, binary, files, historyWrites, logs, notes, service, settings, trashed, vault,
    get history() { return history; },
  };
}

const realWindow = globalThis.window;
const realDateNow = Date.now;
try {
  {
    let uploadRuns = 0;
    const registry = {
      async getAssetRegistrySummary() {
        return { total: 1, by_status: { derivative_ready: 1 } };
      },
      async getAssetUploadStatus() {
        return {
          checkedAt: Date.now(), provider: "tencent_cos", enabled: true, configured: true, running: false,
          state: "pending", queued: 1, leased: 0, failed: 0, succeeded: 0, due: 1,
          retryableFailed: 0, terminalFailed: 0, expiredLeases: 0, remoteTotal: 1,
          remotePending: 0, remoteUploaded: 0, remoteVerified: 1, remoteVerifiedAssets: 1, remoteFailed: 0,
          restore: { running: true },
        };
      },
      async runAssetUpload() {
        uploadRuns += 1;
        return { jobId: "must-not-run", status: "queued", provider: "tencent_cos", limit: 20 };
      },
    };
    const harness = makeHarness({ autoCompress: false, assetRegistry: registry });
    await harness.service.refreshRegistrySummary();
    await assert.rejects(
      () => harness.service.runPendingUploads(20),
      /图片恢复抽检正在运行/,
      "Upload submission must be rejected while a restore drill is running",
    );
    assert.equal(uploadRuns, 0, "The restore/upload interlock must reject before calling the daemon");
  }

  {
    globalThis.window = { setTimeout, clearTimeout };
    Date.now = realDateNow;
    const harness = makeHarness();
    const hidden = new MockTFile("output/imagegen/.source-png/master.png", 1024, 1);
    const hiddenWebp = new MockTFile("output/imagegen/.source-png/master.webp", 256, 1);
    harness.files.set(hidden.path, hidden);
    harness.files.set(hiddenWebp.path, hiddenWebp);
    let optimizeCalls = 0;
    harness.service.optimizeFile = async () => { optimizeCalls += 1; };

    harness.service.handleVaultFile(hidden);
    assert.equal(harness.service.getSnapshot().pending, 0, "Hidden source directories must never enter auto governance");
    await harness.service.scanNow(true);
    assert.equal(optimizeCalls, 0, "Hidden source directories must never enter manual governance");
    assert.equal(harness.service.getSnapshot().scanned, 0);
  }

  {
    globalThis.window = { setTimeout, clearTimeout };
    Date.now = realDateNow;
    const harness = makeHarness();
    for (let index = 0; index < 25; index += 1) {
      const file = new MockTFile(`assets/manual-${String(index).padStart(2, "0")}.png`, 1024, index + 1);
      harness.files.set(file.path, file);
    }
    const optimized = [];
    harness.service.optimizeFile = async file => { optimized.push(file.path); };

    await harness.service.scanNow(true);
    assert.equal(optimized.length, 10, "A manual pass must attempt at most ten new encodes");
    assert.ok(harness.logs.some(item => item.message.includes("另有 15 张保留到下批")));
  }

  {
    const clock = new FakeClock();
    globalThis.window = {
      setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
      clearTimeout: id => clock.clearTimeout(id),
    };
    Date.now = () => clock.now;
    const harness = makeHarness({ debounceMs: 0 });
    const optimized = [];
    harness.service.optimizeFile = async file => { optimized.push(file.path); };
    for (let index = 0; index < 25; index += 1) {
      const file = new MockTFile(`assets/auto-${String(index).padStart(2, "0")}.png`, 1024, index + 1);
      harness.files.set(file.path, file);
      harness.service.handleVaultFile(file);
    }

    await clock.advance(0);
    assert.equal(optimized.length, 10, "The first automatic drain must stop at ten files");
    assert.equal(harness.service.getSnapshot().pending, 15, "Ready overflow must remain queued");
    await clock.advance(1000);
    assert.equal(optimized.length, 20, "The second automatic batch may resume after the cooldown");
    assert.equal(harness.service.getSnapshot().pending, 5);
    await clock.advance(1000);
    assert.equal(optimized.length, 25);
    assert.equal(harness.service.getSnapshot().pending, 0);
  }

  {
    globalThis.window = { setTimeout, clearTimeout };
    Date.now = realDateNow;
    let discoverCalls = 0;
    const registry = {
      async discoverImageAsset() {
        discoverCalls += 1;
        return { asset_id: `asset-${discoverCalls}`, status: "discovered", note_ref_count: 0 };
      },
      async registerImageDerivative(assetId) {
        return { asset_id: assetId, status: "derivative_ready", note_ref_count: 0 };
      },
      async enqueueImageAssetUpload(assetId) {
        return { upload_id: `upload-${assetId}`, asset_id: assetId, provider: "tencent_cos", status: "queued", reused: false };
      },
      async getAssetRegistrySummary() { return { total: discoverCalls, by_status: { derivative_ready: discoverCalls } }; },
      async getAssetUploadStatus() {
        return {
          checkedAt: Date.now(), provider: "tencent_cos", enabled: true, configured: true, running: false,
          state: "pending", queued: discoverCalls, leased: 0, failed: 0, succeeded: 0, due: discoverCalls,
          retryableFailed: 0, terminalFailed: 0, expiredLeases: 0, remoteTotal: 0,
          remotePending: 0, remoteUploaded: 0, remoteVerified: 0, remoteVerifiedAssets: 0, remoteFailed: 0,
          restore: { running: false },
        };
      },
    };
    const harness = makeHarness({ assetRegistry: registry });
    const hidden = new MockTFile("assets/.source-png/hidden.png", 1024, 1);
    const hiddenDisplay = new MockTFile("assets/.source-png/hidden.webp", 256, 1);
    const visible = new MockTFile("assets/visible.png", 1024, 1);
    const visibleDisplay = new MockTFile("assets/visible.webp", 256, 1);
    for (const file of [hidden, hiddenDisplay, visible, visibleDisplay]) harness.files.set(file.path, file);
    harness.service.encodeWebp = async () => { throw new Error("Existing WebP pairs must never be encoded"); };

    await harness.service.scanNow(false);
    assert.equal(harness.service.getSnapshot().candidates, 0, "Existing WebP pairs are not pending compression");
    await harness.service.reconcileExistingDerivativesNow(20);
    assert.equal(discoverCalls, 1, "Explicit reconciliation must include only the visible pair");
    assert.ok(harness.logs.some(item => item.message.includes("visible.png") && item.message.includes("补登记")));
  }

  {
    assert.equal(
      classifyImageGovernanceCandidate("assets/referenced.png", 2).kind,
      "recommended",
    );
    assert.equal(
      classifyImageGovernanceCandidate("assets/orphan.png", 0).kind,
      "unreferenced",
    );
    assert.equal(
      classifyImageGovernanceCandidate("00_松果池（收件箱）/小红书/old.png", 4).kind,
      "retired_source",
    );
    assert.equal(
      classifyImageGovernanceCandidate("02_丹炉间（项目区）/松果天工台（Aetheric OS）/91_笔记内嵌图片/server.png", 3).kind,
      "operational_evidence",
    );
    assert.equal(
      classifyImageGovernanceCandidate("00_松果池（收件箱）/小红书/old.png", 4).selectableByDefault,
      false,
      "Risk-classified sources must never be auto-selected",
    );
    const sortable = [
      { path: "b", bytes: 20, modifiedAt: 30, referenceCount: 1 },
      { path: "a", bytes: 40, modifiedAt: 10, referenceCount: 1 },
      { path: "c", bytes: 10, modifiedAt: 20, referenceCount: 5 },
    ];
    assert.deepEqual(sortImageGovernanceCandidates(sortable, "largest").map(item => item.path), ["a", "b", "c"]);
    assert.deepEqual(sortImageGovernanceCandidates(sortable, "newest").map(item => item.path), ["b", "c", "a"]);
    assert.deepEqual(sortImageGovernanceCandidates(sortable, "most-referenced").map(item => item.path), ["c", "a", "b"]);
  }

  {
    const harness = makeHarness();
    const source = new MockTFile("assets/collision.png", 1024, 1);
    const display = new MockTFile("assets/collision.webp", 256, 1);
    harness.files.set(source.path, source);
    harness.files.set(display.path, display);
    let encodeCalls = 0;
    harness.service.encodeWebp = async () => {
      encodeCalls += 1;
      return { data: bytes([1]), mime: "image/webp", width: 1, height: 1 };
    };

    await harness.service.optimizeFile(source);
    assert.equal(encodeCalls, 0, "A same-name WebP must short-circuit before encoding");
    assert.ok(harness.logs.some(item => item.message.includes("未自动认定衍生关系")));
  }

  {
    const clock = new FakeClock();
    globalThis.window = {
      setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
      clearTimeout: id => clock.clearTimeout(id),
    };
    Date.now = () => clock.now;
    const harness = makeHarness({ debounceMs: 100 });
    const file = new MockTFile("assets/debounce.png", 10, 1);
    harness.files.set(file.path, file);
    const optimized = [];
    harness.service.optimizeFile = async current => { optimized.push(current.path); };

    harness.service.handleVaultFile(file);
    await clock.advance(60);
    file.stat.mtime = 2;
    harness.service.handleVaultFile(file);
    await clock.advance(40);
    assert.deepEqual(optimized, [], "The first event deadline must be cancelled");
    await clock.advance(60);
    assert.deepEqual(optimized, [file.path], "Only the last create/modify event may release the file");
  }

  {
    const clock = new FakeClock();
    globalThis.window = {
      setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
      clearTimeout: id => clock.clearTimeout(id),
    };
    Date.now = () => clock.now;
    const harness = makeHarness({ debounceMs: 50 });
    const first = new MockTFile("assets/first.png", 10, 1);
    const second = new MockTFile("assets/second.png", 10, 1);
    harness.files.set(first.path, first);
    harness.files.set(second.path, second);
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const optimized = [];
    harness.service.optimizeFile = async current => {
      optimized.push(current.path);
      if (current === first) await firstGate;
    };

    harness.service.handleVaultFile(first);
    await clock.advance(50);
    assert.deepEqual(optimized, [first.path]);
    harness.service.handleVaultFile(second);
    await clock.advance(100);
    assert.deepEqual(optimized, [first.path], "A busy drain must not run a second overlapping drain");
    releaseFirst();
    await flushAsync();
    await clock.advance(1000);
    assert.deepEqual(optimized, [first.path, second.path], "Queued work must wake after the busy drain finishes");
  }

  {
    const clock = new FakeClock();
    globalThis.window = {
      setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
      clearTimeout: id => clock.clearTimeout(id),
    };
    Date.now = () => clock.now;
    const harness = makeHarness({ debounceMs: 50 });
    const file = new MockTFile("assets/stability.png", 10, 1);
    harness.files.set(file.path, file);
    const optimized = [];
    harness.service.optimizeFile = async current => { optimized.push(current.path); };

    harness.service.handleVaultFile(file);
    file.stat.size = 11;
    file.stat.mtime = 2;
    await clock.advance(50);
    assert.deepEqual(optimized, [], "A silent size/mtime change must fail the preflight stability gate");
    assert.equal(harness.service.getSnapshot().pending, 1);
    assert.ok(harness.logs.some(item => item.message.includes("已延后自动处理")));
    await clock.advance(1000);
    assert.deepEqual(optimized, [file.path]);
  }

  {
    globalThis.window = { setTimeout, clearTimeout };
    Date.now = realDateNow;
    const harness = makeHarness();
    const source = new MockTFile("assets/identity.png", 8, 10);
    harness.files.set(source.path, source);
    harness.binary.set(source.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    let createCalls = 0;
    harness.vault.createBinary = async () => { createCalls += 1; throw new Error("must not create"); };
    harness.service.encodeWebp = async () => {
      source.stat.mtime = 11;
      return { data: bytes([1, 2, 3]), mime: "image/webp", width: 1, height: 1 };
    };
    await assert.rejects(() => harness.service.optimizeFile(source), /图片在压缩期间仍被写入/);
    assert.equal(createCalls, 0);
    assert.deepEqual(harness.trashed, []);
  }

  {
    const harness = makeHarness();
    const source = new MockTFile("assets/readback.png", 8, 10);
    harness.files.set(source.path, source);
    harness.binary.set(source.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    harness.service.encodeWebp = async () => ({
      data: bytes([9, 9, 9]), mime: "image/webp", width: 1, height: 1,
    });
    const normalRead = harness.vault.readBinary;
    harness.vault.readBinary = async file => file.extension === "webp"
      ? bytes([9, 9, 8])
      : normalRead(file);
    harness.service.rewriteReferences = async () => { throw new Error("readback gate was bypassed"); };

    await assert.rejects(() => harness.service.optimizeFile(source), /WebP 写入后字节校验失败/);
    assert.deepEqual(harness.trashed, ["assets/readback.webp"]);
    assert.equal(harness.files.get(source.path), source, "The original must never be trashed on failure");
  }

  {
    const harness = makeHarness();
    const source = new MockTFile("assets/success.png", 8, 10);
    harness.files.set(source.path, source);
    harness.binary.set(source.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    harness.service.encodeWebp = async () => ({
      data: bytes([7, 8, 9]), mime: "image/webp", width: 1, height: 1,
    });
    harness.service.rewriteReferences = async () => [];

    await harness.service.optimizeFile(source);
    assert.deepEqual(harness.trashed, [], "A successful conversion must retain the original image");
    assert.equal(harness.files.get(source.path), source);
    assert.ok(harness.files.has("assets/success.webp"));
    assert.ok(harness.logs.some(item => item.message.includes("原图保留待 Asset Registry 云端验签")));
    assert.equal(harness.service.getSnapshot().converted, 1);
  }

  {
    const harness = makeHarness();
    harness.settings.minBytes = 256 * 1024;
    const selected = new MockTFile("assets/selected-small.png", 8, 10);
    const unrelated = new MockTFile("assets/unrelated-large.png", 512 * 1024, 10);
    harness.files.set(selected.path, selected);
    harness.files.set(unrelated.path, unrelated);
    harness.binary.set(selected.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    harness.binary.set(unrelated.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    let encodeCalls = 0;
    harness.service.encodeWebp = async () => {
      encodeCalls += 1;
      return { data: bytes([7, 8, 9]), mime: "image/webp", width: 1, height: 1 };
    };
    harness.service.rewriteReferences = async () => [];

    const snapshot = await harness.service.governSingleImageNow(
      selected.path,
      { ignoreMinBytes: true },
    );
    assert.equal(encodeCalls, 1, "The single-image action must encode exactly the selected file");
    assert.equal(snapshot.scanned, 1);
    assert.equal(snapshot.converted, 1);
    assert.ok(harness.files.has("assets/selected-small.webp"));
    assert.ok(!harness.files.has("assets/unrelated-large.webp"), "No unrelated image may be touched");
    assert.equal(harness.files.get(selected.path), selected, "The selected source must be retained");
  }

  {
    const registryCalls = [];
    const registry = {
      async discoverImageAsset(path, refs) {
        registryCalls.push(["discover", path, refs]);
        return { asset_id: "ast_suffix", status: "discovered", note_ref_count: refs.length };
      },
      async registerImageDerivative(assetId, path) {
        registryCalls.push(["derivative", assetId, path]);
        return { asset_id: assetId, status: "derivative_ready", note_ref_count: 1 };
      },
      async enqueueImageAssetUpload(assetId, originalPath, displayPath) {
        registryCalls.push(["enqueue", assetId, originalPath, displayPath]);
        return { upload_id: "upl_suffix", asset_id: assetId, provider: "tencent_cos", status: "queued", reused: false };
      },
      async getAssetRegistrySummary() {
        return { total: 1, by_status: { derivative_ready: 1 } };
      },
    };
    const harness = makeHarness({ assetRegistry: registry });
    const source = new MockTFile(
      "02_projects/novelist/91_assets/vnext-world-lab-desktop.png",
      8,
      10,
    );
    const note = new MockTFile("02_projects/novelist/06_notes/design.md", 64, 1);
    harness.files.set(source.path, source);
    harness.files.set(note.path, note);
    harness.binary.set(source.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    harness.notes.set(
      note,
      "![[91_assets/vnext-world-lab-desktop.png|桌面图]]\n![[91_assets/unrelated.png]]",
    );
    harness.app.metadataCache.resolvedLinks = { [note.path]: { [source.path]: 1 } };
    harness.app.metadataCache.getFirstLinkpathDest = linkpath => (
      linkpath === "91_assets/vnext-world-lab-desktop.png" ? source : null
    );
    harness.service.encodeWebp = async () => ({
      data: bytes([7, 8, 9]), mime: "image/webp", width: 1, height: 1,
    });

    await harness.service.governSingleImageNow(source.path, { ignoreMinBytes: true });
    assert.equal(
      harness.notes.get(note),
      "![[91_assets/vnext-world-lab-desktop.webp|桌面图]]\n![[91_assets/unrelated.png]]",
      "A resolved shortest-suffix Wiki image must change extension without touching unrelated links",
    );
    assert.deepEqual(
      registryCalls[0],
      ["discover", source.path, [note.path]],
      "The Registry must receive the exact note whose suffix Wiki token was repaired",
    );
    assert.equal(registryCalls[2][0], "enqueue");
  }

  {
    const harness = makeHarness();
    const source = new MockTFile("notes/assets/img-004.jpg", 8, 10);
    const note = new MockTFile("notes/compiler.md", 128, 1);
    harness.files.set(source.path, source);
    harness.files.set(note.path, note);
    harness.notes.set(
      note,
      "![preview](img-004.jpg)\n![angled](<img-004.jpg> \"title\")\n![external](https://example.com/img-004.jpg)",
    );
    harness.app.metadataCache.resolvedLinks = { [note.path]: { [source.path]: 2 } };
    harness.app.metadataCache.getFirstLinkpathDest = linkpath => (
      linkpath === "img-004.jpg" ? source : null
    );

    const changed = await harness.service.rewriteReferences(source, "notes/assets/img-004.webp");
    assert.equal(changed.length, 1);
    assert.equal(changed[0].rewrittenTokens, 2);
    assert.equal(
      harness.notes.get(note),
      "![preview](img-004.webp)\n![angled](<img-004.webp> \"title\")\n![external](https://example.com/img-004.jpg)",
      "Resolved shortest-name Markdown destinations must change extension while titles and external URLs stay intact",
    );
  }

  {
    globalThis.window = { setTimeout, clearTimeout };
    const harness = makeHarness();
    const source = new MockTFile("notes/assets/img-batch.jpg", 8, 10);
    const note = new MockTFile("notes/batch.md", 64, 1);
    harness.files.set(source.path, source);
    harness.files.set(note.path, note);
    harness.binary.set(source.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    harness.notes.set(note, "![preview](img-batch.jpg)");
    harness.app.metadataCache.resolvedLinks = { [note.path]: { [source.path]: 1 } };
    harness.app.metadataCache.getFirstLinkpathDest = linkpath => linkpath === "img-batch.jpg" ? source : null;
    harness.service.encodeWebp = async () => ({
      data: bytes([7, 8, 9]), mime: "image/webp", width: 1, height: 1,
    });

    const receipt = await harness.service.governSelectedImagesNow([source.path]);
    assert.equal(receipt.results[0].status, "converted");
    assert.equal(receipt.results[0].rewrittenNoteCount, 1);
    assert.equal(receipt.results[0].rewrittenTokenCount, 1);
    assert.equal(harness.history[0].results[0].rewrittenNoteCount, 1);
    assert.equal(harness.history[0].results[0].rewrittenTokenCount, 1);
  }

  {
    const harness = makeHarness();
    const source = new MockTFile("notes/assets/unhandled.png", 8, 10);
    const note = new MockTFile("notes/unhandled.md", 64, 1);
    harness.files.set(source.path, source);
    harness.files.set(note.path, note);
    harness.binary.set(source.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    harness.notes.set(note, "custom-embed: unhandled.png");
    harness.app.metadataCache.resolvedLinks = { [note.path]: { [source.path]: 1 } };
    harness.app.metadataCache.getFirstLinkpathDest = () => null;
    harness.service.encodeWebp = async () => ({
      data: bytes([7, 8, 9]), mime: "image/webp", width: 1, height: 1,
    });

    await assert.rejects(
      () => harness.service.optimizeFile(source),
      /引用完整性门失败/,
      "A known referenced image must fail closed when no actual note token was rewritten",
    );
    assert.equal(harness.notes.get(note), "custom-embed: unhandled.png");
    assert.equal(harness.files.get(source.path), source);
    assert.ok(!harness.files.has("notes/assets/unhandled.webp"));
    assert.deepEqual(harness.trashed, ["notes/assets/unhandled.webp"]);
  }

  {
    const harness = makeHarness();
    const hidden = new MockTFile("assets/.source-png/hidden.png", 8, 10);
    const webp = new MockTFile("assets/already.webp", 8, 10);
    const note = new MockTFile("notes/not-an-image.md", 8, 10);
    harness.files.set(hidden.path, hidden);
    harness.files.set(webp.path, webp);
    harness.files.set(note.path, note);
    await assert.rejects(() => harness.service.governSingleImageNow("../escape.png"), /规范相对路径/);
    await assert.rejects(() => harness.service.governSingleImageNow("C:/outside.png"), /规范相对路径/);
    await assert.rejects(() => harness.service.governSingleImageNow(hidden.path), /不允许进入图片治理/);
    await assert.rejects(() => harness.service.governSingleImageNow(webp.path), /已经是 WebP/);
    await assert.rejects(() => harness.service.governSingleImageNow(note.path), /不允许进入图片治理/);
    assert.equal(harness.files.size, 3, "Rejected single-image requests must not create or delete files");
  }

  {
    const harness = makeHarness();
    harness.settings.minBytes = 100;
    const largest = new MockTFile("assets/largest.png", 900, 10);
    const newer = new MockTFile("assets/newer.jpg", 500, 20);
    const targetExists = new MockTFile("assets/paired.png", 800, 30);
    const targetWebp = new MockTFile("assets/paired.webp", 200, 30);
    const hidden = new MockTFile("assets/.source-png/master.png", 1200, 40);
    const small = new MockTFile("assets/small.png", 20, 50);
    for (const file of [largest, newer, targetExists, targetWebp, hidden, small]) harness.files.set(file.path, file);
    harness.app.metadataCache.resolvedLinks = {
      "notes/use-largest.md": { [largest.path]: 1 },
      "notes/use-both.md": { [largest.path]: 1, [newer.path]: 1 },
    };

    assert.deepEqual(
      harness.service.listGovernanceCandidates(20),
      [
        {
          path: largest.path, name: largest.name, bytes: 900, modifiedAt: 10,
          displayPath: "assets/largest.webp", referenceCount: 2,
          area: "assets", kind: "recommended", selectableByDefault: true,
          reason: "已有 2 条明确引用，适合优先生成轻量显示版本",
        },
        {
          path: newer.path, name: newer.name, bytes: 500, modifiedAt: 20,
          displayPath: "assets/newer.webp", referenceCount: 1,
          area: "assets", kind: "recommended", selectableByDefault: true,
          reason: "已有 1 条明确引用，适合优先生成轻量显示版本",
        },
      ],
      "Candidate projection must be read-only, stable, and exclude hidden/small/already-paired files",
    );
  }

  {
    const harness = makeHarness();
    const inputs = [];
    let optimizeCalls = 0;
    harness.service.optimizeFile = async () => { optimizeCalls += 1; };
    for (let index = 0; index < 11; index += 1) {
      const file = new MockTFile(`assets/overflow-${index}.png`, 200 + index, index + 1);
      harness.files.set(file.path, file);
      inputs.push(file.path);
    }
    await assert.rejects(
      () => harness.service.governSelectedImagesNow(inputs),
      /本次收到 11 张，未执行任何写入/,
      "An oversized explicit batch must be rejected before any mutation",
    );
    assert.equal(optimizeCalls, 0);
    assert.equal(harness.historyWrites.length, 0, "A rejected oversized batch must not create a ledger entry");
  }

  {
    globalThis.window = { setTimeout, clearTimeout };
    Date.now = () => 123456;
    const harness = makeHarness();
    const selected = new MockTFile("assets/selected.png", 321, 10);
    const decoy = new MockTFile("assets/decoy.png", 654, 20);
    harness.files.set(selected.path, selected);
    harness.files.set(decoy.path, decoy);
    const optimized = [];
    harness.service.optimizeFile = async file => { optimized.push(file.path); };

    const receipt = await harness.service.governSelectedImagesNow([
      selected.path,
      selected.path,
      "../escape.png",
      "notes/not-an-image.md",
    ]);
    assert.deepEqual(optimized, [selected.path], "Only the unique, explicitly selected legal image may be attempted");
    assert.ok(!optimized.includes(decoy.path), "A decoy must remain untouched");
    assert.deepEqual(receipt.manifest.paths, [selected.path]);
    assert.equal(receipt.manifest.totalBytes, 321);
    assert.match(receipt.manifest.manifestId, /^igb_2n9c_[0-9a-f]{8}$/);
    assert.equal(receipt.results.filter(item => item.status === "failed").length, 2);
    assert.equal(receipt.results.filter(item => item.path === selected.path).length, 1, "Duplicate paths must de-duplicate");
    assert.equal(harness.history.length, 1, "A direct service batch call must persist its receipt");
    assert.equal(harness.history[0].manifestId, receipt.manifest.manifestId);
    assert.ok(!harness.history[0].results.some(item => item.path === "../escape.png"));
    assert.deepEqual(harness.service.getBatchHistory(), harness.history);
  }

  {
    globalThis.window = { setTimeout, clearTimeout };
    Date.now = realDateNow;
    const harness = makeHarness();
    const first = new MockTFile("assets/fails.png", 300, 10);
    const second = new MockTFile("assets/continues.png", 400, 20);
    harness.files.set(first.path, first);
    harness.files.set(second.path, second);
    const attempted = [];
    harness.service.optimizeFile = async file => {
      attempted.push(file.path);
      if (file === first) throw new Error("synthetic isolated failure");
    };

    const receipt = await harness.service.governSelectedImagesNow([first.path, second.path]);
    assert.deepEqual(attempted, [first.path, second.path], "One item failure must not abort later selected items");
    assert.equal(receipt.results[0].status, "failed");
    assert.equal(receipt.results[1].status, "skipped");
    assert.equal(harness.history[0].failed, 1, "Partial-failure batches must still be persisted");
    assert.equal(harness.history[0].skipped, 1);
    assert.equal(harness.files.get(first.path), first);
    assert.equal(harness.files.get(second.path), second);
    assert.deepEqual(harness.trashed, [], "Batch failure isolation must retain every source file");
  }

  {
    globalThis.window = { setTimeout, clearTimeout };
    const harness = makeHarness({
      persistBatchHistory: async () => { throw new Error("synthetic data.json failure"); },
    });
    const source = new MockTFile("assets/persist-fails.png", 300, 10);
    harness.files.set(source.path, source);
    harness.service.optimizeFile = async () => {};
    const receipt = await harness.service.governSelectedImagesNow([source.path]);
    assert.equal(receipt.results[0].status, "skipped");
    assert.equal(harness.historyWrites.length, 0);
    assert.ok(
      harness.logs.some(item => item.channel === "image.governance.history" && item.message.includes("批次已安全完成")),
      "Ledger persistence failure must be visible without rolling back completed image work",
    );
    assert.equal(harness.files.get(source.path), source);
  }

  {
    const harness = makeHarness();
    const source = new MockTFile("assets/rollback.png", 8, 10);
    const note = new MockTFile("notes/example.md", 6, 1);
    harness.files.set(source.path, source);
    harness.files.set(note.path, note);
    harness.binary.set(source.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    harness.notes.set(note, "before");
    harness.service.encodeWebp = async () => ({
      data: bytes([7, 8, 9]), mime: "image/webp", width: 1, height: 1,
    });
    harness.service.rewriteReferences = async () => {
      await harness.vault.modify(note, "after");
      source.stat.mtime = 11;
      return [{ file: note, before: "before" }];
    };

    await assert.rejects(() => harness.service.optimizeFile(source), /图片在压缩期间仍被写入/);
    assert.equal(harness.notes.get(note), "before", "Reference writes must roll back after a late identity failure");
    assert.deepEqual(harness.trashed, ["assets/rollback.webp"]);
    assert.equal(harness.files.get(source.path), source);
  }

  {
    const harness = makeHarness();
    const source = new MockTFile("assets/rollback-incomplete.png", 8, 10);
    const firstNote = new MockTFile("notes/first.md", 32, 1);
    const secondNote = new MockTFile("notes/second.md", 32, 1);
    harness.files.set(source.path, source);
    harness.files.set(firstNote.path, firstNote);
    harness.files.set(secondNote.path, secondNote);
    harness.binary.set(source.path, bytes([1, 2, 3, 4, 5, 6, 7, 8]));
    harness.notes.set(firstNote, `![[${source.path}]]`);
    harness.notes.set(secondNote, `![[${source.path}]]`);
    harness.app.metadataCache.resolvedLinks = {
      [firstNote.path]: { [source.path]: 1 },
      [secondNote.path]: { [source.path]: 1 },
    };
    harness.service.encodeWebp = async () => ({
      data: bytes([7, 8, 9]), mime: "image/webp", width: 1, height: 1,
    });
    const normalModify = harness.vault.modify;
    harness.vault.modify = async (file, value) => {
      if (file === secondNote && value.includes(".webp")) throw new Error("second write failed");
      if (file === firstNote && value.includes("rollback-incomplete.png")) throw new Error("first rollback failed");
      return normalModify(file, value);
    };

    await assert.rejects(
      () => harness.service.optimizeFile(source),
      /引用回滚不完整/,
      "An incomplete Markdown rollback must become an explicit repair state",
    );
    assert.ok(harness.files.has("assets/rollback-incomplete.webp"), "The WebP must remain while any note may still reference it");
    assert.deepEqual(harness.trashed, [], "Incomplete rollback must never delete the WebP target");
    assert.ok(harness.logs.some(item => item.message.includes("已保留 WebP 防止形成断链")));
  }
} finally {
  Date.now = realDateNow;
  globalThis.window = realWindow;
}

console.log("Image governance safety gate: 86/86 passed");
