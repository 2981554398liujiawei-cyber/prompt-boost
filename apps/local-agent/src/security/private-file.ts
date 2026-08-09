import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";

/**
 * 对敏感文件应用仅当前用户可访问的权限。
 * POSIX 使用 0600；Windows 必须显式移除继承 ACL（mode=0600 在 Windows 无效）。
 */
export function hardenPrivateFile(filePath: string): void {
  chmodSync(filePath, 0o600);
  if (process.platform !== "win32") return;
  const username = userInfo().username;
  const domain = process.env.USERDOMAIN;
  const identity = domain ? `${domain}\\${username}` : username;
  execFileSync(
    "icacls.exe",
    [filePath, "/inheritance:r", "/grant:r", `${identity}:(F)`],
    { stdio: "ignore", windowsHide: true },
  );
}

/** 保护运行时数据目录，并让新建的 SQLite WAL/SHM 文件继承仅当前用户 ACL。 */
export function hardenPrivateDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  chmodSync(directoryPath, 0o700);
  if (process.platform !== "win32") return;
  const username = userInfo().username;
  const domain = process.env.USERDOMAIN;
  const identity = domain ? `${domain}\\${username}` : username;
  execFileSync(
    "icacls.exe",
    [directoryPath, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)(F)`],
    { stdio: "ignore", windowsHide: true },
  );
}

/** 同目录临时文件 + rename，避免进程中断留下半截密钥文件。 */
export function writePrivateFileAtomic(filePath: string, contents: string): void {
  hardenPrivateDirectory(dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, contents, { mode: 0o600, flag: "wx" });
    hardenPrivateFile(tempPath);
    renameSync(tempPath, filePath);
    hardenPrivateFile(filePath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件可能已被 rename；此处只做尽力清理。
    }
    throw err;
  }
}

/** 读取前顺便收紧旧版本留下的宽松权限。 */
export function readPrivateText(filePath: string): string {
  hardenPrivateFile(filePath);
  return readFileSync(filePath, "utf8");
}
