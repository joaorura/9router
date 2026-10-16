#!/usr/bin/env node

/**
 * 9Router Gemini Tool Enum Sanitizer & Update Watcher
 *
 * Automatically patches 9Router's compiled server chunks to sanitize tool enum schemas:
 * - Removes empty strings ("") and null/undefined from enum arrays
 * - Deletes empty enum arrays to prevent Gemini 400 'cannot be empty' errors
 * - Prevents empty string const values from becoming empty enums
 * - Monitors for npm updates and reapplies the patch automatically
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const { execSync, spawn } = require("child_process");

const COLOR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m"
};

function log(msg, color = "") {
  const ts = new Date().toLocaleTimeString();
  console.log(`${COLOR.gray}[${ts}]${COLOR.reset} ${color}${msg}${COLOR.reset}`);
}

function success(msg) { log(`✅ ${msg}`, COLOR.green); }
function warn(msg) { log(`⚠️  ${msg}`, COLOR.yellow); }
function error(msg) { log(`❌ ${msg}`, COLOR.red); }
function info(msg) { log(`ℹ️  ${msg}`, COLOR.cyan); }

// Parse command line arguments
const args = process.argv.slice(2);
const isWatch = args.includes("--watch") || args.includes("-w");
const isServiceInstall = args.includes("--install-service");
const isCheckOnly = args.includes("--check");
const customDirIndex = args.indexOf("--dir");
const customDir = customDirIndex !== -1 ? args[customDirIndex + 1] : null;

// Candidate locations where 9router might be installed
function find9RouterInstallations() {
  const candidates = [];

  if (customDir) {
    candidates.push(path.resolve(customDir));
  }

  // 1. Global npm root
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (globalRoot) candidates.push(path.join(globalRoot, "9router"));
  } catch {}

  // 2. Common global paths
  candidates.push("/usr/local/lib/node_modules/9router");
  candidates.push("/usr/lib/node_modules/9router");
  candidates.push(path.join(os.homedir(), ".local/lib/node_modules/9router"));
  candidates.push(path.join(os.homedir(), ".npm-global/lib/node_modules/9router"));

  // 3. Local development repo
  candidates.push(path.join(os.homedir(), "Desenvolvimento/9router"));
  candidates.push(path.join(os.homedir(), "Desenvolvimento/9router/cli"));

  const existing = [];
  const seen = new Set();
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (fs.existsSync(dir)) {
      existing.push(dir);
    }
  }

  return existing;
}

// Find chunks that contain the Gemini translator
function findTargetChunks(installDir) {
  const chunksDirs = [
    path.join(installDir, "app/.next-cli-build/server/chunks"),
    path.join(installDir, ".next-cli-build/server/chunks"),
    path.join(installDir, ".next/server/chunks"),
    path.join(installDir, "app/.next/server/chunks"),
    path.join(installDir, "cli/app/.next-cli-build/server/chunks")
  ];

  const targetChunks = [];

  for (const chunksDir of chunksDirs) {
    if (!fs.existsSync(chunksDir)) continue;

    try {
      const files = fs.readdirSync(chunksDir);
      for (const file of files) {
        if (!file.endsWith(".js")) continue;
        const fullPath = path.join(chunksDir, file);
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          // Marker for Gemini translator chunk: contains HARM_CATEGORY_HATE_SPEECH
          if (content.includes("HARM_CATEGORY_HATE_SPEECH") && content.includes(".enum")) {
            targetChunks.push(fullPath);
          }
        } catch {}
      }
    } catch {}
  }

  return targetChunks;
}

// Check if a chunk already contains the sanitization fix
function isChunkPatched(content) {
  return (
    content.includes("x.enum.filter") ||
    content.includes("validEnums") ||
    content.includes("e.length>0;0===v.length?delete x.enum")
  );
}

// Check if upstream has already incorporated the fix natively
function isUpstreamFixed(content) {
  return (
    content.includes(".filter(a=>null!=a).map(a=>String(a)).filter(a=>a.length>0)") ||
    content.includes("validEnums")
  );
}

// Patch a chunk string
function applyPatchToContent(content) {
  let patched = content;

  // 1. Const to Enum patch:
  // Original: void 0===b.const||b.enum||(b.enum=[b.const],delete b.const)
  const constPattern = /void 0===b\.const\|\|b\.enum\|\|\(b\.enum=\[b\.const\],delete b\.const\)/g;
  const constReplacement = 'void 0===b.const||b.enum||((""!==b.const&&null!=b.const&&(b.enum=[b.const])),delete b.const)';

  if (constPattern.test(patched)) {
    patched = patched.replace(constPattern, constReplacement);
  }

  // 2. Enum to String + Empty Enum Sanitization patch:
  // Original: b.enum&&Array.isArray(b.enum)&&(b.enum=b.enum.map(a=>String(a)),b.type||(b.type="string"))
  const enumPattern = /b\.enum&&Array\.isArray\(b\.enum\)&&\(b\.enum=b\.enum\.map\(([a-zA-Z])=>String\(\1\)\),b\.type\|\|\(b\.type="string"\)\)/g;
  const enumReplacement = 'void 0!==b.enum&&(Array.isArray(b.enum)?(function(x){let v=x.enum.filter(e=>null!=e).map(e=>String(e)).filter(e=>e.length>0);0===v.length?delete x.enum:x.enum=v})(b):delete b.enum,b.type||(b.type="string"))';

  if (enumPattern.test(patched)) {
    patched = patched.replace(enumPattern, enumReplacement);
  }

  return patched;
}

// Patch a single chunk file
function patchChunkFile(filePath) {
  try {
    const original = fs.readFileSync(filePath, "utf8");

    if (isChunkPatched(original)) {
      info(`Already patched: ${filePath}`);
      return { success: true, changed: false };
    }

    if (isUpstreamFixed(original)) {
      success(`Upstream official fix detected in ${filePath}! No patch needed.`);
      return { success: true, changed: false, upstream: true };
    }

    info(`Applying enum sanitization patch to ${filePath}...`);
    const patched = applyPatchToContent(original);

    if (patched === original) {
      warn(`Pattern match did not alter content in ${filePath}. Check if minified structure changed.`);
      return { success: false, changed: false };
    }

    // Syntax validation
    try {
      new vm.Script(patched);
    } catch (syntaxErr) {
      error(`Patched code failed JS syntax validation: ${syntaxErr.message}`);
      return { success: false, error: syntaxErr };
    }

    // Create backup
    const bakPath = `${filePath}.bak`;
    try {
      fs.writeFileSync(bakPath, original, "utf8");
    } catch (bakErr) {
      warn(`Could not create backup ${bakPath}: ${bakErr.message}`);
    }

    // Write patched file
    fs.writeFileSync(filePath, patched, "utf8");
    success(`Successfully patched: ${filePath}`);
    return { success: true, changed: true };
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      error(`Permission denied writing to ${filePath}. Run with sudo or fix permissions.`);
    } else {
      error(`Error patching ${filePath}: ${err.message}`);
    }
    return { success: false, error: err };
  }
}

// Run one patch pass over all known installations
function runPatchPass() {
  const installations = find9RouterInstallations();
  if (installations.length === 0) {
    warn("No 9router installations found.");
    return { patchedCount: 0, totalChunks: 0 };
  }

  let totalChunks = 0;
  let patchedCount = 0;
  let anyChanged = false;

  for (const dir of installations) {
    const chunks = findTargetChunks(dir);
    totalChunks += chunks.length;

    for (const chunk of chunks) {
      const res = patchChunkFile(chunk);
      if (res.success) patchedCount++;
      if (res.changed) anyChanged = true;
    }
  }

  return { patchedCount, totalChunks, anyChanged };
}

// Find running 9router PID
function getRunning9RouterPids() {
  try {
    const out = execSync("pgrep -f 'node.*9router' || true", { encoding: "utf8" }).trim();
    if (!out) return [];
    const myPid = process.pid.toString();
    return out.split("\n").map(p => p.trim()).filter(p => p && p !== myPid);
  } catch {
    return [];
  }
}

// Start watching installations for updates
function startWatcher() {
  const installations = find9RouterInstallations();
  info(`Starting update monitor on ${installations.length} installation paths...`);
  for (const dir of installations) {
    info(`  - ${dir}`);
  }

  // Initial patch pass
  runPatchPass();

  let debounceTimer = null;
  const onDirChanged = (dir) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      info(`Change detected in ${dir}. Checking and reapplying patches if needed...`);
      const { anyChanged } = runPatchPass();
      if (anyChanged) {
        info("Re-patch completed. If 9router is running, restart it to load changes.");
      }
    }, 1500);
  };

  // Watch directories
  for (const dir of installations) {
    try {
      fs.watch(dir, { recursive: true }, () => onDirChanged(dir));
      info(`Watching directory: ${dir}`);
    } catch (err) {
      warn(`Could not set recursive inotify on ${dir}: ${err.message}. Using polling fallback.`);
    }
  }

  // Polling fallback every 30 seconds
  setInterval(() => {
    const { anyChanged } = runPatchPass();
    if (anyChanged) {
      info("Periodic poll detected unpatched files and applied fix.");
    }
  }, 30000);

  log("Monitoring active. Press Ctrl+C to exit.", COLOR.bold);
}

// Install user systemd service
function installSystemdService() {
  const serviceDir = path.join(os.homedir(), ".config/systemd/user");
  const servicePath = path.join(serviceDir, "9router-patcher.service");
  const scriptPath = path.resolve(__filename);

  fs.mkdirSync(serviceDir, { recursive: true });

  const serviceUnit = `[Unit]
Description=9Router Gemini Tool Enum Patch Monitor
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${scriptPath} --watch
Restart=always
RestartSec=10
Environment=PATH=${process.env.PATH}

[Install]
WantedBy=default.target
`;

  fs.writeFileSync(servicePath, serviceUnit, "utf8");
  success(`Systemd service created: ${servicePath}`);

  try {
    execSync("systemctl --user daemon-reload");
    execSync("systemctl --user enable --now 9router-patcher.service");
    success("Service enabled and started via systemctl --user!");
    info("Status check: systemctl --user status 9router-patcher.service");
  } catch (err) {
    warn(`Could not enable service automatically: ${err.message}`);
    info("Run manually: systemctl --user daemon-reload && systemctl --user enable --now 9router-patcher.service");
  }
}

// Main execution
function main() {
  if (isServiceInstall) {
    installSystemdService();
    return;
  }

  if (isWatch) {
    startWatcher();
    return;
  }

  log("9Router Gemini Tool Enum Sanitizer", COLOR.bold + COLOR.cyan);
  const { patchedCount, totalChunks, anyChanged } = runPatchPass();

  if (totalChunks === 0) {
    warn("No Gemini translator chunks found. Ensure 9router is installed or specify with --dir <path>");
    process.exit(1);
  }

  info(`Processed ${totalChunks} candidate chunk(s).`);
  if (anyChanged) {
    success("Patch applied successfully!");
    const pids = getRunning9RouterPids();
    if (pids.length > 0) {
      info(`9router processes detected (PIDs: ${pids.join(", ")}). Restart 9router to load the patched chunk.`);
    }
  } else {
    success("All chunks are up to date and patched.");
  }
}

main();
