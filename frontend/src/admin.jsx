import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  App as AntApp,
  Button,
  Card,
  ConfigProvider,
  Modal,
  Space,
  Table,
  Typography,
  theme,
} from "antd";
import { CloudDownloadOutlined, CopyOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";

/** 弹窗标题居中 */
const DIALOG_TITLE_CENTER = {
  styles: {
    header: { textAlign: "center" },
  },
};

function AdminLanRow({ url, onCopy }) {
  if (!url) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <Typography.Text code style={{ flex: 1, minWidth: 0 }}>
        {url}
      </Typography.Text>
      <Button size="small" type="primary" icon={<CopyOutlined />} onClick={() => onCopy(url)}>
        复制
      </Button>
    </div>
  );
}

function AdminApp() {
  const { message, modal } = AntApp.useApp();
  const { token } = theme.useToken();
  const [devices, setDevices] = useState([]);
  const [busy, setBusy] = useState(false);
  const [serverInfo, setServerInfo] = useState(null);
  const [appVersion, setAppVersion] = useState("");
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const checkingUpdateRef = useRef(false);

  const fetchServerInfo = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/server-info");
      if (!r.ok) return;
      const j = await r.json();
      setServerInfo(j);
    } catch {
      setServerInfo(null);
    }
  }, []);

  const fetchOnline = useCallback(async () => {
    try {
      const r = await fetch("/api/online");
      if (r.status === 403) {
        setDevices([]);
        return;
      }
      const j = await r.json();
      setDevices(Array.isArray(j.devices) ? j.devices : []);
    } catch {
      setDevices([]);
    }
  }, []);

  const checkForUpdate = useCallback(async () => {
    if (checkingUpdateRef.current) return;
    checkingUpdateRef.current = true;
    try {
      const res = await fetch("/api/update/check");
      if (!res.ok) return;
      const result = await res.json();
      setUpdateInfo(result);
      if (result.success && result.has_update) {
        setUpdateModalOpen(true);
      }
    } catch {
      /* 静默失败 */
    } finally {
      checkingUpdateRef.current = false;
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      checkForUpdate();
    }, 3000);
    return () => clearTimeout(t);
  }, [checkForUpdate]);

  useEffect(() => {
    fetchServerInfo();
    fetchOnline();
    const t = setInterval(fetchOnline, 3000);
    return () => clearInterval(t);
  }, [fetchOnline, fetchServerInfo]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/app/version");
        if (!r.ok) return;
        const j = await r.json();
        const v = String(j.version || "").trim();
        if (cancelled || !v) return;
        setAppVersion(v);
        document.title = `控制台 · v${v}`;
      } catch {
        /* 忽略 */
      }
    })();
    return () => {
      cancelled = true;
      document.title = "控制台";
    };
  }, []);

  const copyText = useCallback(
    async (text, okMsg = "已复制到剪贴板") => {
      try {
        await navigator.clipboard.writeText(text);
        message.success(okMsg);
      } catch {
        message.error("复制失败，请手动选择复制");
      }
    },
    [message]
  );

  const postLocal = async (url) => {
    const r = await fetch(url, { method: "POST" });
    let detail = "";
    try {
      const j = await r.json();
      detail = j.detail || j.message || "";
    } catch {
      /* ignore */
    }
    if (r.status === 403) {
      message.error(detail || "仅本机可执行：请用本机浏览器打开 http://127.0.0.1:端口/admin");
      return false;
    }
    if (!r.ok) {
      message.error(detail || `请求失败 (${r.status})`);
      return false;
    }
    return true;
  };

  const onClearChats = () => {
    modal.confirm({
      title: "清除所有聊天记录？",
      content:
        "所有用户端会话列表中的消息将被清空，服务端持久化记录一并删除；uploads 目录下已上传的全部文件也会同时删除，不可恢复。",
      okText: "确定清除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setBusy(true);
        try {
          if (await postLocal("/api/admin/clear-chats")) message.success("已清除所有聊天记录及全部上传文件");
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const onClearFiles = () => {
    modal.confirm({
      title: "清除所有已上传文件？",
      content: "uploads 目录下文件将全部删除，不可恢复。",
      okText: "确定清除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setBusy(true);
        try {
          if (await postLocal("/api/clear")) message.success("已清除所有文件");
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const columns = [
    { title: "昵称", dataIndex: "nick", ellipsis: true },
    { title: "client_id", dataIndex: "client_id", ellipsis: true, width: 200 },
    { title: "IP", dataIndex: "ip", width: 130 },
    { title: "MAC", dataIndex: "mac", width: 150, ellipsis: true },
    {
      title: "连接时间",
      dataIndex: "connected_at",
      width: 200,
      render: (t) => {
        try {
          return new Date(t).toLocaleString();
        } catch {
          return t || "—";
        }
      },
    },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: "0 auto", background: token.colorBgLayout, minHeight: "100vh" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: "10px 12px",
          marginTop: 0,
          marginBottom: 12,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          控制台
        </Typography.Title>
        {appVersion ? (
          <Typography.Text type="secondary" style={{ fontSize: 15 }}>
            v{appVersion}
          </Typography.Text>
        ) : null}
      </div>
      <Typography.Paragraph type="secondary">
        仅当通过本机回环地址（127.0.0.1）访问时可用。可查看当前在线 WebSocket
        连接；「清除所有聊天记录」会同时删除 uploads 下全部已上传文件；亦可仅清除全部上传文件。
        桌面端程序有新版本时，将在本页自动弹出提示；请点击「前往下载」在系统默认浏览器中打开发布页或安装包链接。
      </Typography.Paragraph>

      <Card title="局域网用户端地址" style={{ marginBottom: 16 }}>
        {serverInfo ? (
          serverInfo.lan_user_urls?.length ? (
            serverInfo.lan_user_urls.map((u) => <AdminLanRow key={u} url={u} onCopy={copyText} />)
          ) : (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              未能自动检测内网 IPv4。当前端口：<Typography.Text code>{serverInfo.port}</Typography.Text>
              ，请在系统网络设置中查看本机地址后访问：http://内网IP:{serverInfo.port}/
            </Typography.Paragraph>
          )
        ) : (
          <Typography.Text type="secondary">正在加载…</Typography.Text>
        )}
      </Card>

      <Card title="在线用户（WebSocket）" style={{ marginBottom: 16 }}>
        <Space style={{ marginBottom: 12 }}>
          <Button onClick={fetchOnline} loading={busy}>
            刷新列表
          </Button>
          <Button onClick={fetchServerInfo}>刷新地址</Button>
        </Space>
        <Table
          size="small"
          rowKey="client_id"
          dataSource={devices}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "当前无在线连接" }}
        />
      </Card>

      <Card title="危险操作">
        <Space wrap>
          <Button danger onClick={onClearChats} disabled={busy}>
            清除所有聊天记录
          </Button>
          <Button danger type="primary" onClick={onClearFiles} disabled={busy}>
            清除所有已上传文件
          </Button>
        </Space>
      </Card>

      <Modal
        title="发现新版本"
        open={updateModalOpen}
        onCancel={() => setUpdateModalOpen(false)}
        maskClosable={false}
        destroyOnClose
        footer={
          <Space>
            <Button onClick={() => setUpdateModalOpen(false)}>稍后提醒</Button>
            <Button
              type="primary"
              icon={<CloudDownloadOutlined />}
              onClick={async () => {
                const u = updateInfo?.download_url || updateInfo?.release_url;
                if (!u) {
                  message.warning("没有可用的下载链接");
                  return;
                }
                try {
                  const r = await fetch("/api/admin/open-browser", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ url: u }),
                  });
                  const j = await r.json().catch(() => ({}));
                  if (!r.ok) {
                    const d = j.detail;
                    message.error(typeof d === "string" ? d : `打开失败 (${r.status})`);
                    return;
                  }
                  setUpdateModalOpen(false);
                } catch {
                  message.error("请求失败");
                }
              }}
            >
              前往下载
            </Button>
          </Space>
        }
        width={Math.min(440, typeof window !== "undefined" ? window.innerWidth - 48 : 400)}
        {...DIALOG_TITLE_CENTER}
      >
        {updateInfo?.success ? (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              检测到有新版本发布。请点击「前往下载」，将在系统默认浏览器中打开下载地址或 Release 页面，下载安装包后覆盖安装桌面端。
            </Typography.Paragraph>
            {updateInfo.release_notes ? (
              <div
                style={{
                  maxHeight: 220,
                  overflowY: "auto",
                  padding: 10,
                  borderRadius: 8,
                  background: token.colorFillTertiary,
                  marginBottom: 8,
                }}
              >
                <Typography.Text style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{updateInfo.release_notes}</Typography.Text>
              </div>
            ) : null}
          </>
        ) : (
          <Typography.Text type="secondary">无法连接 GitHub 获取更新信息。</Typography.Text>
        )}
      </Modal>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("admin-root")).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm }}>
      <AntApp>
        <AdminApp />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>
);
