/**
 * keytar 是可选依赖（系统凭证库封装）。
 * 未安装时由 vault.ts 动态 import 失败并回退加密文件存储。
 * 这里声明最小类型，保证编译通过。安装 keytar 时类型以包内声明为准。
 */
declare module "keytar" {
  export function getPassword(
    service: string,
    account: string,
  ): Promise<string | null>;
  export function setPassword(
    service: string,
    account: string,
    password: string,
  ): Promise<void>;
  export function deletePassword(
    service: string,
    account: string,
  ): Promise<boolean>;
  /** 列出某服务下所有凭证（用于 vault 一致性审计）。 */
  export function findCredentials(
    service: string,
  ): Promise<Array<{ account: string; password: string }>>;
}
