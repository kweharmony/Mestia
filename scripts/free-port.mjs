/**
 * Освобождает порт перед стартом dev-сервера (без сторонних пакетов).
 * Находит процесс, слушающий порт, и завершает его.
 *
 *   node scripts/free-port.mjs [порт]   (по умолчанию 1420)
 */
import { execSync } from "node:child_process";
import os from "node:os";

const port = process.argv[2] || "1420";
const isWin = os.platform() === "win32";

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return "";
  }
}

function pidsOnPort() {
  const pids = new Set();
  if (isWin) {
    // Строки netstat: "TCP  0.0.0.0:1420  0.0.0.0:0  LISTENING  <pid>"
    // (флаг -p tcp на Windows ломает вывод, поэтому берём всё и фильтруем сами).
    const out = sh(`netstat -ano`);
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[0] === "TCP" && parts[1].endsWith(`:${port}`)) {
        const pid = parts[parts.length - 1];
        if (/^\d+$/.test(pid) && pid !== "0") pids.add(pid);
      }
    }
  } else {
    // lsof доступен на macOS/Linux
    const out = sh(`lsof -ti tcp:${port} -sTCP:LISTEN`);
    for (const pid of out.split(/\s+/)) {
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
  }
  return [...pids];
}

const pids = pidsOnPort();
if (pids.length === 0) {
  console.log(`Порт ${port} свободен.`);
} else {
  for (const pid of pids) {
    if (isWin) sh(`taskkill /PID ${pid} /F /T`);
    else sh(`kill -9 ${pid}`);
    console.log(`Порт ${port}: завершён процесс PID ${pid}.`);
  }
}
