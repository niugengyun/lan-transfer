import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  ConfigProvider,
  InputNumber,
  Space,
  Table,
  Typography,
  theme,
} from "antd";
import { CopyOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";

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
  const [portDraft, setPortDraft] = useState(null);

  const fetchServerInfo = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/server-info");
      if (!r.ok) return;
      const j = await r.json();
      setServerInfo(j);
      setPortDraft((prev) => {
        if (prev != null) return prev;
        if (typeof j.persisted_port === "number") return j.persisted_port;
        if (typeof j.default_port === "number") return j.default_port;
        if (typeof j.port === "number") return j.port;
        return 8888;
      });
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

  useEffect(() => {
    fetchServerInfo();
    fetchOnline();
    const t = setInterval(fetchOnline, 3000);
    return () => clearInterval(t);
  }, [fetchOnline, fetchServerInfo]);

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

  const postJsonLocal = async (url, body) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    let j = null;
    try {
      j = await r.json();
    } catch {
      j = {};
    }
    const detail = (j && (j.detail || j.message)) || "";
    if (r.status === 403) {
      message.error(detail || "仅本机可执行：请用本机浏览器打开 http://127.0.0.1:端口/admin");
      return null;
    }
    if (!r.ok) {
      message.error(detail || `请求失败 (${r.status})`);
      return null;
    }
    return j;
  };

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
      content: "所有用户端会话列表中的消息将被清空，服务端持久化记录一并删除。",
      okText: "确定清除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setBusy(true);
        try {
          if (await postLocal("/api/admin/clear-chats")) message.success("已清除所有聊天记录");
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const onSavePort = async () => {
    if (serverInfo?.port_from_env) {
      message.warning("当前端口由环境变量 PORT 指定，无法通过此处覆盖。");
      return;
    }
    const p = portDraft;
    if (p == null || Number.isNaN(Number(p))) {
      message.error("请输入有效端口");
      return;
    }
    setBusy(true);
    try {
      const j = await postJsonLocal("/api/admin/server-settings", { port: Number(p) });
      if (j) {
        message.success("已保存端口，请重启服务后生效。");
        if (typeof j.port === "number") setPortDraft(j.port);
        await fetchServerInfo();
      }
    } finally {
      setBusy(false);
    }
  };

  const onRestart = () => {
    modal.confirm({
      title: "重启服务？",
      content: "将结束当前进程并自动拉起新进程；管理页会暂时断开，请稍后重新打开本页。",
      okText: "重启",
      cancelText: "取消",
      onOk: async () => {
        setBusy(true);
        try {
          const j = await postJsonLocal("/api/admin/restart", {});
          if (j?.message) message.info(j.message);
          else if (j) message.info("正在重启…");
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const onStop = () => {
    modal.confirm({
      title: "停止 HTTP 服务？",
      content:
        "将关闭局域网访问（其他设备无法再打开本机页面）。使用桌面窗口时，本程序**不会退出**，窗口内会显示「已停止」说明；若你仅用命令行运行（无窗口），则会退出进程。",
      okText: "停止",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setBusy(true);
        try {
          const j = await postJsonLocal("/api/admin/stop", {});
          if (j?.message) message.info(j.message);
          else if (j) message.info("正在停止服务…");
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
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        本机管理控制台
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        仅当通过本机回环地址（127.0.0.1）访问时可用。可查看当前在线 WebSocket
        连接、清除全部聊天记录、清除 uploads 下全部文件。
      </Typography.Paragraph>

      <Card title="服务与端口" style={{ marginBottom: 16 }}>
        {serverInfo?.port_from_env ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="当前监听端口由环境变量 PORT 决定"
            description="修改下方保存的配置不会在去掉 PORT 之前生效；去掉环境变量后重启即可使用已保存端口。"
          />
        ) : null}
        <Space wrap align="center" style={{ marginBottom: 12 }}>
          <Typography.Text>HTTP 端口（默认 {serverInfo?.default_port ?? 8888}，保存后需重启生效）</Typography.Text>
          <InputNumber
            min={1}
            max={65535}
            disabled={busy || !!serverInfo?.port_from_env}
            value={portDraft ?? serverInfo?.default_port ?? 8888}
            onChange={(v) => setPortDraft(v)}
          />
          <Button onClick={onSavePort} disabled={busy || !!serverInfo?.port_from_env}>
            保存端口
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          当前生效端口：<Typography.Text code>{serverInfo?.port ?? "—"}</Typography.Text>
          {serverInfo?.persisted_port != null ? (
            <>
              ，已保存配置：<Typography.Text code>{serverInfo.persisted_port}</Typography.Text>
            </>
          ) : null}
        </Typography.Paragraph>
        <Space wrap>
          <Button onClick={onRestart} disabled={busy}>
            重启服务
          </Button>
          <Button danger type="primary" onClick={onStop} disabled={busy}>
            停止服务
          </Button>
        </Space>
      </Card>

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
