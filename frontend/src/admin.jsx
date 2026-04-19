import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  App as AntApp,
  Button,
  Card,
  ConfigProvider,
  DatePicker,
  InputNumber,
  Modal,
  Space,
  Table,
  Typography,
  theme,
} from "antd";
import { CloudDownloadOutlined, CopyOutlined, FileOutlined, PlayCircleOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";

const { RangePicker } = DatePicker;

/** 弹窗标题居中 */
const DIALOG_TITLE_CENTER = {
  styles: {
    header: { textAlign: "center" },
  },
};

function fmtSizeAdmin(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${(x / (1024 * 1024)).toFixed(1)} MB`;
}

function fileInlineUrl(stored) {
  return `/api/files/${encodeURIComponent(stored)}/inline`;
}

function fileDownloadUrl(stored) {
  return `/api/files/${encodeURIComponent(stored)}/download`;
}

function mediaKindFromFileName(name) {
  if (!name || typeof name !== "string") return null;
  if (/\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name)) return "image";
  if (/\.(mp4|webm|ogg|mov|m4v|3gp)$/i.test(name)) return "video";
  return null;
}

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
  const [uploads, setUploads] = useState([]);
  const [uploadsLoading, setUploadsLoading] = useState(false);
  /** null 表示不按日筛选（列出全部）；有值则按服务端本地日历日筛选 */
  const [dateRange, setDateRange] = useState(null);
  const [filePreview, setFilePreview] = useState(null);
  const [autoPurgeHours, setAutoPurgeHours] = useState(0);
  const [purgeSaveBusy, setPurgeSaveBusy] = useState(false);

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

  const queryUploads = useCallback(async () => {
    setUploadsLoading(true);
    try {
      let url = "/api/admin/uploads";
      if (dateRange && dateRange[0] && dateRange[1]) {
        const s = dateRange[0].format("YYYY-MM-DD");
        const e = dateRange[1].format("YYYY-MM-DD");
        url += `?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`;
      }
      const r = await fetch(url);
      if (r.status === 403) {
        setUploads([]);
        message.error("仅本机可查看上传列表");
        return;
      }
      if (!r.ok) {
        setUploads([]);
        message.error("查询失败");
        return;
      }
      const j = await r.json();
      setUploads(Array.isArray(j.files) ? j.files : []);
    } catch {
      setUploads([]);
      message.error("查询失败");
    } finally {
      setUploadsLoading(false);
    }
  }, [dateRange]);

  useEffect(() => {
    void queryUploads();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅首次进入加载全部
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pr = await fetch("/api/admin/upload-auto-purge");
        if (!cancelled && pr.ok) {
          const pj = await pr.json();
          const h = Number(pj.hours);
          if (!Number.isNaN(h)) setAutoPurgeHours(h);
        }
      } catch {
        /* 忽略 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const postJsonLocal = async (url, body) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let j = {};
    try {
      j = await r.json();
    } catch {
      /* ignore */
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

  const saveAutoPurge = async () => {
    const hv = Number(autoPurgeHours);
    if (Number.isNaN(hv) || hv < 0) {
      message.warning("请输入有效的小时数（≥0）");
      return;
    }
    setPurgeSaveBusy(true);
    try {
      const j = await postJsonLocal("/api/admin/upload-auto-purge", { hours: hv });
      if (j && j.hours !== undefined && j.hours !== null) {
        setAutoPurgeHours(Number(j.hours));
        message.success("已保存");
      }
    } finally {
      setPurgeSaveBusy(false);
    }
  };

  const openFilePreview = useCallback((row) => {
    const name = (row.display_name || row.stored_name || "").trim() || row.stored_name;
    setFilePreview({
      stored: row.stored_name,
      name,
      kind: mediaKindFromFileName(name),
    });
  }, []);

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
      content:
        "uploads 目录下文件将全部删除，不可恢复。聊天记录仍会保留其中的文件消息，但聊天内会显示为「文件已不可用」，无法预览或下载。",
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

  const uploadColumns = useMemo(
    () => [
      {
        title: "文件",
        key: "preview",
        width: 300,
        ellipsis: false,
        render: (_, row) => {
          const label = (row.display_name || row.stored_name || "—").toString();
          const mk = mediaKindFromFileName(label);
          const inlineSrc = fileInlineUrl(row.stored_name);
          const open = () => openFilePreview(row);
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              {mk === "image" && (
                <img
                  src={inlineSrc}
                  alt=""
                  width={44}
                  height={44}
                  style={{
                    objectFit: "cover",
                    borderRadius: 4,
                    flexShrink: 0,
                    cursor: "pointer",
                    background: "rgba(0,0,0,0.06)",
                  }}
                  onClick={open}
                />
              )}
              {mk === "video" && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open();
                    }
                  }}
                  style={{
                    position: "relative",
                    width: 44,
                    height: 44,
                    flexShrink: 0,
                    borderRadius: 4,
                    overflow: "hidden",
                    background: "#111",
                    cursor: "pointer",
                  }}
                >
                  <video
                    src={inlineSrc}
                    muted
                    playsInline
                    preload="metadata"
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      pointerEvents: "none",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(0,0,0,0.35)",
                      color: "#fff",
                      fontSize: 18,
                      pointerEvents: "none",
                    }}
                    aria-hidden
                  >
                    <PlayCircleOutlined />
                  </div>
                </div>
              )}
              {!mk && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open();
                    }
                  }}
                  style={{
                    width: 44,
                    height: 44,
                    flexShrink: 0,
                    borderRadius: 4,
                    background: "rgba(0,0,0,0.06)",
                    border: "1px solid rgba(0,0,0,0.08)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: token.colorTextSecondary,
                    fontSize: 22,
                    cursor: "pointer",
                  }}
                  aria-label="无预览，点击查看"
                >
                  <FileOutlined />
                </div>
              )}
              <Typography.Link onClick={open} style={{ minWidth: 0 }} ellipsis>
                {label}
              </Typography.Link>
            </div>
          );
        },
      },
      {
        title: "存储名称",
        dataIndex: "stored_name",
        width: 230,
        onCell: () => ({
          style: { maxWidth: 230, overflow: "hidden", verticalAlign: "middle" },
        }),
        render: (t) => {
          const s = typeof t === "string" ? t : String(t ?? "");
          return (
            <span
              title={s}
              style={{
                display: "block",
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                fontSize: 12,
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {s}
            </span>
          );
        },
      },
      {
        title: "大小",
        dataIndex: "size",
        width: 100,
        render: (s) => fmtSizeAdmin(s),
      },
      {
        title: "上传时间",
        dataIndex: "modified",
        width: 200,
        render: (iso) => {
          try {
            return new Date(iso).toLocaleString();
          } catch {
            return iso || "—";
          }
        },
      },
    ],
    [openFilePreview, token.colorTextSecondary]
  );

  const columns = [
    { title: "昵称", dataIndex: "nick", ellipsis: true },
    {
      title: "状态",
      key: "online",
      width: 96,
      render: (_, row) => {
        const connected = row.online !== false;
        return (
          <Typography.Text type={connected ? "success" : "danger"} style={{ fontSize: 13 }}>
            {connected ? "在线" : "离线"}
          </Typography.Text>
        );
      },
    },
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
    <div style={{ padding: 24, maxWidth: 1120, margin: "0 auto", background: token.colorBgLayout, minHeight: "100%" }}>
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

      <Card title="在线用户" style={{ marginBottom: 16 }}>
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

      <Card title="文件列表" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <Space wrap align="center">
            <Typography.Text type="secondary">日期筛选</Typography.Text>
            <RangePicker
              allowClear
              value={dateRange}
              onChange={(v) => setDateRange(v)}
              format="YYYY-MM-DD"
            />
          </Space>
          <Button type="primary" onClick={() => queryUploads()} loading={uploadsLoading}>
            查询
          </Button>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <Space wrap align="center">
            <Typography.Text type="secondary">自动删除</Typography.Text>
            <InputNumber
              min={0}
              max={17520}
              step={1}
              value={autoPurgeHours}
              onChange={(v) => setAutoPurgeHours(typeof v === "number" ? v : 0)}
              addonAfter="小时"
              style={{ width: 168 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              前上传的文件（按文件修改时间；0 关闭，约每 10 分钟检查）
            </Typography.Text>
          </Space>
          <Button type="default" onClick={() => void saveAutoPurge()} loading={purgeSaveBusy}>
            保存
          </Button>
        </div>
        <Table
          size="small"
          tableLayout="fixed"
          rowKey="stored_name"
          dataSource={uploads}
          columns={uploadColumns}
          loading={uploadsLoading}
          pagination={{ pageSize: 15, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          scroll={{ x: 840 }}
          locale={{ emptyText: "暂无数据，请选择日期后点击查询，或不选日期查询全部" }}
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
        title={filePreview?.name || "预览"}
        open={Boolean(filePreview)}
        onCancel={() => setFilePreview(null)}
        destroyOnClose={false}
        centered
        transitionName=""
        maskTransitionName=""
        footer={
          <Space>
            <Button onClick={() => setFilePreview(null)}>关闭</Button>
            {filePreview?.stored ? (
              <Button
                type="primary"
                href={fileDownloadUrl(filePreview.stored)}
                target="_blank"
                rel="noopener noreferrer"
              >
                下载
              </Button>
            ) : null}
          </Space>
        }
        width={Math.min(720, typeof window !== "undefined" ? window.innerWidth - 48 : 700)}
        {...DIALOG_TITLE_CENTER}
      >
        {filePreview ? (
          filePreview.kind === "image" ? (
            <img
              key={filePreview.stored}
              alt=""
              src={fileInlineUrl(filePreview.stored)}
              style={{ maxWidth: "100%", maxHeight: 480, display: "block", margin: "0 auto" }}
            />
          ) : filePreview.kind === "video" ? (
            <video
              key={filePreview.stored}
              src={fileInlineUrl(filePreview.stored)}
              controls
              playsInline
              style={{ width: "100%", maxHeight: 480, display: "block", background: "#000" }}
            />
          ) : (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              该类型无法在页面内预览，请点击「下载」在本地打开。
            </Typography.Paragraph>
          )
        ) : null}
      </Modal>

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
