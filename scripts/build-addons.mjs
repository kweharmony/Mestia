import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tauri = join(root, "src-tauri");
const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const target = "x86_64-pc-windows-msvc";
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const cargoTarget = join(tauri, "target");
const output = join(cargoTarget, "addon-packages");
const debug = process.argv.includes("--debug");

function run(file, args, cwd, env = process.env) {
  const result = spawnSync(file, args, { cwd, env, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`Ошибка команды ${file}: ${result.status}`);
  }
}

if (process.platform !== "win32") throw new Error("Пакеты Mestia собираются на Windows");
if (JSON.parse(readFileSync(join(tauri, "tauri.conf.json"), "utf8")).version !== version) {
  throw new Error("Версии Mestia в package.json и tauri.conf.json должны совпадать");
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  throw new Error("Для подписи нужен ключ Tauri в переменной окружения");
}

const flags = debug ? [] : ["--release"];
const env = debug ? { ...process.env, CARGO_PROFILE_DEV_DEBUG: "0" } : process.env;
run("cargo", ["build", "--locked", "--target", target, "--target-dir", cargoTarget,
  "-p", "mestia-addon-workers", "--bins", ...flags], tauri, env);
mkdirSync(output, { recursive: true });

for (const id of ["tags", "nearby"]) {
  const executable = join(cargoTarget, target, debug ? "debug" : "release", `mestia-addon-${id}.exe`);
  const bytes = readFileSync(executable);
  const stage = mkdtempSync(join(output, ".stage-"));
  try {
    const manifest = join(stage, "manifest.json");
    writeFileSync(manifest, JSON.stringify({
      id, version, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    copyFileSync(executable, join(stage, "worker.exe"));
    run(process.execPath, [cli, "signer", "sign", manifest], root);
    const archive = join(output, `Mestia_Addon_${id}_${version}_windows_x64.zip`);
    const temporaryArchive = join(stage, "package.zip");
    run("tar.exe", ["--format=zip", "-cf", temporaryArchive, "-C", stage,
      "manifest.json", "manifest.json.sig", "worker.exe"], root);
    renameSync(temporaryArchive, archive);
    console.log(archive);
  } finally {
    const actual = realpathSync(stage);
    if (dirname(actual) !== realpathSync(output) || !basename(actual).startsWith(".stage-")) {
      throw new Error("Неожиданный путь временной папки пакета");
    }
    rmSync(actual, { recursive: true, force: true });
  }
}
