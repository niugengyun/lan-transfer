import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  App as AntApp,
  Avatar,
  Badge,
  Button,
  Drawer,
  Empty,
  Input,
  Modal,
  Space,
  Table,
  Typography,
  theme,
} from "antd";
import {
  ArrowLeftOutlined,
  CloudDownloadOutlined,
  EditOutlined,
  FileOutlined,
  FolderOpenOutlined,
  PaperClipOutlined,
  PlayCircleOutlined,
  SearchOutlined,
  TeamOutlined,
} from "@ant-design/icons";

const NICK_KEY = "lan_transfer_nick";
const CID_KEY = "lan_transfer_client_id";
/** 与私聊 client_id 不冲突的群组虚拟 id */
const GROUP_ID = "__lan_group__";

/** 电脑端：左侧「快传」标题栏与右侧聊天顶栏统一高度 */
const DESKTOP_CHAT_TOPBAR_H = 52;

/** 弹窗 / 抽屉：标题居中（Ant Design 5 `styles.header`） */
const DIALOG_TITLE_CENTER = {
  styles: {
    header: { textAlign: "center" },
  },
};

/** 点击头像「用户信息」弹窗宽度（偏窄，避免占屏过大） */
const USER_INFO_MODAL_WIDTH = 300;

const MOBILE_MAX = 768;

/** 微信风格：聊天主区、气泡、底栏（侧栏仍用 Ant Design token） */
const WX_CHAT_BG = "#ebebeb";
const WX_CHAT_FOOT_BG = "#f7f7f7";
const WX_CHAT_FOOT_BORDER = "#dcdcdc";
const WX_CHAT_TOP_BORDER = "#e5e5e5";
const WX_BUBBLE_ME = "#95ec69";
const WX_BUBBLE_ME_TEXT = "#191919";
const WX_BUBBLE_OTHER = "#ffffff";
const WX_BUBBLE_OTHER_TEXT = "#191919";
const WX_LINK = "#576b95";
const WX_META = "#888888";
const WX_AVATAR_OTHER = "#10aeff";
const WX_AVATAR_SELF = "#07c160";
const WX_SEND_ACTIVE = "#07c160";
const WX_BUBBLE_RADIUS = 6;

function randomId() {
  return "c_" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 根据文件名判断聊天内是否按图片/视频内联预览 */
function mediaKindFromFileName(name) {
  if (!name || typeof name !== "string") return null;
  if (/\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name)) return "image";
  if (/\.(mp4|webm|ogg|mov|m4v|3gp)$/i.test(name)) return "video";
  return null;
}

function fileInlineUrl(stored) {
  return `/api/files/${encodeURIComponent(stored)}/inline`;
}

function fileDownloadUrl(stored) {
  return `/api/files/${encodeURIComponent(stored)}/download`;
}

/** 与 server 存储规则一致：{uuid32}_{原始文件名} → 展示用短文件名 */
function displayNameFromStored(storedName) {
  if (!storedName || typeof storedName !== "string") return storedName || "";
  if (storedName.length > 33 && storedName[32] === "_") {
    const prefix = storedName.slice(0, 32).toLowerCase();
    if (prefix.length === 32 && /^[0-9a-f]{32}$/.test(prefix)) {
      return storedName.slice(33) || storedName;
    }
  }
  return storedName;
}

function dmPeerId(data, myIds) {
  const s = data.sender_client_id;
  const t = data.to_client_id;
  if (!myIds?.size || !s || !t) return null;
  if (myIds.has(s)) return t;
  if (myIds.has(t)) return s;
  return null;
}

function dmPeerIdFile(data, myIds) {
  const s = data.from_client_id;
  const t = data.to_client_id;
  if (!myIds?.size || !s || !t) return null;
  if (myIds.has(s)) return t;
  if (myIds.has(t)) return s;
  return null;
}

/** 将服务端持久化的 history items 还原为 threads 结构；myIdSet 为本人所有曾用 client_id（浏览器 id + MAC 主键） */
function buildThreadsFromHistory(clientId, items, myIdSet) {
  const me = myIdSet && myIdSet.size ? myIdSet : new Set([clientId]);
  const threads = { [GROUP_ID]: [] };
  const sorted = [...(items || [])].sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  for (const data of sorted) {
    if (data.type === "text") {
      if (data.scope === "group" || !data.to_client_id) {
        threads[GROUP_ID].push({
          kind: "text",
          mine: me.has(data.sender_client_id),
          from: data.from,
          fromClientId: data.sender_client_id || null,
          body: data.body,
          ts: data.ts,
          _k: data.id || `h-g-${data.ts}-${threads[GROUP_ID].length}`,
        });
      } else {
        const s = data.sender_client_id;
        const t = data.to_client_id;
        const peer = me.has(s) ? t : me.has(t) ? s : null;
        if (!peer) continue;
        if (!threads[peer]) threads[peer] = [];
        threads[peer].push({
          kind: "text",
          mine: me.has(s),
          from: data.from,
          fromClientId: data.sender_client_id || null,
          body: data.body,
          ts: data.ts,
          _k: data.id || `h-${peer}-${data.ts}`,
        });
      }
    } else if (data.type === "file") {
      if (!data.to_client_id) {
        threads[GROUP_ID].push({
          kind: "file",
          name: data.original_name || data.stored_name,
          size: data.size,
          fromLabel: data.uploader,
          fromClientId: data.from_client_id || null,
          stored: data.stored_name,
          ts: data.ts,
          mine: me.has(data.from_client_id),
          _k: data.id || `f-g-${data.stored_name}`,
        });
      } else {
        const peer = dmPeerIdFile(data, me);
        if (!peer) continue;
        if (!threads[peer]) threads[peer] = [];
        threads[peer].push({
          kind: "file",
          name: data.original_name || data.stored_name,
          size: data.size,
          uploader: data.uploader,
          fromClientId: data.from_client_id || null,
          stored: data.stored_name,
          ts: data.ts,
          mine: me.has(data.from_client_id),
          _k: data.id || `f-${peer}-${data.stored_name}`,
        });
      }
    }
  }
  return threads;
}

/** 合并两个会话的消息行并按时间排序，避免别名合并时重复 */
function mergeThreadRowsPreservingOrder(left, right) {
  const seen = new Set();
  const out = [];
  for (const row of [...(left || []), ...(right || [])]) {
    const sig = row.id || `${row.kind}-${row.ts}-${row.stored || ""}-${row.body || ""}-${row.from || ""}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(row);
  }
  out.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  return out;
}

function shortTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** 微信群头像：四宫格拼色 */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_MAX
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX - 1}px)`);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

/** WebSocket 状态：已连接小绿点，否则灰点 */
function WsStatusDot({ connected, size = 6, style }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: connected ? "#52c41a" : "#bfbfbf",
        flexShrink: 0,
        verticalAlign: "middle",
        ...style,
      }}
    />
  );
}

function GroupAvatarWeChat({ size = 48, colors }) {
  const c = colors || ["#1677ff", "#52c41a", "#faad14", "#722ed1"];
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        overflow: "hidden",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "1fr 1fr",
        gap: 1,
        padding: 2,
        boxSizing: "border-box",
        background: "rgba(0,0,0,0.06)",
        flexShrink: 0,
      }}
    >
      {c.slice(0, 4).map((bg, i) => (
        <div key={i} style={{ background: bg, minHeight: 0 }} />
      ))}
    </div>
  );
}

export default function App() {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();

  const [nick, setNick] = useState(() => localStorage.getItem(NICK_KEY) || "");
  const [suggestedNick, setSuggestedNick] = useState("");
  const [nickModalOpen, setNickModalOpen] = useState(false);
  const [nickDraft, setNickDraft] = useState("");
  const [clientId, setClientId] = useState(() => {
    let c = localStorage.getItem(CID_KEY);
    if (!c) {
      c = randomId();
      localStorage.setItem(CID_KEY, c);
    }
    return c;
  });
  const clientIdRef = useRef(clientId);
  const myClientIdsRef = useRef(new Set([clientId]));
  useLayoutEffect(() => {
    clientIdRef.current = clientId;
  }, [clientId]);

  const [devices, setDevices] = useState([]);
  /** 当前 HTTP 服务所在机器的内网 IPv4（与 /api/lan-host 一致，全站只展示此地址） */
  const [serverLanIp, setServerLanIp] = useState("");
  const [search, setSearch] = useState("");
  const [wsState, setWsState] = useState("连接中…");
  const [threads, setThreads] = useState({});
  /** 默认打开群组 */
  const [selectedChatId, setSelectedChatId] = useState(GROUP_ID);
  const isMobile = useIsMobile();
  /** 手机端：列表与聊天分屏切换 */
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [fileDrawer, setFileDrawer] = useState(false);
  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [input, setInput] = useState("");
  const [uploading, setUploading] = useState(false);
  /** 图片/视频点击放大：{ kind, stored, name } */
  const [mediaPreview, setMediaPreview] = useState(null);
  /** 消息列表点头像：{ clientId, fallbackNick }，clientId 可为 null（旧记录无设备 id） */
  const [userInfoModal, setUserInfoModal] = useState(null);
  /** 各会话未读条数（仅统计他人新消息；当前正在查看的会话不计入） */
  const [unreadByChat, setUnreadByChat] = useState({});
  /** 电脑端：聊天区「用户列表」弹窗 */
  const [lanUsersModalOpen, setLanUsersModalOpen] = useState(false);
  /** 在线升级：仅启动后由前端静默请求服务端 /api/update/check；不在界面提供手动检查按钮 */
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);

  const wsRef = useRef(null);
  const selectedChatRef = useRef(selectedChatId);
  const mobileChatOpenRef = useRef(mobileChatOpen);
  const isMobileRef = useRef(isMobile);
  const reconnectRef = useRef(null);
  /** 仅右侧聊天消息区滚动，禁止 scrollIntoView（会滚动祖先导致底栏被顶出视口） */
  const chatScrollRef = useRef(null);
  const fileInputRef = useRef(null);

  const scrollBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = chatScrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  const appendToThread = useCallback(
    (chatId, row) => {
      if (!chatId) return;
      setThreads((prev) => {
        const cur = prev[chatId] || [];
        return { ...prev, [chatId]: [...cur, { ...row, _k: Math.random().toString(36).slice(2) }] };
      });
      setTimeout(scrollBottom, 50);
    },
    [scrollBottom]
  );

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const q = new URLSearchParams({
        chat_id: selectedChatId,
        client_id: clientId,
      });
      const res = await fetch(`/api/files?${q.toString()}`);
      const j = await res.json();
      setFiles(j.files || []);
    } catch {
      message.error("加载文件列表失败");
    } finally {
      setFilesLoading(false);
    }
  }, [message, selectedChatId, clientId]);

  /** 拉取在线设备；成功返回列表并写入 state，失败返回 null */
  const fetchOnline = useCallback(async () => {
    try {
      const res = await fetch("/api/online");
      const j = await res.json();
      const list = Array.isArray(j.devices) ? j.devices : [];
      setDevices(list);
      return list;
    } catch {
      return null;
    }
  }, []);

  const checkingUpdateRef = useRef(false);
  const checkForUpdateSilent = useCallback(async () => {
    if (checkingUpdateRef.current) return;
    checkingUpdateRef.current = true;
    try {
      const res = await fetch("/api/update/check");
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

  const connectWs = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const n = (nick || "").trim() || "匿名";
    const cid = clientIdRef.current;
    const url =
      `${proto}//${location.host}/ws?` +
      `client_id=${encodeURIComponent(cid)}&nick=${encodeURIComponent(n)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setWsState("连接中…");

    ws.onopen = () => {
      clearTimeout(reconnectRef.current);
      setWsState("已连接");
      ws.send(JSON.stringify({ type: "join", from: n }));
      fetchOnline();
    };
    ws.onclose = () => {
      setWsState("已断开，重连中…");
      reconnectRef.current = setTimeout(connectWs, 2000);
    };
    ws.onerror = () => setWsState("连接异常");
    ws.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      const me = () => myClientIdsRef.current;
      const bumpUnreadIfNeeded = (chatId, mine) => {
        if (!chatId || mine) return;
        const sid = selectedChatRef.current;
        const mob = isMobileRef.current;
        const open = mobileChatOpenRef.current;
        const viewingThisChat = sid === chatId && (!mob || open);
        if (viewingThisChat) return;
        setUnreadByChat((p) => ({ ...p, [chatId]: (p[chatId] || 0) + 1 }));
      };

      if (data.type === "presence" && Array.isArray(data.devices)) {
        const list = data.devices;
        setDevices(list);
        setThreads((prev) => {
          const next = { ...prev, [GROUP_ID]: [...(prev[GROUP_ID] || [])] };
          for (const d of list) {
            const canon = d.client_id;
            const aliases = Array.isArray(d.aliases) ? d.aliases : [];
            for (const old of aliases) {
              if (!old || old === canon || old === GROUP_ID) continue;
              if (next[old]?.length) {
                next[canon] = mergeThreadRowsPreservingOrder(next[canon], next[old]);
                delete next[old];
              }
            }
          }
          return next;
        });
        setSelectedChatId((sel) => {
          for (const d of list) {
            const aliases = Array.isArray(d.aliases) ? d.aliases : [];
            for (const old of aliases) {
              if (old === sel && d.client_id && d.client_id !== sel) return d.client_id;
            }
          }
          return sel;
        });
        return;
      }
      if (data.type === "history") {
        const primary = (data.client_id || clientIdRef.current || "").trim() || clientIdRef.current;
        const merged = new Set([
          primary,
          ...(Array.isArray(data.merged_client_ids) ? data.merged_client_ids : []),
          clientIdRef.current,
        ]);
        myClientIdsRef.current = merged;
        if (primary) {
          localStorage.setItem(CID_KEY, primary);
          clientIdRef.current = primary;
          setClientId(primary);
        }
        const nextThreads = buildThreadsFromHistory(primary, data.items, merged);
        setThreads(nextThreads);
        setUnreadByChat({});
        setSelectedChatId((sel) => {
          if (sel === GROUP_ID) return sel;
          if (nextThreads[sel]) return sel;
          return GROUP_ID;
        });
        return;
      }
      if (data.type === "chat_history_cleared") {
        setThreads({ [GROUP_ID]: [] });
        setUnreadByChat({});
        message.info("所有聊天记录与上传文件已由本机管理员清空");
        return;
      }
      if (data.type === "error") {
        message.warning(data.message || "操作失败");
        return;
      }
      if (data.type === "text") {
        if (data.scope === "group" || !data.to_client_id) {
          const mine = me().has(data.sender_client_id);
          appendToThread(GROUP_ID, {
            kind: "text",
            mine,
            from: data.from,
            fromClientId: data.sender_client_id || null,
            body: data.body,
            ts: data.ts,
          });
          bumpUnreadIfNeeded(GROUP_ID, mine);
          return;
        }
        const peer = dmPeerId(data, me());
        if (!peer) return;
        const mine = me().has(data.sender_client_id);
        appendToThread(peer, {
          kind: "text",
          mine,
          from: data.from,
          fromClientId: data.sender_client_id || null,
          body: data.body,
          ts: data.ts,
        });
        bumpUnreadIfNeeded(peer, mine);
        return;
      }
      if (data.type === "file") {
        if (!data.to_client_id) {
          const mine = me().has(data.from_client_id);
          appendToThread(GROUP_ID, {
            kind: "file",
            name: data.original_name || data.stored_name,
            size: data.size,
            fromLabel: data.uploader,
            fromClientId: data.from_client_id || null,
            stored: data.stored_name,
            ts: data.ts,
            mine,
          });
          bumpUnreadIfNeeded(GROUP_ID, mine);
          loadFiles();
          return;
        }
        const peer = dmPeerIdFile(data, me());
        if (peer) {
          const mine = me().has(data.from_client_id);
          appendToThread(peer, {
            kind: "file",
            name: data.original_name || data.stored_name,
            size: data.size,
            uploader: data.uploader,
            fromClientId: data.from_client_id || null,
            stored: data.stored_name,
            ts: data.ts,
            mine,
          });
          bumpUnreadIfNeeded(peer, mine);
        }
        loadFiles();
        return;
      }
      if (data.type === "cleared") {
        loadFiles();
        return;
      }
    };
  }, [nick, appendToThread, loadFiles, message, fetchOnline]);

  useEffect(() => {
    connectWs();
    loadFiles();
    const poll = setInterval(fetchOnline, 4000);
    return () => {
      clearInterval(poll);
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/lan-host");
        const j = await res.json();
        const ip = typeof j.ip === "string" ? j.ip.trim() : "";
        if (!cancelled && ip) setServerLanIp(ip);
      } catch {
        /* 忽略 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      checkForUpdateSilent();
    }, 3000);
    return () => clearTimeout(t);
  }, [checkForUpdateSilent]);

  useEffect(() => {
    localStorage.setItem(NICK_KEY, nick);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join", from: (nick || "").trim() || "匿名" }));
    }
  }, [nick]);

  useEffect(() => {
    if (!isMobile) setMobileChatOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (fileDrawer) loadFiles();
  }, [selectedChatId, fileDrawer, loadFiles]);

  useEffect(() => {
    if (lanUsersModalOpen) fetchOnline();
  }, [lanUsersModalOpen, fetchOnline]);

  /** 用户列表仅群组可用：切到私聊时若弹窗仍开着则关闭 */
  useEffect(() => {
    if (selectedChatId !== GROUP_ID && lanUsersModalOpen) setLanUsersModalOpen(false);
  }, [selectedChatId, lanUsersModalOpen]);

  useEffect(() => {
    selectedChatRef.current = selectedChatId;
    mobileChatOpenRef.current = mobileChatOpen;
    isMobileRef.current = isMobile;
  }, [selectedChatId, mobileChatOpen, isMobile]);

  /** 正在查看某会话消息流时清除该会话未读 */
  useEffect(() => {
    const viewingMessages = !isMobile || mobileChatOpen;
    if (!viewingMessages) return;
    setUnreadByChat((prev) => {
      if (!prev[selectedChatId]) return prev;
      return { ...prev, [selectedChatId]: 0 };
    });
  }, [selectedChatId, mobileChatOpen, isMobile]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/suggest-nick");
        const j = await r.json();
        const s = (j.nick || "").trim();
        if (cancelled || !s) return;
        setSuggestedNick(s);
        if (!localStorage.getItem(NICK_KEY)) {
          setNick(s);
          localStorage.setItem(NICK_KEY, s);
        }
      } catch {
        /* 忽略 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openNickModal = useCallback(() => {
    setNickDraft((nick || suggestedNick || "").trim());
    setNickModalOpen(true);
  }, [nick, suggestedNick]);

  const applyNickFromModal = useCallback(async () => {
    const v = (nickDraft || "").trim() || suggestedNick.trim() || "匿名";
    if (v.length > 32) {
      message.warning("昵称最多 32 个字");
      throw new Error("nick-length");
    }
    const nickNorm = (s) => {
      const t = (s || "").trim() || "匿名";
      return t.toLowerCase();
    };
    const list = await fetchOnline();
    if (list === null) {
      message.error("无法获取局域网在线列表，请稍后重试");
      throw new Error("nick-fetch");
    }
    const target = nickNorm(v);
    const dup = list.find((d) => d.client_id !== clientId && nickNorm(d.nick) === target);
    if (dup) {
      message.error("该昵称已被其他设备使用，请换一个");
      throw new Error("nick-dup");
    }
    setNick(v);
    localStorage.setItem(NICK_KEY, v);
    setNickModalOpen(false);
    message.success("昵称已更新");
  }, [nickDraft, suggestedNick, message, clientId, fetchOnline]);

  const listBg = token.colorBgContainer;
  const rowActive = token.controlItemBgActive;
  const searchBg = token.colorFillTertiary;
  const borderLine = token.colorSplit;
  const shellBg = token.colorBgLayout;
  const chatBg = WX_CHAT_BG;
  const avatarSize = isMobile ? 52 : 48;
  const groupAvatarColors = [token.colorPrimary, token.colorSuccess, token.colorWarning, token.colorInfo];

  const others = useMemo(() => devices.filter((d) => d.client_id !== clientId), [devices, clientId]);

  /** 电脑端用户列表：在线设备 + 仅有私聊历史但当前不在线的对方，绿/灰点 */
  const desktopLanUsersList = useMemo(() => {
    const onlineIds = new Set(devices.map((d) => d.client_id));
    const map = new Map();
    for (const d of devices) {
      map.set(d.client_id, {
        client_id: d.client_id,
        nick: (d.nick || "").trim() || "匿名",
        ip: (d.ip || "").trim(),
        mac: (d.mac || "").trim(),
        online: true,
      });
    }
    const threadPeerIds = Object.keys(threads).filter(
      (k) => k && k !== GROUP_ID && k !== clientId && (threads[k]?.length || 0) > 0
    );
    for (const pid of threadPeerIds) {
      if (map.has(pid)) continue;
      const rows = threads[pid] || [];
      let label = "离线会话";
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i];
        if (r.kind === "text" && !r.mine && r.from) {
          label = r.from;
          break;
        }
        if (r.kind === "file" && !r.mine && (r.fromLabel || r.uploader)) {
          label = r.fromLabel || r.uploader || label;
          break;
        }
      }
      map.set(pid, {
        client_id: pid,
        nick: label,
        ip: "",
        mac: "",
        online: false,
      });
    }
    if (!map.has(clientId)) {
      map.set(clientId, {
        client_id: clientId,
        nick: (nick || "").trim() || "匿名",
        ip: "",
        mac: "",
        online: onlineIds.has(clientId),
      });
    }
    const arr = [...map.values()];
    arr.sort((a, b) => {
      if (a.client_id === clientId) return -1;
      if (b.client_id === clientId) return 1;
      return (a.nick || "").localeCompare(b.nick || "", "zh-CN");
    });
    return arr;
  }, [devices, threads, clientId, nick]);

  /** 私聊侧栏：在线设备 + 仅存在于历史里的离线会话，带 online 标记与绿/灰点 */
  const mergedPrivateSidebar = useMemo(() => {
    const q = search.trim().toLowerCase();
    const onlineIds = new Set(devices.map((d) => d.client_id));

    const baseFromDevices = [...others].filter((d) => {
      if (!q) return true;
      return (
        (d.nick || "").toLowerCase().includes(q) ||
        (d.ip || "").toLowerCase().includes(q) ||
        (d.mac || "").toLowerCase().includes(q) ||
        (d.client_id || "").toLowerCase().includes(q)
      );
    });

    const threadPeerIds = Object.keys(threads).filter(
      (k) => k && k !== GROUP_ID && k !== clientId && (threads[k]?.length || 0) > 0
    );
    const map = new Map();
    for (const d of baseFromDevices) {
      map.set(d.client_id, {
        client_id: d.client_id,
        nick: d.nick,
        ip: d.ip,
        mac: (d.mac || "").trim(),
        connected_at: d.connected_at,
        online: onlineIds.has(d.client_id),
      });
    }
    for (const pid of threadPeerIds) {
      if (map.has(pid)) continue;
      const rows = threads[pid] || [];
      let label = "离线会话";
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i];
        if (r.kind === "text" && !r.mine && r.from) {
          label = r.from;
          break;
        }
        if (r.kind === "file" && !r.mine && (r.fromLabel || r.uploader)) {
          label = r.fromLabel || r.uploader || label;
          break;
        }
      }
      if (q) {
        const hit =
          label.toLowerCase().includes(q) ||
          pid.toLowerCase().includes(q);
        if (!hit) continue;
      }
      map.set(pid, {
        client_id: pid,
        nick: label,
        ip: "",
        mac: "",
        connected_at: "",
        online: false,
      });
    }
    const arr = [...map.values()];
    arr.sort((a, b) => {
      const arrA = threads[a.client_id];
      const arrB = threads[b.client_id];
      const ta = (arrA?.length ? arrA[arrA.length - 1]?.ts : null) || a.connected_at || "";
      const tb = (arrB?.length ? arrB[arrB.length - 1]?.ts : null) || b.connected_at || "";
      return String(tb).localeCompare(String(ta));
    });
    return arr;
  }, [devices, others, threads, clientId, search]);

  const lastPreview = useCallback(
    (chatId) => {
      const arr = threads[chatId];
      if (!arr?.length) return "";
      const last = arr[arr.length - 1];
      if (last.kind === "file") return chatId === GROUP_ID ? "[文件]" : "📎 文件";
      if (last.kind === "text") {
        const body = (last.body || "").slice(0, 40);
        if (chatId === GROUP_ID) {
          if (last.mine) return body;
          return `${last.from || "?"}: ${body}`;
        }
        return body.slice(0, 36);
      }
      return "";
    },
    [threads]
  );

  const rowTimeFor = useCallback(
    (chatId, fallbackIso) => {
      const arr = threads[chatId];
      if (arr?.length && arr[arr.length - 1]?.ts) return shortTime(arr[arr.length - 1].ts);
      if (fallbackIso) return shortTime(fallbackIso);
      return "";
    },
    [threads]
  );

  const selectedDevice = useMemo(
    () => devices.find((d) => d.client_id === selectedChatId),
    [devices, selectedChatId]
  );

  const isGroup = selectedChatId === GROUP_ID;
  const currentRows = threads[selectedChatId] || [];
  const chatEmpty = currentRows.length === 0;

  /** 进入聊天页 / 切换会话 / 手机展开消息区后，将消息列表滚到底（须同步布局，避免未生效） */
  useLayoutEffect(() => {
    if (currentRows.length === 0) return;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const box = chatScrollRef.current;
      if (box) box.scrollTop = box.scrollHeight;
    });
  }, [selectedChatId, currentRows.length, mobileChatOpen]);

  const sendText = () => {
    const body = input.trim();
    if (!body) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      message.warning("未连接到服务器");
      return;
    }
    const n = (nick || "").trim() || "匿名";
    if (isGroup) {
      ws.send(JSON.stringify({ type: "text", from: n, body, scope: "group" }));
    } else {
      ws.send(JSON.stringify({ type: "text", from: n, body, to_client_id: selectedChatId }));
    }
    setInput("");
  };

  const onPickFiles = async (list) => {
    if (!list?.length) return;
    setUploading(true);
    const n = (nick || "").trim() || "匿名";
    try {
      for (const file of list) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("uploader", n);
        fd.append("from_client_id", clientId);
        if (!isGroup) {
          fd.append("to_client_id", selectedChatId);
        }
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        if (!res.ok) throw new Error(file.name);
      }
      message.success(isGroup ? "已上传到群组（所有人可见）" : "已发送给对方");
      loadFiles();
    } catch {
      message.error("上传失败");
    } finally {
      setUploading(false);
    }
  };

  const openDrawer = () => {
    setFileDrawer(true);
    loadFiles();
  };

  const openDrawerFilePreview = (r) => {
    const label = displayNameFromStored(r.stored_name);
    const mk = mediaKindFromFileName(label);
    setMediaPreview({
      kind: mk || "file",
      stored: r.stored_name,
      name: label,
      size: r.size ?? 0,
    });
  };

  const fileColumns = [
    {
      title: "文件",
      key: "name",
      ellipsis: false,
      render: (_, r) => {
        const stored = r.stored_name;
        const label = displayNameFromStored(stored);
        const mk = mediaKindFromFileName(label);
        const inlineSrc = fileInlineUrl(stored);
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
                onClick={() => openDrawerFilePreview(r)}
              />
            )}
            {mk === "video" && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => openDrawerFilePreview(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openDrawerFilePreview(r);
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
                >
                  <PlayCircleOutlined />
                </div>
              </div>
            )}
            {!mk && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => openDrawerFilePreview(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openDrawerFilePreview(r);
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
            <Typography.Link
              style={{ padding: 0, minWidth: 0, display: "block" }}
              ellipsis
              onClick={(e) => {
                e.preventDefault();
                openDrawerFilePreview(r);
              }}
            >
              {label}
            </Typography.Link>
          </div>
        );
      },
    },
    { title: "大小", width: 90, render: (_, r) => fmtSize(r.size || 0) },
    {
      title: "时间",
      width: 160,
      render: (_, r) => {
        try {
          return new Date(r.modified).toLocaleString();
        } catch {
          return "—";
        }
      },
    },
  ];

  const peerOnline = !isGroup && others.some((d) => d.client_id === selectedChatId);

  /** 消息气泡旁头像：根据在线列表显示该用户的 IP 与昵称 */
  const openChatUserProfile = useCallback(
    (mine, rowFromClientId, fallbackNick) => {
      const cid = mine ? rowFromClientId || clientId : rowFromClientId;
      const fb = (fallbackNick || "").trim() || (mine ? "我" : "?");
      setUserInfoModal({ clientId: cid || null, fallbackNick: fb });
    },
    [clientId]
  );

  const renderMessageRow = (r) => {
    if (r.kind === "file") {
      const mine = r.mine;
      const showWho = isGroup && (r.fromLabel || r.uploader);
      const whoName = r.fromLabel || r.uploader || "?";
      const mediaKind = mediaKindFromFileName(r.name);
      const inlineSrc = fileInlineUrl(r.stored);
      const openMedia = () => setMediaPreview({ kind: mediaKind, stored: r.stored, name: r.name });
      const onMediaKeyDown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openMedia();
        }
      };
      return (
        <div
          key={r._k}
          style={{
            display: "flex",
            justifyContent: mine ? "flex-end" : "flex-start",
            alignItems: "flex-start",
          }}
        >
          {!mine && (
            <Avatar
              role="button"
              tabIndex={0}
              size={36}
              style={{
                marginRight: 8,
                backgroundColor: WX_AVATAR_OTHER,
                flexShrink: 0,
                alignSelf: "flex-start",
                cursor: "pointer",
              }}
              onClick={(e) => {
                e.stopPropagation();
                openChatUserProfile(false, r.fromClientId, whoName);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openChatUserProfile(false, r.fromClientId, whoName);
                }
              }}
            >
              {whoName.slice(0, 1)}
            </Avatar>
          )}
          <div style={{ maxWidth: "75%" }}>
            {showWho && !mine && (
              <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                {whoName}
              </Typography.Text>
            )}
            <div
              style={{
                marginTop: showWho && !mine ? 2 : 0,
                background: mine ? WX_BUBBLE_ME : WX_BUBBLE_OTHER,
                color: mine ? WX_BUBBLE_ME_TEXT : WX_BUBBLE_OTHER_TEXT,
                borderRadius: WX_BUBBLE_RADIUS,
                padding: "10px 14px",
                border: mine ? "none" : "1px solid #eaeaea",
              }}
            >
              {mediaKind === "image" && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={openMedia}
                  onKeyDown={onMediaKeyDown}
                  style={{ cursor: "pointer", marginBottom: 6 }}
                >
                  <img
                    src={inlineSrc}
                    alt={r.name}
                    loading="lazy"
                    style={{
                      maxWidth: "min(260px, 100%)",
                      maxHeight: 220,
                      borderRadius: 4,
                      display: "block",
                      background: "rgba(0,0,0,0.06)",
                    }}
                  />
                </div>
              )}
              {mediaKind === "video" && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={openMedia}
                  onKeyDown={onMediaKeyDown}
                  style={{
                    position: "relative",
                    maxWidth: 280,
                    cursor: "pointer",
                    marginBottom: 6,
                    borderRadius: 4,
                    overflow: "hidden",
                    background: "#111",
                  }}
                >
                  <video
                    src={inlineSrc}
                    muted
                    playsInline
                    preload="metadata"
                    style={{
                      width: "100%",
                      maxHeight: 200,
                      display: "block",
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
                      background: "rgba(0,0,0,0.38)",
                      color: "#fff",
                      fontSize: 44,
                      lineHeight: 1,
                      pointerEvents: "none",
                    }}
                    aria-hidden
                  >
                    <PlayCircleOutlined />
                  </div>
                </div>
              )}
              {mediaKind ? (
                <div>
                  <Typography.Text style={{ fontSize: 13, color: mine ? WX_BUBBLE_ME_TEXT : WX_BUBBLE_OTHER_TEXT }}>
                    {r.name}
                  </Typography.Text>
                  <div>
                    <Typography.Text style={{ fontSize: 12, color: WX_META }}>
                      {fmtSize(r.size || 0)}
                    </Typography.Text>
                  </div>
                </div>
              ) : (
                <>
                  <Typography.Link
                    href={fileDownloadUrl(r.stored)}
                    style={{ color: WX_LINK }}
                  >
                    {r.name}
                  </Typography.Link>
                  <div>
                    <Typography.Text style={{ fontSize: 12, color: WX_META }}>
                      {fmtSize(r.size || 0)}
                    </Typography.Text>
                  </div>
                </>
              )}
            </div>
            <Typography.Text
              style={{
                fontSize: 10,
                color: WX_META,
                display: "block",
                marginTop: 4,
                textAlign: mine ? "right" : "left",
                paddingLeft: mine ? 0 : 4,
                paddingRight: mine ? 4 : 0,
              }}
            >
              {shortTime(r.ts)}
            </Typography.Text>
          </div>
          {mine && (
            <Avatar
              role="button"
              tabIndex={0}
              size={36}
              style={{
                marginLeft: 8,
                backgroundColor: WX_AVATAR_SELF,
                flexShrink: 0,
                alignSelf: "flex-start",
                cursor: "pointer",
              }}
              onClick={(e) => {
                e.stopPropagation();
                openChatUserProfile(true, r.fromClientId, (nick || "").trim() || "我");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openChatUserProfile(true, r.fromClientId, (nick || "").trim() || "我");
                }
              }}
            >
              {(nick || "我").slice(0, 1)}
            </Avatar>
          )}
        </div>
      );
    }
    const mine = r.mine;
    const showFromLine = isGroup && !mine;
    return (
      <div
        key={r._k}
        style={{
          display: "flex",
          justifyContent: mine ? "flex-end" : "flex-start",
          alignItems: "flex-start",
        }}
      >
        {!mine && (
          <Avatar
            role="button"
            tabIndex={0}
            size={36}
            style={{
              marginRight: 8,
              backgroundColor: WX_AVATAR_OTHER,
              flexShrink: 0,
              alignSelf: "flex-start",
              cursor: "pointer",
            }}
            onClick={(e) => {
              e.stopPropagation();
              openChatUserProfile(false, r.fromClientId, r.from || "?");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openChatUserProfile(false, r.fromClientId, r.from || "?");
              }
            }}
          >
            {(r.from || "?").slice(0, 1)}
          </Avatar>
        )}
        <div style={{ maxWidth: "75%" }}>
          {showFromLine && (
            <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
              {r.from}
            </Typography.Text>
          )}
          <div
            style={{
              marginTop: showFromLine ? 2 : 0,
              background: mine ? WX_BUBBLE_ME : WX_BUBBLE_OTHER,
              color: mine ? WX_BUBBLE_ME_TEXT : WX_BUBBLE_OTHER_TEXT,
              borderRadius: WX_BUBBLE_RADIUS,
              padding: "9px 13px",
              fontSize: isMobile ? 16 : 15,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              border: mine ? "none" : "1px solid #eaeaea",
            }}
          >
            {r.body}
          </div>
          <Typography.Text
            style={{
              fontSize: 10,
              color: WX_META,
              display: "block",
              marginTop: 4,
              textAlign: mine ? "right" : "left",
              paddingLeft: mine ? 0 : 4,
              paddingRight: mine ? 4 : 0,
            }}
          >
            {shortTime(r.ts)}
          </Typography.Text>
        </div>
        {mine && (
          <Avatar
            role="button"
            tabIndex={0}
            size={36}
            style={{
              marginLeft: 8,
              backgroundColor: WX_AVATAR_SELF,
              flexShrink: 0,
              alignSelf: "flex-start",
              cursor: "pointer",
            }}
            onClick={(e) => {
              e.stopPropagation();
              openChatUserProfile(true, r.fromClientId, (nick || "").trim() || "我");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openChatUserProfile(true, r.fromClientId, (nick || "").trim() || "我");
              }
            }}
          >
            {(nick || "我").slice(0, 1)}
          </Avatar>
        )}
      </div>
    );
  };

  let userProfileNick = "";
  let userProfileIp = "";
  /** 与 WsStatusDot 一致：在线绿点 / 离线灰点 */
  let userProfileOnline = false;
  let userProfileStatusText = "";
  if (userInfoModal) {
    const um = userInfoModal;
    const online = um.clientId
      ? devices.find(
          (d) =>
            d.client_id === um.clientId ||
            (Array.isArray(d.aliases) && d.aliases.includes(um.clientId))
        )
      : null;
    userProfileNick = (online?.nick || "").trim() || um.fallbackNick || "匿名";
    userProfileIp = (online?.ip || "").trim() || "—";
    if (!um.clientId) {
      userProfileOnline = false;
      userProfileStatusText = "未知（无设备标识，无法判断在线状态）";
    } else if (online) {
      userProfileOnline = true;
      userProfileStatusText = "在线";
    } else {
      userProfileOnline = false;
      userProfileStatusText = "不在线";
    }
  }

  const showListPanel = !isMobile || (isMobile && !mobileChatOpen);
  const showChatPanel = !isMobile || (isMobile && mobileChatOpen);
  const openChatMobile = () => {
    if (isMobile) setMobileChatOpen(true);
  };
  const titleFont = isMobile ? 17 : 16;
  const rowPad = isMobile ? "14px 16px 14px 12px" : "10px 12px 10px 10px";

  const pageBg = isMobile && mobileChatOpen ? chatBg : shellBg;
  /** 输入栏贴浏览器视口最底（桌面占右侧栏宽度，手机全宽），消息区预留底部内边距避免被挡住 */
  const inputBarViewportFixed = showChatPanel && (!isMobile || mobileChatOpen);
  /**
   * 固定底栏时 .lan-scroll-y 的 padding-bottom：须大于输入条实际高度（含内边距、圆角按钮行），
   * 再留出与最后一条消息之间的空隙，避免内容贴到输入框上沿。
   */
  const inputBarBottomReserve = "max(120px, calc(104px + env(safe-area-inset-bottom, 0px)))";

  return (
    <div
      className="lan-app-shell"
      style={{
        background: pageBg,
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
    >
      <div className="lan-app-main" style={{ background: pageBg }}>
        <div
          style={{
            flex: !isMobile ? "0 0 300px" : showListPanel ? "1 1 0%" : "0 0 0",
            width: !isMobile ? 300 : showListPanel ? "100%" : 0,
            minWidth: !isMobile ? 300 : 0,
            maxWidth: !isMobile ? 300 : showListPanel ? "100%" : 0,
            minHeight: 0,
            display: showListPanel ? "flex" : "none",
            flexDirection: "column",
            background: listBg,
            borderRight: !isMobile ? `1px solid ${borderLine}` : "none",
            overflow: "hidden",
          }}
        >
          {!isMobile && (
            <>
            <header
              style={{
                flexShrink: 0,
                height: DESKTOP_CHAT_TOPBAR_H,
                boxSizing: "border-box",
                width: "100%",
                display: "flex",
                alignItems: "center",
                padding: "0 12px",
                background: token.colorBgContainer,
                borderBottom: `1px solid ${borderLine}`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "nowrap",
                  width: "100%",
                  minHeight: 0,
                }}
              >
                <Typography.Title
                  level={5}
                  style={{
                    margin: 0,
                    padding: 0,
                    lineHeight: "24px",
                    flex: "1 1 auto",
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    fontSize: 15,
                  }}
                >
                  快传
                </Typography.Title>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={openNickModal}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openNickModal();
                    }
                  }}
                  title="点击修改昵称"
                  style={{
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    maxWidth: 140,
                    minWidth: 0,
                    cursor: "pointer",
                  }}
                >
                  <Typography.Text
                    strong
                    ellipsis
                    style={{
                      fontSize: 15,
                      color: token.colorText,
                      maxWidth: 108,
                      lineHeight: 1.35,
                    }}
                  >
                    {(nick || "").trim() || "匿名"}
                  </Typography.Text>
                  <EditOutlined style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }} aria-hidden />
                </span>
              </div>
            </header>
            {updateInfo?.success && updateInfo?.has_update ? (
              <div
                style={{
                  flexShrink: 0,
                  padding: "4px 12px 10px",
                  background: listBg,
                  borderBottom: `1px solid ${borderLine}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <Typography.Text type="warning" strong style={{ fontSize: 12 }}>
                  有新版本可用
                </Typography.Text>
              </div>
            ) : null}
            </>
          )}
          {isMobile && (
            <div
              style={{
                flexShrink: 0,
                padding: "12px 12px 8px",
                background: listBg,
                borderBottom: `1px solid ${borderLine}`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "nowrap",
                }}
              >
                <Typography.Text strong style={{ fontSize: 18, color: token.colorTextHeading, flexShrink: 0 }}>
                  快传
                </Typography.Text>
                <div style={{ flex: 1, minWidth: 8 }} />
                <span
                  role="button"
                  tabIndex={0}
                  onClick={openNickModal}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openNickModal();
                    }
                  }}
                  title="点击修改昵称"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    maxWidth: 140,
                    minWidth: 0,
                    flexShrink: 1,
                    cursor: "pointer",
                  }}
                >
                  <Typography.Text
                    strong
                    ellipsis
                    style={{
                      fontSize: 15,
                      color: token.colorText,
                      minWidth: 0,
                      lineHeight: 1.35,
                    }}
                  >
                    {(nick || "").trim() || "匿名"}
                  </Typography.Text>
                  <EditOutlined style={{ fontSize: 14, color: token.colorTextSecondary, flexShrink: 0 }} aria-hidden />
                </span>
              </div>
              {updateInfo?.success && updateInfo?.has_update ? (
                <div
                  style={{
                    marginTop: 6,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <Typography.Text type="warning" strong style={{ fontSize: 11 }}>
                    有新版本可用
                  </Typography.Text>
                </div>
              ) : null}
            </div>
          )}
          <div
            style={{
              flexShrink: 0,
              padding: isMobile ? "10px 12px 8px" : "10px 10px 8px",
              background: listBg,
              borderBottom: `1px solid ${borderLine}`,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Input
                allowClear
                size="middle"
                variant="borderless"
                placeholder="搜索"
                prefix={<SearchOutlined style={{ color: token.colorTextTertiary, fontSize: 14 }} />}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  flex: 1,
                  borderRadius: 6,
                  background: searchBg,
                  fontSize: 13,
                }}
              />
            </div>
          </div>
          <div className="lan-scroll-y" style={{ background: listBg }}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                setSelectedChatId(GROUP_ID);
                openChatMobile();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setSelectedChatId(GROUP_ID);
                  openChatMobile();
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                padding: rowPad,
                cursor: "pointer",
                background: isGroup ? rowActive : listBg,
                borderBottom: `1px solid ${borderLine}`,
              }}
            >
              <Badge count={unreadByChat[GROUP_ID] || 0} overflowCount={99} size="small" offset={[-2, 4]}>
                <span style={{ display: "inline-block", lineHeight: 0 }}>
                  <GroupAvatarWeChat size={avatarSize} colors={groupAvatarColors} />
                </span>
              </Badge>
              <div style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: titleFont,
                      color: token.colorTextHeading,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    群组广播
                  </span>
                  <span style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }}>
                    {rowTimeFor(GROUP_ID, null)}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 3,
                    fontSize: isMobile ? 14 : 13,
                    color: token.colorTextDescription,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {`在线 ${devices.length} 人`}
                  {lastPreview(GROUP_ID) ? ` · ${lastPreview(GROUP_ID)}` : ""}
                </div>
              </div>
            </div>

            {mergedPrivateSidebar.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center" }}>
                <Typography.Text style={{ fontSize: 13, color: token.colorTextDescription }}>
                  暂无私聊会话
                </Typography.Text>
              </div>
            ) : (
              mergedPrivateSidebar.map((item) => {
                const active = item.client_id === selectedChatId;
                return (
                  <div
                    key={item.client_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelectedChatId(item.client_id);
                      openChatMobile();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        setSelectedChatId(item.client_id);
                        openChatMobile();
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: rowPad,
                      cursor: "pointer",
                      background: active ? rowActive : listBg,
                      borderBottom: `1px solid ${borderLine}`,
                    }}
                  >
                    <Badge count={unreadByChat[item.client_id] || 0} overflowCount={99} size="small" offset={[-2, 4]}>
                      <Avatar
                        shape="square"
                        size={avatarSize}
                        style={{
                          borderRadius: 6,
                          backgroundColor: token.colorPrimary,
                          flexShrink: 0,
                        }}
                      >
                        {(item.nick || "?").slice(0, 1)}
                      </Avatar>
                    </Badge>
                    <div style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: titleFont,
                            color: token.colorTextHeading,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "flex",
                            alignItems: "center",
                            minWidth: 0,
                          }}
                        >
                          <WsStatusDot connected={item.online} size={5} style={{ marginRight: 6, flexShrink: 0 }} />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.nick || "匿名"}</span>
                        </span>
                        <span style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }}>
                          {rowTimeFor(item.client_id, item.connected_at)}
                        </span>
                      </div>
                      <div
                        style={{
                          marginTop: 3,
                          fontSize: isMobile ? 14 : 13,
                          color: token.colorTextDescription,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {lastPreview(item.client_id) || (serverLanIp || "").trim() || " "}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div
          style={{
            flex: !isMobile ? "1 1 0%" : showChatPanel ? "1 1 0%" : "0 0 0",
            minWidth: 0,
            minHeight: 0,
            display: showChatPanel ? "flex" : "none",
            flexDirection: "column",
            background: chatBg,
            overflow: "hidden",
          }}
        >
          {isMobile && mobileChatOpen && (
            <div
              style={{
                flexShrink: 0,
                flexGrow: 0,
                paddingTop: "max(6px, env(safe-area-inset-top, 0px))",
                background: token.colorBgContainer,
                borderBottom: `1px solid ${WX_CHAT_TOP_BORDER}`,
              }}
            >
              {/** 左右按钮占位宽度不一致时，标题层用对称 padding，避免「群组广播」视觉偏左 */}
              <div
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  minHeight: 44,
                  paddingLeft: 2,
                  paddingRight: 6,
                }}
              >
                <Button
                  type="text"
                  size="large"
                  icon={<ArrowLeftOutlined style={{ fontSize: 18, color: token.colorTextHeading }} />}
                  onClick={() => setMobileChatOpen(false)}
                  aria-label="返回会话列表"
                  style={{ position: "relative", zIndex: 1 }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    paddingLeft: isGroup ? 96 : 52,
                    paddingRight: isGroup ? 96 : 52,
                    pointerEvents: "none",
                    boxSizing: "border-box",
                  }}
                >
                  <Typography.Text
                    strong
                    ellipsis
                    style={{
                      width: "100%",
                      textAlign: "center",
                      fontSize: 17,
                      lineHeight: "22px",
                      color: token.colorTextHeading,
                      margin: 0,
                    }}
                  >
                    {isGroup ? "群组广播" : selectedDevice?.nick || "私聊"}
                  </Typography.Text>
                </div>
                <Space size={0} style={{ flexShrink: 0, position: "relative", zIndex: 1 }}>
                  <Button
                    type="text"
                    size="large"
                    icon={<FolderOpenOutlined style={{ fontSize: 18, color: token.colorTextHeading }} />}
                    onClick={openDrawer}
                    aria-label="全部文件"
                  />
                  {isGroup ? (
                    <Button
                      type="text"
                      size="large"
                      icon={<TeamOutlined style={{ fontSize: 18, color: token.colorTextHeading }} />}
                      onClick={() => setLanUsersModalOpen(true)}
                      aria-label="用户列表"
                    />
                  ) : null}
                </Space>
              </div>
              <div style={{ padding: "0 12px 8px", textAlign: "center" }}>
                {isGroup ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12, color: WX_META, lineHeight: 1.45 }}>
                    在线 {devices.length} 人
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12, color: WX_META, lineHeight: 1.45 }}>
                    {(selectedDevice?.ip || "").trim() || "—"}
                  </Typography.Text>
                )}
              </div>
            </div>
          )}

          {showChatPanel && !(isMobile && mobileChatOpen) && (
            isGroup ? (
              <div
                style={{
                  flexShrink: 0,
                  flexGrow: 0,
                  height: DESKTOP_CHAT_TOPBAR_H,
                  minHeight: DESKTOP_CHAT_TOPBAR_H,
                  maxHeight: DESKTOP_CHAT_TOPBAR_H,
                  boxSizing: "border-box",
                  padding: "0 12px",
                  background: token.colorBgContainer,
                  borderBottom: `1px solid ${borderLine}`,
                  display: "flex",
                  alignItems: "center",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    height: "100%",
                    minHeight: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: 0,
                      bottom: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      paddingRight: 88,
                      pointerEvents: "none",
                      boxSizing: "border-box",
                    }}
                  >
                    <Typography.Text
                      strong
                      ellipsis
                      style={{
                        fontSize: 16,
                        margin: 0,
                        lineHeight: "22px",
                        maxWidth: "100%",
                        textAlign: "center",
                      }}
                    >
                      群组 · 广播给所有人
                    </Typography.Text>
                  </div>
                  <Space size={0} wrap={false} style={{ flexShrink: 0, alignItems: "center", position: "relative", zIndex: 1 }}>
                    <Button
                      type="text"
                      icon={<FolderOpenOutlined style={{ fontSize: 18, color: token.colorTextHeading }} />}
                      onClick={openDrawer}
                      aria-label="全部文件"
                    />
                    <Button
                      type="text"
                      icon={<TeamOutlined style={{ fontSize: 18, color: token.colorTextHeading }} />}
                      onClick={() => setLanUsersModalOpen(true)}
                      aria-label="用户列表"
                    />
                  </Space>
                </div>
              </div>
            ) : (
              <div
                style={{
                  flexShrink: 0,
                  flexGrow: 0,
                  height: DESKTOP_CHAT_TOPBAR_H,
                  minHeight: DESKTOP_CHAT_TOPBAR_H,
                  maxHeight: DESKTOP_CHAT_TOPBAR_H,
                  boxSizing: "border-box",
                  padding: "0 12px",
                  background: token.colorBgContainer,
                  borderBottom: `1px solid ${borderLine}`,
                  display: "flex",
                  alignItems: "center",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    height: "100%",
                    minHeight: 0,
                    maxHeight: DESKTOP_CHAT_TOPBAR_H,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: 0,
                      bottom: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      paddingRight: 48,
                      pointerEvents: "none",
                      boxSizing: "border-box",
                    }}
                  >
                    <Typography.Text
                      strong
                      ellipsis
                      style={{
                        fontSize: 15,
                        margin: 0,
                        lineHeight: "22px",
                        maxWidth: "100%",
                        textAlign: "center",
                      }}
                    >
                      {selectedDevice?.nick || "未知设备"}
                      {!peerOnline ? "（离线）" : ""}
                    </Typography.Text>
                  </div>
                  <Space size={0} wrap={false} style={{ flexShrink: 0, alignItems: "center", position: "relative", zIndex: 1 }}>
                    <Button
                      type="text"
                      icon={<FolderOpenOutlined style={{ fontSize: 18, color: token.colorTextHeading }} />}
                      onClick={openDrawer}
                      aria-label="全部文件"
                    />
                  </Space>
                </div>
              </div>
            )
          )}

          <div
            ref={chatScrollRef}
            className={`lan-scroll-y lan-chat-messages${chatEmpty ? " lan-scroll-y--chat-empty" : ""}`}
            style={{
              background: chatBg,
              ...(chatEmpty
                ? {
                    paddingLeft: isMobile ? 10 : 16,
                    paddingRight: isMobile ? 10 : 16,
                    paddingBottom: inputBarViewportFixed
                      ? inputBarBottomReserve
                      : isMobile
                        ? 28
                        : 36,
                  }
                : {
                    padding: isMobile ? "10px 10px" : "16px 18px",
                    paddingBottom: inputBarViewportFixed
                      ? inputBarBottomReserve
                      : isMobile
                        ? "28px"
                        : "36px",
                  }),
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files?.length) onPickFiles(e.dataTransfer.files);
            }}
          >
            {chatEmpty ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={isGroup ? "在群组里发一条消息，所有人都能看到" : "开始私聊吧"}
                styles={{
                  root: { margin: 0, padding: 0, background: "transparent" },
                  image: { background: "transparent" },
                  description: { color: WX_META, fontSize: 14 },
                }}
              />
            ) : (
              <>{currentRows.map((r) => renderMessageRow(r))}</>
            )}
          </div>

          <div
            style={{
              ...(inputBarViewportFixed
                ? {
                    position: "fixed",
                    bottom: 0,
                    zIndex: 100,
                    left: isMobile ? 0 : 300,
                    right: 0,
                    padding: `8px 10px max(10px, env(safe-area-inset-bottom, 0px))`,
                    paddingLeft: isMobile ? "max(10px, env(safe-area-inset-left, 0px))" : 10,
                    paddingRight: isMobile ? "max(10px, env(safe-area-inset-right, 0px))" : 10,
                    background: WX_CHAT_FOOT_BG,
                    borderTop: `1px solid ${WX_CHAT_FOOT_BORDER}`,
                    boxShadow: "0 -4px 12px rgba(0,0,0,0.08)",
                  }
                : {
                    flexShrink: 0,
                    flexGrow: 0,
                    padding: `8px 10px max(10px, env(safe-area-inset-bottom, 0px))`,
                    background: WX_CHAT_FOOT_BG,
                    borderTop: `1px solid ${WX_CHAT_FOOT_BORDER}`,
                    ...(isMobile ? { zIndex: 5 } : {}),
                  }),
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                maxWidth: "100%",
              }}
            >
              <Button
                type="default"
                shape="circle"
                loading={uploading}
                icon={<PaperClipOutlined style={{ fontSize: isMobile ? 18 : 16, color: token.colorTextSecondary }} />}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  flexShrink: 0,
                  color: token.colorTextSecondary,
                  borderColor: WX_CHAT_TOP_BORDER,
                  background: "#ffffff",
                }}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  onPickFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  background: "#ffffff",
                  borderRadius: 6,
                  border: `1px solid ${WX_CHAT_TOP_BORDER}`,
                  padding: "4px 10px",
                }}
              >
                <Input.TextArea
                  autoSize={{ minRows: 1, maxRows: isMobile ? 6 : 8 }}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPressEnter={(e) => {
                    if (!e.shiftKey) {
                      e.preventDefault();
                      sendText();
                    }
                  }}
                  placeholder={isGroup ? "群发消息给所有人…" : "私聊消息…"}
                  variant="borderless"
                  style={{
                    width: "100%",
                    resize: "none",
                    padding: "4px 0",
                    fontSize: isMobile ? 16 : 14,
                    lineHeight: 1.5,
                    minHeight: 24,
                  }}
                />
              </div>
              <Button
                type="text"
                onClick={() => {
                  if (input.trim()) sendText();
                }}
                style={{
                  flexShrink: 0,
                  padding: "0 6px",
                  height: "auto",
                  fontSize: isMobile ? 17 : 15,
                  fontWeight: 600,
                  color: input.trim() ? WX_SEND_ACTIVE : "#b2b2b2",
                  cursor: input.trim() ? "pointer" : "default",
                }}
              >
                发送
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Modal
        title="设置昵称"
        open={nickModalOpen}
        onOk={applyNickFromModal}
        okText="保存"
        cancelText="取消"
        onCancel={() => setNickModalOpen(false)}
        destroyOnClose
        {...DIALOG_TITLE_CENTER}
      >
        <Typography.Text type="secondary" style={{ display: "block", marginBottom: 12, fontSize: 13 }}>
          昵称请勿与局域网内其他设备重复。
        </Typography.Text>
        <Input
          placeholder={suggestedNick || "请输入昵称"}
          maxLength={32}
          value={nickDraft}
          onChange={(e) => setNickDraft(e.target.value)}
        />
      </Modal>

      <Modal
        title="局域网用户"
        open={lanUsersModalOpen}
        onCancel={() => setLanUsersModalOpen(false)}
        footer={
          <Button type="primary" onClick={() => setLanUsersModalOpen(false)}>
            关闭
          </Button>
        }
        width={Math.min(440, typeof window !== "undefined" ? window.innerWidth - 48 : 400)}
        destroyOnClose={false}
        {...DIALOG_TITLE_CENTER}
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 10, fontSize: 12 }}>
          绿点表示当前在线，灰点表示不在线（含仅有私聊记录、当前未连接的设备）。
        </Typography.Paragraph>
        {(serverLanIp || "").trim() ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 10, fontSize: 12 }}>
            <Typography.Text strong>服务地址：</Typography.Text>
            {(serverLanIp || "").trim()}
          </Typography.Paragraph>
        ) : null}
        <div className="lan-modal-user-scroll">
          {desktopLanUsersList.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无用户" />
          ) : (
            desktopLanUsersList.map((u, idx) => (
              <div
                key={u.client_id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 4px 10px 0",
                  borderBottom: idx < desktopLanUsersList.length - 1 ? `1px solid ${token.colorSplit}` : "none",
                }}
              >
                <WsStatusDot connected={u.online} size={7} style={{ marginTop: 5, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Typography.Text strong ellipsis style={{ display: "block" }}>
                    {u.nick}
                    {u.client_id === clientId ? "（我）" : ""}
                  </Typography.Text>
                  {u.ip || u.mac ? (
                    <Typography.Text
                      type="secondary"
                      ellipsis
                      style={{ display: "block", marginTop: 4, fontSize: 12, lineHeight: 1.45 }}
                    >
                      {u.ip ? `${u.ip}${u.mac ? ` · ${u.mac}` : ""}` : u.mac || ""}
                    </Typography.Text>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </Modal>

      <Modal
        title={mediaPreview?.name || "预览"}
        open={!!mediaPreview}
        onCancel={() => setMediaPreview(null)}
        width={Math.min(900, typeof window !== "undefined" ? window.innerWidth - 32 : 860)}
        centered
        destroyOnClose
        {...DIALOG_TITLE_CENTER}
        footer={
          <Space>
            <Button
              type="primary"
              onClick={() => {
                if (!mediaPreview) return;
                const a = document.createElement("a");
                a.href = fileDownloadUrl(mediaPreview.stored);
                a.setAttribute("download", mediaPreview.name || "");
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }}
            >
              下载
            </Button>
            <Button onClick={() => setMediaPreview(null)}>关闭</Button>
          </Space>
        }
      >
        {mediaPreview?.kind === "image" && (
          <img
            src={fileInlineUrl(mediaPreview.stored)}
            alt=""
            style={{
              maxWidth: "100%",
              maxHeight: "72vh",
              display: "block",
              margin: "0 auto",
              objectFit: "contain",
            }}
          />
        )}
        {mediaPreview?.kind === "video" && (
          <video
            key={mediaPreview.stored}
            src={fileInlineUrl(mediaPreview.stored)}
            controls
            playsInline
            style={{ width: "100%", maxHeight: "72vh", display: "block", margin: "0 auto" }}
          />
        )}
        {mediaPreview?.kind === "file" && (
          <div style={{ textAlign: "center", padding: "12px 0 8px" }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              此类型无法在浏览器内预览，请下载后查看。
            </Typography.Paragraph>
            <Typography.Text type="secondary">大小：{fmtSize(mediaPreview.size ?? 0)}</Typography.Text>
          </div>
        )}
      </Modal>

      <Modal
        title="发现新版本"
        open={updateModalOpen}
        onCancel={() => setUpdateModalOpen(false)}
        destroyOnClose
        footer={
          <Space>
            <Button onClick={() => setUpdateModalOpen(false)}>稍后提醒</Button>
            <Button
              type="primary"
              icon={<CloudDownloadOutlined />}
              onClick={() => {
                const u = updateInfo?.download_url || updateInfo?.release_url;
                if (u) window.open(u, "_blank", "noopener,noreferrer");
                setUpdateModalOpen(false);
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
              检测到有新版本发布，请前往下载页面获取安装包。
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

      <Modal
        title="用户信息"
        open={!!userInfoModal}
        onCancel={() => setUserInfoModal(null)}
        footer={<Button onClick={() => setUserInfoModal(null)}>关闭</Button>}
        destroyOnClose
        width={Math.min(USER_INFO_MODAL_WIDTH, typeof window !== "undefined" ? window.innerWidth - 32 : USER_INFO_MODAL_WIDTH)}
        {...DIALOG_TITLE_CENTER}
      >
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          <Typography.Text strong>昵称：</Typography.Text>
          {userProfileNick}
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          <Typography.Text strong>IP 地址：</Typography.Text>
          {userProfileIp}
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 0, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          <Typography.Text strong>在线状态：</Typography.Text>
          <WsStatusDot connected={userProfileOnline} size={7} />
          <Typography.Text>{userProfileStatusText}</Typography.Text>
        </Typography.Paragraph>
      </Modal>

      <Drawer
        title="当前会话文件"
        placement="right"
        width={Math.min(440, typeof window !== "undefined" ? window.innerWidth - 24 : 400)}
        onClose={() => setFileDrawer(false)}
        open={fileDrawer}
        {...DIALOG_TITLE_CENTER}
        extra={
          <Button size="small" onClick={loadFiles}>
            刷新
          </Button>
        }
      >
        <Table
          size="small"
          rowKey="stored_name"
          loading={filesLoading}
          dataSource={files}
          columns={fileColumns}
          pagination={{ pageSize: 8 }}
        />
      </Drawer>
    </div>
  );
}
