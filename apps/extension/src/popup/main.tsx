import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EXTENSION_VERSION } from "@prompt-boost/shared";
import { getExtensionSettings } from "../background/settings.js";

interface PingResult {
  ok: boolean;
  message: string;
}

function PingBadge({ ok }: { ok: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: ok ? "#10a37f" : "#d94343",
        marginRight: 6,
      }}
    />
  );
}

function Popup() {
  const [model, setModel] = useState("未配置");
  const [ping, setPing] = useState<PingResult | null>(null);

  useEffect(() => {
    void getExtensionSettings().then((s) => {
      const active = s.providers.find((p) => p.id === s.activeProviderId);
      setModel(active ? active.model : "未配置");
    });
    // 探测本地服务。
    void chrome.runtime.sendMessage({ type: "local-agent/ping" }).then((res) => {
      setPing({ ok: Boolean(res?.ok), message: res?.ok ? "已连接" : "未连接" });
    });
  }, []);

  return (
    <div style={{ width: 260, padding: 14, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 15, margin: "0 0 10px" }}>
        ✨ Prompt Boost
        <span style={{ fontSize: 11, color: "#888", marginLeft: 8 }}>v{EXTENSION_VERSION}</span>
      </h1>
      <Row label="启用">
        <span>已启用</span>
      </Row>
      <Row label="本地服务">
        <span style={{ display: "flex", alignItems: "center" }}>
          <PingBadge ok={Boolean(ping?.ok)} />
          {ping?.message ?? "检查中…"}
        </span>
      </Row>
      <Row label="当前模型">{model}</Row>
      <button
        onClick={() => void chrome.runtime.openOptionsPage()}
        style={{
          marginTop: 12,
          width: "100%",
          padding: "8px 0",
          border: "1px solid #ddd",
          borderRadius: 6,
          background: "#fff",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        ⚙ 打开设置
      </button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", margin: "6px 0", fontSize: 13 }}>
      <span style={{ color: "#666" }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
