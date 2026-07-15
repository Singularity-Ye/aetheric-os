import * as fs from "fs";
import * as path from "path";
import { build } from "esbuild";

console.log("=========================================");
console.log("编译并对真正的 Scriptorium WorkerControlAdapter 执行契约测试...");
console.log("=========================================");

// 1. Build TS production code using esbuild with alias redirection plugin
const mockMainPath = path.resolve("./scratch/mock-main.js");
const outPath = path.resolve("./scratch/WorkerControlAdapter.js");

const mockMainPlugin = {
  name: 'mock-main',
  setup(build) {
    build.onResolve({ filter: /\.\.\/\.\.\/main/ }, () => {
      return { path: mockMainPath };
    });
  },
};

try {
  await build({
    entryPoints: ["src/aetheric/operations/WorkerControlAdapter.ts"],
    outfile: outPath,
    bundle: true,
    format: "esm",
    plugins: [mockMainPlugin],
    external: ["fs", "path", "child_process"],
  });
  console.log("✅ 生产代码编译打包成功。");
} catch (e) {
  console.error("❌ 编译失败:", e);
  process.exit(1);
}

// 2. Load the actual compiled production class
const { WorkerControlAdapter } = await import("./WorkerControlAdapter.js");

// Mock environment setup
const mockSystemPath = path.resolve("./scratch-mock-system");
if (!fs.existsSync(mockSystemPath)) {
  fs.mkdirSync(mockSystemPath, { recursive: true });
}

// 3. Mock Plugin Settings & LogBus
const mockPlugin = {
  settings: {
    hamasxiangWorkerToken: "",
    hamasxiangSystemPath: mockSystemPath,
    personalBlogPath: "/blog",
  },
  logBus: {
    logs: [],
    append(level, source, message) {
      this.logs.push({ level, source, message });
      // Token leak check
      if (message.includes("secret-token-env") || message.includes("secret-token-settings")) {
        throw new Error(`❌ 安全泄露：检测到 Token 出现在日志流中！内容: "${message}"`);
      }
    }
  }
};

// 4. Mock Global fetch
let currentMockFetch = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (currentMockFetch) {
    return currentMockFetch(url, options);
  }
  return originalFetch(url, options);
};

// ----------------------------------------------------
// TEST SUITE
// ----------------------------------------------------

async function runTests() {
  // Instantiate actual production class
  const adapter = new WorkerControlAdapter(mockPlugin);
  
  // Test 1: Token Retrieval from Settings
  console.log("▶️ 测试 1: 从插件设置中优先读取 Token");
  mockPlugin.settings.hamasxiangWorkerToken = "secret-token-settings";
  const t1 = await adapter.getWorkerToken();
  if (t1 !== "secret-token-settings") throw new Error("测试 1 失败");
  console.log("   ✅ 成功");

  // Test 2: Token Fallback to .env File
  console.log("▶️ 测试 2: 设置为空时 fallback 到 .env 文件中读取");
  mockPlugin.settings.hamasxiangWorkerToken = "";
  const mockEnvFile = path.join(mockSystemPath, ".env");
  fs.writeFileSync(mockEnvFile, "AUTOCLI_WORKER_TOKEN=secret-token-env\nAUTOCLI_WORKER_URL=https://mail.oblogsidian.fun/inbox");
  const t2 = await adapter.getWorkerToken();
  if (t2 !== "secret-token-env") throw new Error("测试 2 失败");
  console.log("   ✅ 成功");

  // Test 3: Debouncing / Rate Limiting (we override debounceMs if needed, but since it's 1200ms in production, we wait or adjust)
  console.log("▶️ 测试 3: 连续点击快速防抖拦截");
  currentMockFetch = async () => {
    return {
      ok: true,
      json: async () => ({ disabled: false }),
    };
  };
  await adapter.fetchStatus(); // First request registers time
  try {
    await adapter.fetchStatus(); // Second immediate request should throw
    throw new Error("防抖拦截失效！");
  } catch (err) {
    if (err.message.includes("法力过于频繁")) {
      console.log("   ✅ 成功拦截频繁点击");
    } else {
      throw err;
    }
  }

  // Test 4: Network offline / timeout handling
  console.log("▶️ 测试 4: 连接超时与网络离线时安全抛错");
  currentMockFetch = async () => {
    throw { name: "AbortError" };
  };
  
  // Wait for rate limit debounce to expire (using a hack of resetting private lastRequestTime)
  adapter.lastRequestTime = 0;

  try {
    await adapter.fetchStatus();
    throw new Error("网络错误未被抛出！");
  } catch (err) {
    if (err.message.includes("云端收件箱连接超时")) {
      console.log("   ✅ 成功检测并处理网络超时");
    } else {
      throw err;
    }
  }

  // Test 5: UI Rollback Verification (simulated rollback using actual status toggle fetch failure)
  console.log("▶️ 测试 5: 状态修改发生网络错误时，验证抛错 (可供 UI 捕获并回滚)");
  currentMockFetch = async () => {
    return {
      ok: false,
      status: 502,
    };
  };
  
  adapter.lastRequestTime = 0;

  try {
    await adapter.toggleStatus(true);
    throw new Error("502 错误未抛出！");
  } catch (err) {
    if (err.message.includes("更新去重状态失败") || err.message.includes("Worker HTTP 错误")) {
      console.log("   ✅ 成功验证接口失败时的安全报错行为");
    } else {
      throw err;
    }
  }

  // Test 6: Logging Security Auditing
  console.log("▶️ 测试 6: 安全审计——日志流中绝对不得泄漏 Token 内容");
  const leakedInLogs = mockPlugin.logBus.logs.some(log => 
    log.message.includes("secret-token-env") || log.message.includes("secret-token-settings")
  );
  if (leakedInLogs) {
    throw new Error("❌ 安全审计不合格：Token 泄露到日志流中！");
  }
  console.log("   ✅ 安全审计完美通过");

  // Clean up
  try {
    fs.unlinkSync(mockEnvFile);
    fs.rmdirSync(mockSystemPath);
    fs.unlinkSync(outPath);
  } catch(e) {}

  // Restore fetch
  globalThis.fetch = originalFetch;

  console.log("\n=========================================");
  console.log("🎉 所有 6 项对生产代码的契约测试圆满通过！");
  console.log("=========================================");
}

runTests().catch(err => {
  console.error("❌ 测试运行出错:", err);
  // Restore fetch
  globalThis.fetch = originalFetch;
  process.exit(1);
});
