import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { useFonts } from 'expo-font';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  Keyboard,
  Linking,
  Modal,
  NativeModules,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';
import {
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';

type ServerDoc = {
  id: string;
  caption: string;
  categories: string[];
  text: string;
  createdAt: number;
  uri?: string;
  score?: number;
  mediaType?: string;
};

type CategorySummary = { name: string; count: number; updatedAt: number };

type ChatEntry = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  sources?: ServerDoc[];
};

type ChatThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatEntry[]; // newest-first (same order as chatHistory)
};

type RouteKey = 'chat' | 'import' | 'categories';

type ResolvedAsset = {
  id: string;
  uri: string;
  createdAt: number;
  filename?: string | null;
  mediaType: MediaLibrary.MediaTypeValue;
  asset: MediaLibrary.Asset;
};

const inferDevServerHost = () => {
  const scriptURL: string | undefined = (NativeModules as any)?.SourceCode?.scriptURL;
  if (!scriptURL) return null;
  try {
    const url = new URL(scriptURL);
    if (url.hostname) return url.hostname;
  } catch {
    // ignore
  }
  const match = scriptURL.match(/^(?:https?|exp|exps):\/\/([^/:]+)(?::\d+)?\//);
  return match?.[1] ?? null;
};

const resolveApiBase = (configured: string) => {
  const trimmed = configured.trim();
  if (!trimmed) return 'http://localhost:4000';
  if (trimmed.includes('localhost') || trimmed.includes('127.0.0.1')) {
    const host = inferDevServerHost();
    if (host) return `http://${host}:4000`;
  }
  return trimmed;
};

const DEFAULT_API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
const API_BASE_STORAGE_KEY = 'nexus.apiBase';
const USER_ID_STORAGE_KEY = 'nexus.userId';
const THREADS_STORAGE_KEY_PREFIX = 'nexus.threads.';
const ACTIVE_THREAD_STORAGE_KEY_PREFIX = 'nexus.thread.active.';
const TUTORIAL_SEEN_STORAGE_KEY = 'nexus.tutorialSeen.v1';

const COLORS = {
  bg: '#ffffff',
  surface: '#ffffff',
  surfaceAlt: '#f8fafc',
  pill: '#f1f5f9',
  text: '#0f172a',
  muted: '#64748b',
  muted2: '#94a3b8',
  border: 'rgba(15, 23, 42, 0.12)',
  borderStrong: 'rgba(15, 23, 42, 0.18)',
  overlay: 'rgba(15, 23, 42, 0.04)',
  overlayStrong: 'rgba(15, 23, 42, 0.08)',
  shadow: 'rgba(15, 23, 42, 0.10)',
  accent: '#111827',
  accentText: '#ffffff',
  danger: '#b91c1c',
  dangerSoft: 'rgba(185, 28, 28, 0.08)',
} as const;

const FONT_SANS = 'Inter_400Regular';
const FONT_SANS_MEDIUM = 'Inter_500Medium';
const FONT_SANS_SEMIBOLD = 'Inter_600SemiBold';
const FONT_SANS_BOLD = 'Inter_700Bold';
const FONT_SANS_EXTRABOLD = 'Inter_800ExtraBold';
const FONT_HEADING_SEMIBOLD = 'PlusJakartaSans_600SemiBold';
const FONT_HEADING_BOLD = 'PlusJakartaSans_700Bold';
const FONT_HEADING_EXTRABOLD = 'PlusJakartaSans_800ExtraBold';

const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const MARKDOWN_STYLES = {
  body: {
    color: COLORS.text,
    fontSize: 14,
    lineHeight: 19,
    fontFamily: FONT_SANS,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 10,
  },
  strong: {
    fontFamily: FONT_SANS_BOLD,
  },
  em: {
    fontStyle: 'italic',
  },
  bullet_list: {
    marginVertical: 0,
  },
  ordered_list: {
    marginVertical: 0,
  },
  list_item: {
    marginBottom: 4,
  },
  bullet_list_icon: {
    color: COLORS.text,
  },
  code_inline: {
    fontFamily: MONO_FONT,
    backgroundColor: 'rgba(15, 23, 42, 0.06)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  fence: {
    fontFamily: MONO_FONT,
    backgroundColor: 'rgba(15, 23, 42, 0.06)',
    padding: 10,
    borderRadius: 12,
  },
} as const;

const randomId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const resolveDocUri = (apiBase: string, doc: ServerDoc) => {
  if (!doc.uri) return null;
  if (doc.uri.startsWith('http')) return doc.uri;
  return `${apiBase}${doc.uri}`;
};

const toWsUrl = (base: string) => {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const getAccessPrivileges = (p: MediaLibrary.PermissionResponse | null) =>
  (p as any)?.accessPrivileges as 'all' | 'limited' | 'none' | undefined;
const hasMediaLibraryReadAccess = (p: MediaLibrary.PermissionResponse | null) =>
  !!p && p.status === 'granted' && getAccessPrivileges(p) !== 'none';
const hasMediaLibraryAllAccess = (p: MediaLibrary.PermissionResponse | null) =>
  hasMediaLibraryReadAccess(p) && (getAccessPrivileges(p) ?? 'all') === 'all';

const ensureAssetUri = async (asset: MediaLibrary.Asset) => {
  const info = await MediaLibrary.getAssetInfoAsync(asset);
  const legacyLocalUri = (asset as any).localUri as string | undefined;
  return info.localUri ?? legacyLocalUri ?? asset.uri;
};

const ensureUploadUri = async (item: ResolvedAsset) => {
  const info = await MediaLibrary.getAssetInfoAsync(item.asset);
  const legacyLocalUri = (item.asset as any).localUri as string | undefined;
  const candidate = info.localUri ?? legacyLocalUri ?? item.uri ?? info.uri ?? item.asset.uri;
  if (candidate?.startsWith('file://')) return candidate;

  // Best effort: copy to cache. (Some URI schemes like `ph://` may not be readable by FileSystem.)
  try {
    const base = FileSystem.Paths.cache.uri;
    if (base) {
      const cacheDir = `${base}nexus_uploads`;
      await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true }).catch(() => {});
      const filename =
        info.filename ||
        item.filename ||
        `${item.id}${item.mediaType === MediaLibrary.MediaType.video ? '.mp4' : '.jpg'}`;
      const safeName = filename.replace(/[^\w.\-]/g, '_').slice(-80);
      const dest = `${cacheDir}/${item.id}-${safeName}`;
      if (candidate) {
        await FileSystem.copyAsync({ from: candidate, to: dest });
        return dest;
      }
    }
  } catch {
    // ignore; fall through to error
  }

  throw new Error(
    "This photo isn't available as a local file on the device. If it's in iCloud, open it in Photos to download it, then try again.",
  );
};

const apiFetch = async <T,>(apiBase: string, userId: string, path: string, init?: RequestInit): Promise<T> => {
  let res: Response;
  try {
    const headers = new Headers(init?.headers ?? {});
    if (userId) headers.set('x-nexus-user-id', userId);
    res = await fetch(`${apiBase}${path}`, { ...init, headers });
  } catch (err: any) {
    const detail = String(err?.message ?? err ?? '');
    throw new Error(`Network request failed (API: ${apiBase}).\n${detail}`.trim());
  }
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
};

const threadsKey = (userId: string) => `${THREADS_STORAGE_KEY_PREFIX}${userId}`;
const activeThreadKey = (userId: string) => `${ACTIVE_THREAD_STORAGE_KEY_PREFIX}${userId}`;

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });

  const [bootSplashVisible, setBootSplashVisible] = useState(true);
  const bootOpacity = useRef(new Animated.Value(1)).current;

  const [apiBase, setApiBase] = useState(() => resolveApiBase(DEFAULT_API_BASE));
  const [apiModalOpen, setApiModalOpen] = useState(false);
  const [apiDraft, setApiDraft] = useState('');
  const apiInputRef = useRef<TextInput | null>(null);
  const [userId, setUserId] = useState('');
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const tutorialCheckedRef = useRef(false);

  const { width, height: windowHeight } = useWindowDimensions();
  const isWide = width >= 860;

  const [route, setRoute] = useState<RouteKey>('chat');
  const [menuOpen, setMenuOpen] = useState(false);

  const [permission, setPermission] = useState<MediaLibrary.PermissionResponse | null>(null);
  const [loadingScreenshots, setLoadingScreenshots] = useState(false);
  const [screenshots, setScreenshots] = useState<ResolvedAsset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assetStageById, setAssetStageById] = useState<Record<string, 'uploading' | 'indexing' | 'done' | 'error'>>(
    {},
  );
  const importQueueRef = useRef<ResolvedAsset[]>([]);
  const importRunningRef = useRef(false);
  const importSessionRef = useRef<{ total: number; done: number; failed: number } | null>(null);
  const [importProgress, setImportProgress] = useState<{
    running: boolean;
    current: number;
    total: number;
    done: number;
    failed: number;
  }>({ running: false, current: 0, total: 0, done: 0, failed: 0 });

  const [docs, setDocs] = useState<ServerDoc[]>([]);
  const [uiError, setUiError] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState('');
  const [chatThinking, setChatThinking] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const threadsRef = useRef<ChatThread[]>([]);
  const activeThreadIdRef = useRef('');

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [viewerNatural, setViewerNatural] = useState<{ w: number; h: number } | null>(null);
  const viewerPanY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  const closeViewer = useCallback(() => setViewerUri(null), []);

  useEffect(() => {
    viewerPanY.setValue(0);
    setViewerNatural(null);
  }, [viewerPanY, viewerUri]);

  const dismissViewer = useCallback(() => {
    Animated.timing(viewerPanY, {
      toValue: windowHeight,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      viewerPanY.setValue(0);
      closeViewer();
    });
  }, [closeViewer, viewerPanY, windowHeight]);

  const viewerPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_evt, g) => Math.abs(g.dy) > 6 || Math.abs(g.dx) > 6,
        onPanResponderMove: (_evt, g) => {
          if (g.dy < 0) return;
          viewerPanY.setValue(g.dy);
        },
        onPanResponderRelease: (_evt, g) => {
          const isTap = Math.abs(g.dx) < 6 && Math.abs(g.dy) < 6;
          if (isTap) return dismissViewer();
          const shouldDismiss = g.dy > 120 || g.vy > 0.9;
          if (shouldDismiss) return dismissViewer();
          Animated.spring(viewerPanY, { toValue: 0, useNativeDriver: true }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(viewerPanY, { toValue: 0, useNativeDriver: true }).start();
        },
      }),
    [dismissViewer, viewerPanY],
  );

  const viewerCardDims = useMemo(() => {
    const maxW = Math.max(220, Math.min(width - 32, Math.round(width * 0.92)));
    const maxH = Math.max(260, Math.min(windowHeight - 180, Math.round(windowHeight * 0.72)));
    const w0 = Math.max(1, viewerNatural?.w ?? maxW);
    const h0 = Math.max(1, viewerNatural?.h ?? maxH);
    const scale = Math.min(maxW / w0, maxH / h0, 1);
    return { w: Math.round(w0 * scale), h: Math.round(h0 * scale) };
  }, [viewerNatural, width, windowHeight]);

  useEffect(() => {
    MediaLibrary.getPermissionsAsync(false).then((p) => setPermission(p));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = (await AsyncStorage.getItem(USER_ID_STORAGE_KEY))?.trim();
        if (existing) {
          if (!cancelled) setUserId(existing);
          return;
        }
        const next = `anon_${randomId()}`;
        await AsyncStorage.setItem(USER_ID_STORAGE_KEY, next);
        if (!cancelled) setUserId(next);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const rawThreads = await AsyncStorage.getItem(threadsKey(userId));
        const parsed = rawThreads ? (JSON.parse(rawThreads) as ChatThread[]) : [];
        const safeThreads = Array.isArray(parsed)
          ? parsed
              .filter((t) => t && typeof (t as any).id === 'string')
              .map((t) => ({
                id: String((t as any).id),
                title: String((t as any).title ?? 'New chat'),
                createdAt: Number((t as any).createdAt ?? Date.now()),
                updatedAt: Number((t as any).updatedAt ?? Date.now()),
                messages: Array.isArray((t as any).messages) ? ((t as any).messages as ChatEntry[]) : [],
              }))
          : [];

        const activeStored = (await AsyncStorage.getItem(activeThreadKey(userId)))?.trim() ?? '';
        let nextActive = activeStored && safeThreads.some((t) => t.id === activeStored) ? activeStored : '';

        let nextThreads = safeThreads;
        if (!nextThreads.length) {
          const now = Date.now();
          const id = randomId();
          nextThreads = [{ id, title: 'New chat', createdAt: now, updatedAt: now, messages: [] }];
          nextActive = id;
          await AsyncStorage.setItem(threadsKey(userId), JSON.stringify(nextThreads));
          await AsyncStorage.setItem(activeThreadKey(userId), nextActive);
        } else if (!nextActive) {
          nextActive = nextThreads.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? nextThreads[0]!.id;
          await AsyncStorage.setItem(activeThreadKey(userId), nextActive);
        }

        if (cancelled) return;
        setThreads(nextThreads);
        setActiveThreadId(nextActive);
        const active = nextThreads.find((t) => t.id === nextActive);
        setChatHistory(active?.messages ?? []);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const persistThreads = async (nextThreads: ChatThread[], nextActiveId: string) => {
    if (!userId) return;
    try {
      await AsyncStorage.setItem(threadsKey(userId), JSON.stringify(nextThreads));
      await AsyncStorage.setItem(activeThreadKey(userId), nextActiveId);
    } catch {
      // ignore
    }
  };

  const selectThread = async (threadId: string) => {
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    setActiveThreadId(threadId);
    setChatHistory(thread.messages ?? []);
    await persistThreads(threads, threadId);
  };

  const createThread = async () => {
    const now = Date.now();
    const id = randomId();
    const next: ChatThread = { id, title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
    const nextThreads = [next, ...threads];
    setThreads(nextThreads);
    setActiveThreadId(id);
    setChatHistory([]);
    await persistThreads(nextThreads, id);
  };

  const handleCreateThread = async () => {
    try {
      Keyboard.dismiss();
    } catch {
      // ignore
    }
    await createThread();
  };

  const deleteThreadById = async (threadId: string) => {
    const nextThreads = threads.filter((t) => t.id !== threadId);
    const nextActive =
      threadId === activeThreadId
        ? nextThreads.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? ''
        : activeThreadId;

    if (!nextThreads.length) {
      const now = Date.now();
      const id = randomId();
      const fresh: ChatThread = { id, title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
      setThreads([fresh]);
      setActiveThreadId(id);
      setChatHistory([]);
      await persistThreads([fresh], id);
      return;
    }

    setThreads(nextThreads);
    setActiveThreadId(nextActive);
    const active = nextThreads.find((t) => t.id === nextActive);
    setChatHistory(active?.messages ?? []);
    await persistThreads(nextThreads, nextActive);
  };

  const renameThreadById = async (threadId: string, nextTitle: string) => {
    const title = nextTitle.trim();
    if (!title) return;
    const now = Date.now();
    const current = threadsRef.current;
    const exists = current.some((t) => t.id === threadId);
    if (!exists) return;
    const nextThreads = current.map((t) => (t.id === threadId ? { ...t, title, updatedAt: now } : t));
    threadsRef.current = nextThreads;
    setThreads(nextThreads);
    const snapId = activeThreadIdRef.current || activeThreadId;
    await persistThreads(nextThreads, snapId);
  };

  useEffect(() => {
    if (route === 'categories' && userId) refreshDocs();
    if (route !== 'categories') setActiveCategory(null);
  }, [route, userId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(API_BASE_STORAGE_KEY);
        const resolved = resolveApiBase(stored || DEFAULT_API_BASE);
        if (!cancelled) setApiBase(resolved);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openApiModal = () => {
    setApiDraft(apiBase);
    setApiModalOpen(true);
  };

  useEffect(() => {
    if (!apiModalOpen) return;
    const t = setTimeout(() => apiInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [apiModalOpen]);

  const saveApiBase = async () => {
    const next = apiDraft.trim().replace(/\/+$/, '');
    if (!next) return;
    setApiBase(next);
    await AsyncStorage.setItem(API_BASE_STORAGE_KEY, next);
    setApiModalOpen(false);
  };

  const refreshDocs = async () => {
    try {
      if (!userId) return;
      const data = await apiFetch<{ docs: ServerDoc[] }>(apiBase, userId, '/api/docs');
      setDocs(data.docs ?? []);
    } catch (err: any) {
      setUiError(err?.message ?? 'Failed to load stored documents');
    }
  };

  useEffect(() => {
    if (!userId) return;
    refreshDocs();
  }, [apiBase, userId]);

  useEffect(() => {
    if (!fontsLoaded) return;
    if (!userId) return;
    if (tutorialCheckedRef.current) return;
    tutorialCheckedRef.current = true;
    (async () => {
      try {
        const seen = (await AsyncStorage.getItem(TUTORIAL_SEEN_STORAGE_KEY)) === '1';
        if (!seen) setTutorialOpen(true);
      } catch {
        setTutorialOpen(true);
      }
    })();
  }, [fontsLoaded, userId]);

  const dismissTutorial = useCallback(async () => {
    setTutorialOpen(false);
    try {
      await AsyncStorage.setItem(TUTORIAL_SEEN_STORAGE_KEY, '1');
    } catch {
      // ignore
    }
  }, []);

  const goToImportFromTutorial = useCallback(async () => {
    setRoute('import');
    await dismissTutorial();
  }, [dismissTutorial]);

  const handleRequestAccess = async () => {
    const response = await MediaLibrary.requestPermissionsAsync(false);
    setPermission(response);
    return hasMediaLibraryReadAccess(response);
  };

  const loadScreenshots = async () => {
    if (loadingScreenshots) return;
    setLoadingScreenshots(true);
    setUiError(null);
    try {
      let currentPermission = permission ?? (await MediaLibrary.getPermissionsAsync(false));
      if (currentPermission.status !== 'granted' || getAccessPrivileges(currentPermission) === 'none') {
        const hasAccess = await handleRequestAccess();
        if (!hasAccess) return;
        currentPermission = (await MediaLibrary.getPermissionsAsync(false)) ?? currentPermission;
      }

      if (!hasMediaLibraryReadAccess(currentPermission)) {
        Alert.alert(
          'Photo access required',
          'Please allow Photos access to import screenshots.',
          [{ text: 'OK' }],
        );
        return;
      }

      let album: MediaLibrary.Album | null = null;
      if (hasMediaLibraryAllAccess(currentPermission)) {
        try {
          album = await MediaLibrary.getAlbumAsync('Screenshots');
        } catch {
          album = null;
        }
      } else {
        Alert.alert(
          'Limited Photos access',
          'Your Photos access is limited, so Nexus will show your allowed photos instead of the Screenshots album. To import all screenshots, enable Full Access in iOS Settings.',
          [
            { text: 'OK' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
      }

      const result = await MediaLibrary.getAssetsAsync({
        ...(album ? { album } : {}),
        first: 60,
        sortBy: [MediaLibrary.SortBy.creationTime],
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      });

      const resolved = await Promise.all(
        result.assets.map(async (asset) => {
          const info = await MediaLibrary.getAssetInfoAsync(asset);
          const legacyLocalUri = (asset as any).localUri as string | undefined;
          return {
            id: asset.id,
            uri: info.localUri ?? legacyLocalUri ?? asset.uri,
            createdAt: asset.creationTime ?? Date.now(),
            filename: info.filename ?? null,
            mediaType: asset.mediaType,
            asset,
          } satisfies ResolvedAsset;
        }),
      );
      setScreenshots(resolved);
      setSelected(new Set());
      setAssetStageById({});
    } catch (err: any) {
      setUiError(err?.message ?? 'Failed to load screenshots');
    } finally {
      setLoadingScreenshots(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const uploadAssetToServer = async (item: ResolvedAsset) => {
    if (!userId) throw new Error('Missing user id');
    const uri = await ensureUploadUri(item);

    const form = new FormData();
    form.append('file', {
      uri,
      name: item.filename || `${item.id}.jpg`,
      type: item.mediaType === MediaLibrary.MediaType.video ? 'video/mp4' : 'image/jpeg',
    } as any);
    form.append('createdAt', String(item.createdAt ?? Date.now()));

    let res: Response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3 * 60 * 1000);
      res = await fetch(`${apiBase}/api/upload`, {
        method: 'POST',
        headers: { 'x-nexus-user-id': userId },
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch (err: any) {
      const detail = String(err?.message ?? err ?? '');
      throw new Error(`Network request failed (API: ${apiBase}). Make sure the server is reachable from your phone.\n${detail}`.trim());
    }
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(detail || 'Upload failed');
    }
    const json = await res.json();
    return json.doc as ServerDoc;
  };

  const startImportRunnerIfNeeded = () => {
    if (importRunningRef.current) return;
    importRunningRef.current = true;

    void (async () => {
      try {
        if (!importSessionRef.current) {
          importSessionRef.current = { total: importQueueRef.current.length, done: 0, failed: 0 };
        }

        while (importQueueRef.current.length) {
          const session = importSessionRef.current!;
          const nextIndex = session.done + session.failed + 1;
          const item = importQueueRef.current.shift()!;

          setImportProgress({ running: true, current: nextIndex, total: session.total, done: session.done, failed: session.failed });
          setAssetStageById((prev) => ({ ...prev, [item.id]: 'uploading' }));

          try {
            const uploaded = await uploadAssetToServer(item);
            setAssetStageById((prev) => ({ ...prev, [item.id]: 'done' }));
            session.done += 1;
            setDocs((prev) => [uploaded, ...prev]);
          } catch (err: any) {
            const message = err?.message ?? 'Upload failed';
            setAssetStageById((prev) => ({ ...prev, [item.id]: 'error' }));
            session.failed += 1;
            if (typeof message === 'string' && /network request failed|can[’']?t reach|timed out|AbortError/i.test(message)) {
              setUiError((prev) => prev ?? message);
            }
          }
        }
      } finally {
        importRunningRef.current = false;
        const session = importSessionRef.current;
        if (!session) {
          setImportProgress({ running: false, current: 0, total: 0, done: 0, failed: 0 });
          return;
        }

        if (importQueueRef.current.length === 0) {
          setImportProgress({ running: false, current: 0, total: session.total, done: session.done, failed: session.failed });
          importSessionRef.current = null;
        } else {
          // Paused due to network error; keep session state for resume.
          setImportProgress({ running: false, current: 0, total: session.total, done: session.done, failed: session.failed });
        }
      }
    })();
  };

  const enqueueImport = (items: ResolvedAsset[]) => {
    if (!items.length) return;
    if (!importSessionRef.current) {
      importSessionRef.current = { total: 0, done: 0, failed: 0 };
      setImportProgress({ running: false, current: 0, total: 0, done: 0, failed: 0 });
    }

    const session = importSessionRef.current!;
    const existing = new Set(importQueueRef.current.map((i) => i.id));
    const deduped = items.filter((i) => !existing.has(i.id));
    if (!deduped.length) return;

    importQueueRef.current.push(...deduped);
    session.total += deduped.length;
    setImportProgress((prev) => ({ ...prev, total: session.total, done: session.done, failed: session.failed }));
    startImportRunnerIfNeeded();
  };

  const handleSendToAI = async () => {
    if (!selected.size) return;
    if (!userId) {
      Alert.alert('Just a sec', 'Finishing setup… please try again.');
      return;
    }
    setUiError(null);
    const targets = screenshots.filter((s) => selected.has(s.id));
    enqueueImport(targets);
    setSelected(new Set());
  };

  const handleAsk = async () => {
    if (!chatInput.trim() || chatThinking) return;
    if (!userId) {
      Alert.alert('Just a sec', 'Finishing setup… please try again.');
      return;
    }
    const prompt = chatInput.trim();
    setChatInput('');
    setChatThinking(true);
    setUiError(null);

    const userEntry: ChatEntry = { id: randomId(), role: 'user', text: prompt };
    const assistantId = randomId();
    const threadId = activeThreadIdRef.current || activeThreadId || randomId();
    if (!activeThreadIdRef.current) {
      activeThreadIdRef.current = threadId;
      setActiveThreadId(threadId);
    }

    const assistantStub: ChatEntry = { id: assistantId, role: 'assistant', text: '', streaming: true };
    setChatHistory((prev) => [assistantStub, userEntry, ...prev]);
    setThreads((prev) => {
      const now = Date.now();
      const idx = prev.findIndex((t) => t.id === threadId);
      const titleGuess = prompt.split(/\s+/).slice(0, 8).join(' ').slice(0, 42) || 'New chat';
      if (idx === -1) {
        const thread: ChatThread = {
          id: threadId,
          title: titleGuess,
          createdAt: now,
          updatedAt: now,
          messages: [assistantStub, userEntry],
        };
        return [thread, ...prev];
      }
      const current = prev[idx]!;
      const title =
        current.title && current.title !== 'New chat' ? current.title : current.messages.length ? current.title : titleGuess;
      const updated: ChatThread = {
        ...current,
        title,
        updatedAt: now,
        messages: [assistantStub, userEntry, ...(current.messages ?? [])],
      };
      const next = prev.slice();
      next[idx] = updated;
      return next;
    });

    const updateAssistant = (text: string) => {
      setChatHistory((prev) => {
        const existing = prev.find((e) => e.id === assistantId);
        if (existing) return prev.map((e) => (e.id === assistantId ? { ...e, text } : e));
        return [{ id: assistantId, role: 'assistant', text, streaming: true }, ...prev];
      });
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId
            ? { ...t, updatedAt: Date.now(), messages: (t.messages ?? []).map((m) => (m.id === assistantId ? { ...m, text } : m)) }
            : t,
        ),
      );
    };

    const setAssistantStreaming = (streaming: boolean) => {
      setChatHistory((prev) => prev.map((e) => (e.id === assistantId ? { ...e, streaming } : e)));
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId
            ? {
                ...t,
                updatedAt: Date.now(),
                messages: (t.messages ?? []).map((m) => (m.id === assistantId ? { ...m, streaming } : m)),
              }
            : t,
        ),
      );
    };

    const setAssistantSources = (sources: ServerDoc[]) => {
      setChatHistory((prev) => prev.map((e) => (e.id === assistantId ? { ...e, sources } : e)));
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId
            ? { ...t, updatedAt: Date.now(), messages: (t.messages ?? []).map((m) => (m.id === assistantId ? { ...m, sources } : m)) }
            : t,
        ),
      );
    };

    let assistantText = '';
    let doneReceived = false;
    let finished = false;
    let flushScheduled = false;

    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      requestAnimationFrame(() => {
        flushScheduled = false;
        updateAssistant(assistantText);
      });
    };

    const finishOnce = (fn: () => void) => {
      if (finished) return;
      finished = true;
      fn();
    };

    try {
      wsRef.current?.close();
      const ws = new WebSocket(toWsUrl(apiBase));
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'search', query: prompt, userId }));
        };

	        ws.onmessage = (evt) => {
	          let parsed: any;
	          try {
	            parsed = JSON.parse(String(evt.data));
	          } catch {
	            return;
	          }

	          if (parsed.type === 'matches') {
	            const matches = Array.isArray(parsed.matches) ? (parsed.matches as ServerDoc[]) : [];
	            if (matches.length) setAssistantSources(matches.slice(0, 8));
	            return;
	          }

          if (parsed.type === 'info') {
            const msg = String(parsed.message ?? '').trim();
            if (msg) {
              assistantText += (assistantText ? '\n' : '') + msg;
              scheduleFlush();
            }
            return;
          }

	          if (parsed.type === 'chunk') {
	            assistantText += parsed.text ?? '';
	            scheduleFlush();
	          } else if (parsed.type === 'done') {
	            doneReceived = true;
            scheduleFlush();
            finishOnce(() => {
              setAssistantStreaming(false);
              try {
                ws.close();
              } finally {
                resolve();
              }
            });
          } else if (parsed.type === 'error') {
            finishOnce(() => {
              setAssistantStreaming(false);
              try {
                ws.close();
              } finally {
                reject(new Error(parsed.message ?? 'Stream error'));
              }
            });
          }
        };

        ws.onerror = () => finishOnce(() => reject(new Error('WebSocket error')));
        ws.onclose = () => {
          if (finished) return;
          if (doneReceived) finishOnce(() => resolve());
          else finishOnce(() => reject(new Error('WebSocket closed')));
        };
      });
    } catch (err: any) {
      const message = err?.message ?? 'Failed to run RAG search';
      setUiError(message);
      Alert.alert('Chat error', message);
      setAssistantStreaming(false);
	    } finally {
	      setChatThinking(false);
	      if (!assistantText) {
	        assistantText = 'No response (nothing indexed yet?). Go to Import and index screenshots first.';
	        scheduleFlush();
	        setAssistantStreaming(false);
	      }
	      const snapId = activeThreadIdRef.current || threadId;
	      void persistThreads(threadsRef.current, snapId);
	      setTimeout(() => void persistThreads(threadsRef.current, snapId), 250);
	    }
	  };

  const categories = useMemo((): CategorySummary[] => {
    const map: Record<string, { count: number; updatedAt: number }> = {};
    for (const doc of docs) {
      for (const c of doc.categories ?? []) {
        const key = c.trim().toLowerCase();
        if (!key) continue;
        const entry = map[key] ?? { count: 0, updatedAt: 0 };
        entry.count += 1;
        entry.updatedAt = Math.max(entry.updatedAt, Number(doc.createdAt ?? 0) || 0);
        map[key] = entry;
      }
    }
    return Object.entries(map).map(([name, v]) => ({ name, count: v.count, updatedAt: v.updatedAt }));
  }, [docs]);

  const docsInActiveCategory = useMemo(() => {
    if (!activeCategory) return [];
    const target = activeCategory.toLowerCase();
    return docs.filter((doc) => doc.categories.some((c) => c.trim().toLowerCase() === target));
  }, [docs, activeCategory]);

  const deleteDoc = async (docId: string) => {
    if (!userId) return;
    await apiFetch<{ ok: boolean }>(apiBase, userId, `/api/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' });
    setDocs((prev) => prev.filter((d) => d.id !== docId));
  };

  const deleteCategory = async (name: string, mode: 'unlink' | 'purge' | 'unlink-delete-orphans') => {
    if (!userId) return;
    await apiFetch<{ ok: boolean }>(
      apiBase,
      userId,
      `/api/categories/${encodeURIComponent(name)}?mode=${encodeURIComponent(mode)}`,
      { method: 'DELETE' },
    );
    setActiveCategory(null);
    refreshDocs();
  };

  const headerTitle = route === 'chat' ? 'Chat' : route === 'import' ? 'Import' : 'Categories';

  useEffect(() => {
    if (!fontsLoaded) return;
    const timer = setTimeout(() => {
      Animated.timing(bootOpacity, {
        toValue: 0,
        duration: 360,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setBootSplashVisible(false);
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [bootOpacity, fontsLoaded]);

  if (!fontsLoaded) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.safeArea}>
          <StatusBar style="dark" />
          <View style={styles.bootSplash}>
            <Image source={require('./assets/icon.png')} style={styles.bootIcon} />
            <Text style={styles.bootTitle}>Nexus</Text>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <TutorialModal
          visible={tutorialOpen}
          onClose={() => void dismissTutorial()}
          onGoToImport={() => void goToImportFromTutorial()}
        />

      <View style={[styles.shell, !isWide && styles.shellMobile]}>
	        {isWide ? (
	          <Sidebar
	            apiBase={apiBase}
	            route={route}
	            onNavigate={(next) => {
	              setRoute(next);
	              setMenuOpen(false);
	            }}
	            onPressApi={openApiModal}
	          />
	        ) : (
	          <AppHeader
	            title={headerTitle}
	            onOpenMenu={() => setMenuOpen(true)}
	            onCreateThread={route === 'chat' ? handleCreateThread : undefined}
	          />
	        )}

	        <View style={styles.main}>
	          {isWide && <TopBar title={headerTitle} onCreateThread={route === 'chat' ? handleCreateThread : undefined} />}
          {route === 'chat' ? (
            <ChatScreen
              apiBase={apiBase}
              chatHistory={chatHistory}
              chatInput={chatInput}
              onChangeChatInput={setChatInput}
              chatThinking={chatThinking}
              onSend={handleAsk}
              onPressPlus={() => {
                Keyboard.dismiss();
                setRoute('import');
              }}
              onOpenSource={(uri) => {
                if (!uri) return;
                setViewerUri(uri);
              }}
            />
          ) : route === 'import' ? (
	            <ImportScreen
	              uiError={uiError}
	              permissionStatus={permission?.status ?? null}
	              loadingScreenshots={loadingScreenshots}
	              selectedCount={selected.size}
	              importProgress={importProgress}
	              onLoadScreenshots={loadScreenshots}
	              onIndexSelected={handleSendToAI}
	              screenshots={screenshots}
	              selected={selected}
	              onToggleSelect={toggleSelect}
	              assetStageById={assetStageById}
	            />
	          ) : (
            <CategoriesScreen
              uiError={uiError}
              apiBase={apiBase}
              categories={categories}
              activeCategory={activeCategory}
              onSetActiveCategory={setActiveCategory}
              docsInActiveCategory={docsInActiveCategory}
              onRefresh={refreshDocs}
              onDeleteCategory={async (name, mode) => {
                try {
                  await deleteCategory(name, mode);
                } catch (err: any) {
                  setUiError(err?.message ?? 'Failed to delete category');
                }
              }}
              onDeleteCategories={async (names, mode) => {
                try {
                  if (!userId) throw new Error('Missing user id');
                  for (const name of names) {
                    await apiFetch<{ ok: boolean }>(
                      apiBase,
                      userId,
                      `/api/categories/${encodeURIComponent(name)}?mode=${encodeURIComponent(mode)}`,
                      { method: 'DELETE' },
                    );
                  }
                  setActiveCategory(null);
                  await refreshDocs();
                } catch (err: any) {
                  setUiError(err?.message ?? 'Failed to delete categories');
                  throw err;
                }
              }}
              onRenameCategory={async (from, to) => {
                if (!userId) throw new Error('Missing user id');
                await apiFetch<{ ok: boolean }>(apiBase, userId, `/api/categories/${encodeURIComponent(from)}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ to }),
                });
                setActiveCategory(null);
                await refreshDocs();
              }}
              onDeleteDoc={async (docId) => {
                try {
                  await deleteDoc(docId);
                } catch (err: any) {
                  setUiError(err?.message ?? 'Failed to delete photo');
                }
              }}
              onView={(uri) => setViewerUri(uri)}
            />
          )}
        </View>
      </View>

	      {!isWide && (
	        <HamburgerMenu
	          apiBase={apiBase}
	          visible={menuOpen}
	          route={route}
	          threads={threads}
	          activeThreadId={activeThreadId}
	          onClose={() => setMenuOpen(false)}
	          onNavigate={(next) => {
	            setRoute(next);
	            setMenuOpen(false);
	          }}
	          onSelectThread={async (threadId) => {
	            await selectThread(threadId);
	            setRoute('chat');
	            setMenuOpen(false);
	          }}
	          onNewThread={async () => {
	            await createThread();
	            setRoute('chat');
	            setMenuOpen(false);
	          }}
	          onDeleteThread={async (threadId) => {
	            await deleteThreadById(threadId);
	          }}
	          onRenameThread={async (threadId, nextTitle) => {
	            await renameThreadById(threadId, nextTitle);
	          }}
	          onPressApi={() => {
	            setMenuOpen(false);
	            requestAnimationFrame(openApiModal);
	          }}
	        />
	      )}

	      <Modal visible={!!viewerUri} transparent animationType="fade" onRequestClose={closeViewer}>
	        <View style={styles.viewerBackdrop}>
	          <Pressable style={StyleSheet.absoluteFill} onPress={closeViewer} />
	          {viewerUri && (
	            <Animated.View
	              {...viewerPanResponder.panHandlers}
	              style={[
	                styles.viewerCard,
	                { width: viewerCardDims.w, height: viewerCardDims.h, transform: [{ translateY: viewerPanY }] },
	              ]}
	            >
	              <Image
	                source={{ uri: viewerUri }}
	                style={styles.viewerImage}
	                resizeMode="contain"
	                onLoad={(e) => {
	                  const src = (e.nativeEvent as any)?.source;
	                  const w = Number(src?.width ?? 0);
	                  const h = Number(src?.height ?? 0);
	                  if (w > 0 && h > 0) setViewerNatural({ w, h });
	                }}
	              />
	            </Animated.View>
	          )}
	        </View>
	      </Modal>

      {bootSplashVisible && (
        <Animated.View pointerEvents="none" style={[styles.bootSplashOverlay, { opacity: bootOpacity }]}>
          <Image source={require('./assets/icon.png')} style={styles.bootIcon} />
          <Text style={styles.bootTitle}>Nexus</Text>
        </Animated.View>
      )}

      <Modal visible={apiModalOpen} transparent animationType="fade" onRequestClose={() => setApiModalOpen(false)}>
        <View style={styles.renameBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setApiModalOpen(false)} />
          <View style={styles.renameCard}>
            <Text style={styles.renameTitle}>API base URL</Text>
            <TextInput
              ref={apiInputRef}
              value={apiDraft}
              onChangeText={setApiDraft}
              placeholder="http://192.168.0.5:4000"
              placeholderTextColor={COLORS.muted2}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              style={styles.renameInput}
            />
            <View style={styles.renameActions}>
              <Pressable
                onPress={() => setApiModalOpen(false)}
                style={({ pressed }) => [styles.renameButton, pressed && styles.pressed]}
              >
                <Text style={styles.renameButtonText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={saveApiBase} style={({ pressed }) => [styles.renameButtonPrimary, pressed && styles.pressed]}>
                <Text style={styles.renameButtonPrimaryText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function AppHeader(props: { title: string; onOpenMenu: () => void; onCreateThread?: () => void | Promise<void> }) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={props.onOpenMenu}
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        hitSlop={10}
      >
        <View style={styles.hamburgerIcon} pointerEvents="none">
          <View style={styles.hamburgerLine} />
          <View style={[styles.hamburgerLine, styles.hamburgerLineShort]} />
        </View>
      </Pressable>
      <Text pointerEvents="none" style={styles.headerTitle} numberOfLines={1}>
        {props.title}
      </Text>
      {props.onCreateThread ? (
        <Pressable onPress={props.onCreateThread} hitSlop={10} style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}>
          <NewThreadIcon size={22} color={COLORS.text} />
        </Pressable>
      ) : (
        <View style={styles.headerRightSpacer} />
      )}
    </View>
  );
}

function TopBar(props: { title: string; onCreateThread?: () => void | Promise<void> }) {
  return (
    <View style={styles.topBar}>
      <Text style={styles.topBarTitle}>{props.title}</Text>
      {!!props.onCreateThread && (
        <Pressable onPress={props.onCreateThread} hitSlop={10} style={({ pressed }) => [styles.topBarAction, pressed && styles.pressed]}>
          <NewThreadIcon size={22} color={COLORS.text} />
        </Pressable>
      )}
    </View>
  );
}

function NewThreadIcon(props: { size?: number; color?: string }) {
  const size = props.size ?? 20;
  const color = props.color ?? COLORS.text;
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Path
        d="M2.669 11.333V8.667c0-.922 0-1.655.048-2.244.048-.597.15-1.106.387-1.571l.155-.276a4 4 0 0 1 1.593-1.472l.177-.083c.418-.179.872-.263 1.395-.305.589-.048 1.32-.048 2.243-.048h.5a.665.665 0 0 1 0 1.33h-.5c-.944 0-1.613 0-2.135.043-.386.032-.66.085-.876.162l-.2.086a2.67 2.67 0 0 0-1.064.982l-.102.184c-.126.247-.206.562-.248 1.076-.043.523-.043 1.192-.043 2.136v2.666c0 .944 0 1.613.043 2.136.042.514.122.829.248 1.076l.102.184c.257.418.624.758 1.064.982l.2.086c.217.077.49.13.876.161.522.043 1.19.044 2.135.044h2.667c.944 0 1.612-.001 2.135-.044.514-.042.829-.121 1.076-.247l.184-.104c.418-.256.759-.623.983-1.062l.086-.2c.077-.217.13-.49.16-.876.043-.523.044-1.192.044-2.136v-.5a.665.665 0 0 1 1.33 0v.5c0 .922.001 1.655-.047 2.244-.043.522-.127.977-.306 1.395l-.083.176a4 4 0 0 1-1.471 1.593l-.276.154c-.466.238-.975.34-1.572.39-.59.047-1.321.047-2.243.047H8.667c-.923 0-1.654 0-2.243-.048-.523-.043-.977-.126-1.395-.305l-.177-.084a4 4 0 0 1-1.593-1.471l-.155-.276c-.237-.465-.339-.974-.387-1.57-.049-.59-.048-1.322-.048-2.245m10.796-8.22a2.43 2.43 0 0 1 3.255.167l.167.185c.727.892.727 2.18 0 3.071l-.168.185-5.046 5.048a4 4 0 0 1-1.945 1.072l-.317.058-1.817.26a.665.665 0 0 1-.752-.753l.26-1.816.058-.319a4 4 0 0 1 1.072-1.944L13.28 3.28zm2.314 1.108a1.103 1.103 0 0 0-1.476-.076l-.084.076-5.046 5.048a2.67 2.67 0 0 0-.716 1.296l-.04.212-.134.939.94-.134.211-.039a2.67 2.67 0 0 0 1.298-.716L15.78 5.78l.076-.084c.33-.404.33-.988 0-1.392z"
        fill={color}
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </Svg>
  );
}

function Sidebar(props: {
  apiBase: string;
  route: RouteKey;
  onNavigate: (route: RouteKey) => void;
  onPressApi?: () => void;
}) {
  const items: { key: RouteKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { key: 'chat', label: 'Chat', icon: 'chatbubbles-outline' },
    { key: 'import', label: 'Import', icon: 'image-outline' },
    { key: 'categories', label: 'Categories', icon: 'folder-open-outline' },
  ];

  return (
    <View style={styles.sidebar}>
      <View style={styles.sidebarHeader}>
        <BrandMark size={34} />
        <Text style={styles.sidebarTitle}>Nexus</Text>
      </View>

      <View style={styles.sidebarNav}>
        {items.map((item) => {
          const active = props.route === item.key;
          return (
            <Pressable
              key={item.key}
              onPress={() => props.onNavigate(item.key)}
              style={({ pressed }) => [
                styles.navItem,
                active && styles.navItemActive,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons
                name={item.icon}
                size={18}
                color={active ? COLORS.text : COLORS.muted}
                style={styles.navIcon}
              />
              <Text style={[styles.navText, active && styles.navTextActive]}>{item.label}</Text>
              {active && <View style={styles.navDot} />}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.sidebarFooter}>
        <Text style={styles.sidebarFooterLabel}>API</Text>
        <Pressable onPress={props.onPressApi} disabled={!props.onPressApi} style={({ pressed }) => pressed && styles.pressed}>
          <Text style={styles.sidebarFooterValue} numberOfLines={2}>
            {props.apiBase}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function BrandMark(props: { size?: number }) {
  const size = props.size ?? 32;
  return (
    <View style={[styles.brandMarkWrap, { width: size, height: size, borderRadius: Math.round(size * 0.35) }]}>
      <Image
        source={require('./assets/icon.png')}
        style={{ width: size - 8, height: size - 8, borderRadius: Math.round((size - 8) * 0.22) }}
        resizeMode="contain"
      />
    </View>
  );
}

function HamburgerMenu(props: {
  apiBase: string;
  visible: boolean;
  route: RouteKey;
  onClose: () => void;
  onNavigate: (route: RouteKey) => void;
  threads: ChatThread[];
  activeThreadId: string;
  onSelectThread: (threadId: string) => void | Promise<void>;
  onNewThread?: () => void | Promise<void>;
  onDeleteThread?: (threadId: string) => void | Promise<void>;
  onRenameThread?: (threadId: string, nextTitle: string) => void | Promise<void>;
  onPressApi?: () => void;
}) {
  const [scrollViewportHeight, setScrollViewportHeight] = useState(0);
  const [scrollContentHeight, setScrollContentHeight] = useState(0);
  const scrollable = scrollContentHeight > scrollViewportHeight + 4;
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [menuThreadId, setMenuThreadId] = useState<string>('');
  const [renameThreadId, setRenameThreadId] = useState<string>('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const renaming = useRef(false);
  const currentThread = useMemo(() => props.threads.find((t) => t.id === menuThreadId) ?? null, [menuThreadId, props.threads]);

  const openThreadMenu = useCallback(
    async (threadId: string) => {
      setMenuThreadId(threadId);
      setThreadMenuOpen(true);
      try {
        await Haptics.selectionAsync();
      } catch {
        // ignore
      }
    },
    [setMenuThreadId, setThreadMenuOpen],
  );

  const closeThreadMenu = useCallback(() => {
    setThreadMenuOpen(false);
    setMenuThreadId('');
  }, []);

  const openRename = useCallback(() => {
    if (!props.onRenameThread) return;
    const initial = currentThread?.title?.trim() || 'New chat';
    setRenameText(initial);
    setRenameThreadId(menuThreadId);
    setRenameOpen(true);
  }, [currentThread?.title, menuThreadId, props.onRenameThread]);

  const runRename = useCallback(async () => {
    if (!props.onRenameThread) return;
    if (renaming.current) return;
    const nextTitle = renameText.trim();
    if (!nextTitle) {
      Alert.alert('Invalid name', 'Please enter a thread name.');
      return;
    }
    const threadId = renameThreadId;
    if (!threadId) return;
    renaming.current = true;
    try {
      await props.onRenameThread(threadId, nextTitle);
      setRenameOpen(false);
      setRenameThreadId('');
    } finally {
      renaming.current = false;
    }
  }, [props, renameText, renameThreadId]);

  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={styles.menuBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} />
        <SafeAreaView style={styles.menuPanelSafe}>
          <View style={styles.menuPanelInner}>
            <View
              style={styles.menuScrollArea}
              onLayout={(e) => setScrollViewportHeight(e.nativeEvent.layout.height)}
            >
              <ScrollView
                style={styles.menuScroll}
                contentContainerStyle={styles.menuScrollContent}
                showsVerticalScrollIndicator={false}
                onContentSizeChange={(_, h) => setScrollContentHeight(h)}
              >
                <View style={styles.menuHeader}>
                  <View style={styles.brand}>
                    <BrandMark size={32} />
                    <Text style={styles.brandText}>Nexus</Text>
                  </View>
                </View>

                <View style={styles.menuNav}>
                  {([
                    { key: 'chat', label: 'Chat', icon: 'chatbubbles-outline' as const },
                    { key: 'import', label: 'Import', icon: 'image-outline' as const },
                    { key: 'categories', label: 'Categories', icon: 'folder-open-outline' as const },
                  ] as const).map((item) => {
                    const isActive = props.route === item.key;
                    return (
                      <Pressable
                        key={item.key}
                        onPress={() => props.onNavigate(item.key)}
                        style={({ pressed }) => [
                          styles.menuItem,
                          isActive && styles.menuItemActive,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Ionicons name={item.icon} size={18} color={isActive ? COLORS.text : COLORS.muted} />
                        <Text style={[styles.menuItemText, isActive && styles.menuItemTextActive]}>{item.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                <View style={styles.menuDivider} />
                <View style={styles.threadsHeader}>
                  <Text style={styles.threadsLabel}>Threads</Text>
                </View>

                <View style={styles.threadsListContent}>
                  {props.threads
                    .slice()
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                    .map((t) => {
                      const isActive = t.id === props.activeThreadId;
                      return (
                        <Pressable
                          key={t.id}
                          onPress={() => props.onSelectThread(t.id)}
                          onLongPress={() => void openThreadMenu(t.id)}
                          delayLongPress={180}
                          style={({ pressed }) => [
                            styles.threadItem,
                            isActive && styles.threadItemActive,
                            pressed && styles.pressed,
                          ]}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.threadTitle} numberOfLines={1}>
                              {t.title || 'New chat'}
                            </Text>
                            <Text style={styles.threadMeta} numberOfLines={1}>
                              {new Date(t.updatedAt).toLocaleDateString()}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                </View>
              </ScrollView>

              {scrollable && (
                <LinearGradient
                  pointerEvents="none"
                  colors={['rgba(255,255,255,0)', COLORS.surface]}
                  locations={[0, 1]}
                  style={styles.menuFadeBottom}
                />
              )}
            </View>

            <View style={styles.menuFooter}>
              <Text style={styles.menuFooterLabel}>API</Text>
              <Pressable
                onPress={props.onPressApi}
                style={({ pressed }) => [styles.menuFooterButton, pressed && styles.pressed]}
                hitSlop={10}
              >
                <Text style={styles.menuFooterValue} numberOfLines={2}>
                  {props.apiBase}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={COLORS.muted} />
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      </View>

      <Modal visible={threadMenuOpen} transparent animationType="fade" onRequestClose={closeThreadMenu}>
        <View style={styles.threadMenuBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeThreadMenu} />
          <View style={styles.threadMenuCard}>
            <Text style={styles.threadMenuTitle} numberOfLines={1}>
              {currentThread?.title || 'Thread'}
            </Text>
            {!!props.onRenameThread && (
              <Pressable
                onPress={() => {
                  setThreadMenuOpen(false);
                  openRename();
                }}
                style={({ pressed }) => [styles.threadMenuRow, pressed && styles.pressed]}
              >
                <Text style={styles.threadMenuRowText}>Rename</Text>
              </Pressable>
            )}
            {!!props.onDeleteThread && (
              <Pressable
                onPress={() => {
                  const threadId = menuThreadId;
                  closeThreadMenu();
                  Alert.alert('Delete thread?', 'This removes the thread from this device.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => props.onDeleteThread?.(threadId) },
                  ]);
                }}
                style={({ pressed }) => [styles.threadMenuRow, pressed && styles.pressed]}
              >
                <Text style={[styles.threadMenuRowText, styles.threadMenuRowTextDestructive]}>Delete</Text>
              </Pressable>
            )}
            <View style={styles.threadMenuDivider} />
            <Pressable onPress={closeThreadMenu} style={({ pressed }) => [styles.threadMenuRow, pressed && styles.pressed]}>
              <Text style={styles.threadMenuRowText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <View style={styles.renameBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              setRenameOpen(false);
              setRenameThreadId('');
            }}
          />
          <View style={styles.renameCard}>
            <Text style={styles.renameTitle}>Rename thread</Text>
            <TextInput
              value={renameText}
              onChangeText={setRenameText}
              placeholder="New name"
              placeholderTextColor={COLORS.muted2}
              autoCapitalize="sentences"
              autoCorrect={false}
              style={styles.renameInput}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => void runRename()}
            />
            <View style={styles.renameActions}>
              <Pressable
                onPress={() => {
                  setRenameOpen(false);
                  setRenameThreadId('');
                }}
                style={({ pressed }) => [styles.renameButton, pressed && styles.pressed]}
              >
                <Text style={styles.renameButtonText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void runRename()} style={({ pressed }) => [styles.renameButtonPrimary, pressed && styles.pressed]}>
                <Text style={styles.renameButtonPrimaryText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Modal>
  );
}

function ChatScreen(props: {
  apiBase: string;
  chatHistory: ChatEntry[];
  chatInput: string;
  onChangeChatInput: (text: string) => void;
  chatThinking: boolean;
  onSend: () => void;
  onPressPlus: () => void;
  onOpenSource: (uri: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const keyboardAnim = useRef(new Animated.Value(0)).current;
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [composerHeight, setComposerHeight] = useState(0);
  const canSend = !!props.chatInput.trim() && !props.chatThinking;

  useEffect(() => {
    const animateTo = (nextHeight: number, duration: number) => {
      setKeyboardHeight(nextHeight);
      Animated.timing(keyboardAnim, {
        toValue: nextHeight,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    };

    if (Platform.OS === 'ios') {
      const sub = Keyboard.addListener('keyboardWillChangeFrame', (e) => {
        const endScreenY = e.endCoordinates?.screenY ?? windowHeight;
        const raw = Math.max(0, windowHeight - endScreenY);
        const adjusted = Math.max(0, raw - insets.bottom);
        animateTo(adjusted, e.duration ?? 250);
      });
      return () => sub.remove();
    }

    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      const raw = Math.max(0, e.endCoordinates?.height ?? 0);
      const adjusted = Math.max(0, raw - insets.bottom);
      animateTo(adjusted, 180);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => animateTo(0, 180));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [insets.bottom, keyboardAnim, windowHeight]);

  const translateY = Animated.multiply(keyboardAnim, -1);
  const spacerHeight = Math.max(0, composerHeight + 8 + keyboardHeight);

  return (
    <View style={styles.screen}>
      <FlatList
        data={props.chatHistory}
        inverted
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.chatList}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={<View style={{ height: spacerHeight }} />}
        renderItem={({ item }) => {
          const isUser = item.role === 'user';
          return (
            <View style={[styles.messageRow, isUser ? styles.messageRowUser : styles.messageRowAi]}>
              <View style={[styles.avatar, isUser ? styles.avatarUser : styles.avatarAi]}>
                {isUser ? (
                  <Ionicons name="person" size={18} color={COLORS.accentText} />
                ) : item.streaming ? (
                  <ActivityIndicator size="small" color={COLORS.muted} />
                ) : (
                  <Ionicons name="sparkles" size={18} color={COLORS.muted} />
                )}
              </View>
              <View style={[styles.messageBubble, isUser ? styles.messageBubbleUser : styles.messageBubbleAi]}>
                {isUser ? (
                  <Text style={[styles.messageText, styles.messageTextUser]}>{item.text}</Text>
                ) : (
                  <View style={{ gap: 10 }}>
                    <Markdown style={MARKDOWN_STYLES} mergeStyle>
                      {item.text}
                    </Markdown>
                    {!!item.sources?.length && (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sourcesRow}>
                        {item.sources.slice(0, 8).map((doc) => {
                          const uri = resolveDocUri(props.apiBase, doc);
                          return (
                            <Pressable
                              key={doc.id}
                              onPress={() => uri && props.onOpenSource(uri)}
                              style={({ pressed }) => [styles.sourceThumb, pressed && styles.pressed]}
                            >
                              {uri ? (
                                <Image source={{ uri }} style={styles.sourceThumbImage} />
                              ) : (
                                <View style={[styles.sourceThumbImage, styles.assetMissing]}>
                                  <Text style={styles.placeholderText}>No preview</Text>
                                </View>
                              )}
                            </Pressable>
                          );
                        })}
                      </ScrollView>
                    )}
                  </View>
                )}
              </View>
            </View>
          );
        }}
      />
      <Animated.View
        style={[styles.composerOuter, { transform: [{ translateY }] }]}
        onLayout={(e) => {
          const next = Math.round(e.nativeEvent.layout.height);
          setComposerHeight((prev) => (prev === next ? prev : next));
        }}
      >
        <View style={styles.composerRow}>
          <Pressable
            onPress={props.onPressPlus}
            style={({ pressed }) => [styles.plusButton, pressed && styles.pressed]}
            hitSlop={10}
          >
            <Ionicons name="add" size={26} color={COLORS.muted} />
          </Pressable>

          <View style={styles.composerPill}>
            <TextInput
              placeholder="Ask anything"
              placeholderTextColor={COLORS.muted2}
              value={props.chatInput}
              onChangeText={props.onChangeChatInput}
              style={styles.composerInput}
              multiline
              submitBehavior="newline"
              returnKeyType="default"
              blurOnSubmit={false}
            />

            <Pressable
              onPress={props.onSend}
              style={({ pressed }) => [
                styles.sendButton,
                canSend ? styles.sendButtonActive : styles.sendButtonInactive,
                !canSend && styles.disabled,
                pressed && styles.pressed,
              ]}
              hitSlop={10}
              disabled={!canSend}
            >
              <Ionicons name="arrow-up" size={16} color={canSend ? COLORS.accentText : COLORS.muted} />
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

function ImportScreen(props: {
  uiError: string | null;
  permissionStatus: MediaLibrary.PermissionStatus | null;
  loadingScreenshots: boolean;
  selectedCount: number;
  importProgress: { running: boolean; current: number; total: number; done: number; failed: number };
  onLoadScreenshots: () => void;
  onIndexSelected: () => void;
  screenshots: ResolvedAsset[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  assetStageById: Record<string, 'uploading' | 'indexing' | 'done' | 'error'>;
}) {
  const showImporting =
    props.importProgress.total > 0 &&
    (props.importProgress.running || props.importProgress.done + props.importProgress.failed < props.importProgress.total);
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scroll} style={styles.screen}>
        <View style={styles.pageHeader}>
          <View style={styles.pageHeaderText}>
            <Text style={styles.pageTitle}>Import Library</Text>
            <Text style={styles.pageSubtitle}>Select screenshots and index them to your server.</Text>
          </View>
          <Pressable
            onPress={props.onLoadScreenshots}
            style={({ pressed }) => [styles.pillButton, pressed && styles.pressed]}
          >
            <Ionicons name="image-outline" size={16} color={COLORS.text} />
            <Text style={styles.pillButtonText}>{props.loadingScreenshots ? 'Loading…' : 'Import'}</Text>
          </Pressable>
        </View>

        {props.uiError && <Text style={styles.inlineError}>{props.uiError}</Text>}

        {showImporting && (
          <View style={styles.importBanner}>
            <View style={styles.importBannerIcon}>
              <ActivityIndicator size="small" color={COLORS.muted} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.importBannerTitle}>
                Importing all images ({Math.min(props.importProgress.current, props.importProgress.total)} of {props.importProgress.total})
              </Text>
              <Text style={styles.importBannerSubtitle}>
                {props.importProgress.failed
                  ? `${props.importProgress.failed} failed`
                  : 'You can keep using the app while this runs.'}
              </Text>
            </View>
          </View>
        )}

        {props.permissionStatus !== 'granted' && (
          <View style={styles.callout}>
            <Ionicons name="lock-closed-outline" size={16} color={COLORS.muted} />
            <Text style={styles.calloutText}>Allow Photo Library access to import screenshots.</Text>
          </View>
        )}

        {props.screenshots.length === 0 ? (
          <View style={styles.placeholder}>
            {props.loadingScreenshots ? (
              <ActivityIndicator color={COLORS.text} />
            ) : (
              <View style={styles.emptyCard}>
                <Ionicons name="images-outline" size={26} color={COLORS.muted} />
                <Text style={styles.emptyTitle}>No screenshots loaded</Text>
                <Text style={styles.emptySubtitle}>Tap Import to load your latest screenshots.</Text>
              </View>
            )}
          </View>
        ) : (
          <FlatList
            data={props.screenshots}
            keyExtractor={(item) => item.id}
            numColumns={3}
            scrollEnabled={false}
            columnWrapperStyle={styles.assetRow}
            contentContainerStyle={styles.assetGrid}
            renderItem={({ item }) => {
              const isSelected = props.selected.has(item.id);
              const stage = props.assetStageById[item.id];
              return (
                <Pressable onPress={() => props.onToggleSelect(item.id)} style={styles.assetWrapper}>
                  <Image source={{ uri: item.uri }} style={styles.asset} />
                  <View style={styles.assetGradient} pointerEvents="none" />
                  <View style={[styles.assetOverlay, isSelected && styles.assetOverlaySelected]} pointerEvents="none" />
                  <View style={[styles.check, isSelected && styles.checkSelected]}>
                    {isSelected && <Ionicons name="checkmark" size={14} color="#fff" />}
                  </View>
                  {stage === 'error' && (
                    <View style={[styles.assetLoader, styles.assetLoaderError]}>
                      <Ionicons name="alert-circle" size={16} color={COLORS.accentText} />
                    </View>
                  )}
                  {item.mediaType === MediaLibrary.MediaType.video && (
                    <View style={styles.videoBadge}>
                      <Text style={styles.videoBadgeText}>VIDEO</Text>
                    </View>
                  )}
                </Pressable>
              );
            }}
          />
        )}
      </ScrollView>

      {props.selectedCount > 0 && (
        <View style={styles.floatingBar} pointerEvents="box-none">
          <View style={styles.floatingBarCard}>
            <Text style={styles.floatingBarText}>
              <Text style={styles.floatingBarCount}>{props.selectedCount}</Text> selected
            </Text>
            <View style={styles.floatingBarDivider} />
            <Pressable
              onPress={props.onIndexSelected}
              style={({ pressed }) => [
                styles.floatingBarButton,
                props.importProgress.running && styles.disabled,
                pressed && styles.pressed,
              ]}
              disabled={props.importProgress.running}
            >
              <Ionicons
                name={props.importProgress.running ? 'hourglass-outline' : 'cloud-upload-outline'}
                size={16}
                color={COLORS.accentText}
              />
              <Text style={styles.floatingBarButtonText}>{props.importProgress.running ? 'Importing…' : 'Index selected'}</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function CategoriesCategoryCard(props: {
  name: string;
  count: number;
  updatedAt: number;
  index: number;
  selectionMode: boolean;
  selected: boolean;
  onOpen: (name: string) => void;
  onToggle: (name: string) => void;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 420,
      delay: props.index * 100,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [anim, props.index]);

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });
  const updatedLabel = useMemo(() => {
    const ts = Number(props.updatedAt ?? 0);
    if (!ts) return 'Updated —';
    const date = new Date(ts);
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (sameDay) return 'Updated today';
    return `Updated ${date.toLocaleDateString()}`;
  }, [props.updatedAt]);

  return (
    <Animated.View style={[styles.mcGridItem, { opacity: anim, transform: [{ translateY }] }]}>
      <Pressable
        onPress={() => (props.selectionMode ? props.onToggle(props.name) : props.onOpen(props.name))}
        onLongPress={() => props.onToggle(props.name)}
        delayLongPress={180}
        style={({ pressed }) => [
          styles.mcCard,
          props.selected && styles.mcCardSelected,
          pressed && styles.mcCardPressed,
        ]}
      >
        <View style={styles.mcCardDecor} pointerEvents="none" />
        <View style={styles.mcCardTop}>
          <View style={styles.mcCardIcon}>
            <Ionicons name="folder-open" size={22} color={COLORS.accentText} />
          </View>
          {props.selectionMode && (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.();
                props.onToggle(props.name);
              }}
              onPressIn={(e) => e.stopPropagation?.()}
              style={({ pressed }) => [
                styles.mcSelectPill,
                props.selected && styles.mcSelectPillSelected,
                pressed && styles.mcSelectPillPressed,
              ]}
              hitSlop={10}
            >
              {props.selected && <Ionicons name="checkmark" size={16} color={COLORS.accentText} />}
            </Pressable>
          )}
        </View>

        <View style={styles.mcCardBottom}>
          <Text style={styles.mcCardTitle} numberOfLines={1}>
            {props.name}
          </Text>
          <View style={styles.mcMetaRow}>
            <Text style={styles.mcMetaText}>{props.count} items</Text>
            <View style={styles.mcMetaDot} />
            <View style={styles.mcMetaRow}>
              <Ionicons name="time-outline" size={14} color={COLORS.muted} />
              <Text style={styles.mcMetaText}>{updatedLabel}</Text>
            </View>
          </View>
        </View>

        <View style={styles.mcHoverAction} pointerEvents="none">
          <View style={styles.mcHoverActionCircle}>
            <Ionicons name="arrow-forward" size={18} color={COLORS.text} />
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

function CategoriesRefreshCard(props: { index: number; onRefresh: () => void }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 420,
      delay: Math.min(props.index * 100, 400),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [anim, props.index]);

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });
  return (
    <Animated.View style={[styles.mcGridItem, { opacity: anim, transform: [{ translateY }] }]}>
      <Pressable onPress={props.onRefresh} style={({ pressed }) => [styles.mcDashedCard, pressed && styles.mcDashedCardPressed]}>
        <View style={styles.mcDashedIcon}>
          <Ionicons name="folder-outline" size={26} color={COLORS.muted} />
        </View>
        <Text style={styles.mcDashedText}>Refresh</Text>
      </Pressable>
    </Animated.View>
  );
}

function CategoriesEmptyState(props: { onRefresh: () => void }) {
  return (
    <View style={styles.mcEmptyWrap}>
      <Pressable onPress={props.onRefresh} style={({ pressed }) => [styles.mcEmptyCard, pressed && styles.mcDashedCardPressed]}>
        <View style={styles.mcDashedIcon}>
          <Ionicons name="images-outline" size={28} color={COLORS.muted} />
        </View>
        <Text style={styles.mcEmptyTitle}>No categories yet</Text>
        <Text style={styles.mcEmptySubtitle}>Import and index some screenshots first.</Text>
      </Pressable>
    </View>
  );
}

function CategoriesScreen(props: {
  uiError: string | null;
  apiBase: string;
  categories: CategorySummary[];
  activeCategory: string | null;
  onSetActiveCategory: (name: string | null) => void;
  docsInActiveCategory: ServerDoc[];
  onRefresh: () => void;
  onDeleteCategory: (name: string, mode: 'unlink' | 'purge' | 'unlink-delete-orphans') => void;
  onDeleteCategories?: (names: string[], mode: 'unlink' | 'purge' | 'unlink-delete-orphans') => Promise<void> | void;
  onRenameCategory?: (from: string, to: string) => Promise<void> | void;
  onDeleteDoc: (docId: string) => void;
  onView: (uri: string) => void;
}) {
  const { width } = useWindowDimensions();
  const categoryColumns = width >= 1024 ? 3 : width >= 768 ? 2 : 1;
  const mediaColumns = width >= 1280 ? 5 : width >= 1024 ? 4 : width >= 768 ? 3 : 2;
  const pagePadding = width >= 768 ? 32 : 24;
  const [categoryQuery, setCategoryQuery] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [categorySort, setCategorySort] = useState<{ key: 'name' | 'count' | 'updatedAt'; dir: 'asc' | 'desc' }>({
    key: 'count',
    dir: 'desc',
  });

  const pageStyle = useMemo(() => [styles.mcPage, { padding: pagePadding }], [pagePadding]);
  const categoryRowStyle = categoryColumns > 1 ? styles.mcGridRow : undefined;
  const mediaRowStyle = mediaColumns > 1 ? styles.mcGridRowTight : undefined;
  const visibleCategories = useMemo(() => {
    const query = categoryQuery.trim().toLowerCase();
    if (!query) return props.categories;
    return props.categories.filter((c) => c.name.toLowerCase().includes(query));
  }, [categoryQuery, props.categories]);
  const sortedVisibleCategories = useMemo(() => {
    const dirMult = categorySort.dir === 'asc' ? 1 : -1;
    const sorted = [...visibleCategories].sort((a, b) => {
      if (categorySort.key === 'name') {
        const cmp = a.name.localeCompare(b.name);
        return cmp * dirMult;
      }
      if (categorySort.key === 'count') {
        const cmp = (a.count - b.count) || a.name.localeCompare(b.name);
        return cmp * dirMult;
      }
      const cmp = (a.updatedAt - b.updatedAt) || a.name.localeCompare(b.name);
      return cmp * dirMult;
    });
    return sorted;
  }, [categorySort.dir, categorySort.key, visibleCategories]);
  const listData = useMemo(() => {
    const query = categoryQuery.trim();
    if (props.categories.length === 0 && !query) return [];
    return [...sortedVisibleCategories, { name: '__refresh__', count: 0, updatedAt: 0 } as any];
  }, [categoryQuery, props.categories.length, sortedVisibleCategories]);
  const isSelecting = selectionMode;
  const selectedName = selectedCategories.size === 1 ? Array.from(selectedCategories)[0] : null;
  const toggleCategorySelected = (name: string) => {
    setSelectionMode(true);
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const clearSelectedCategories = () => setSelectedCategories(new Set());
  const exitSelectionMode = () => {
    setSelectionMode(false);
    clearSelectedCategories();
  };
  const runDeleteSelected = async (mode: 'unlink' | 'purge' | 'unlink-delete-orphans') => {
    const names = Array.from(selectedCategories);
    if (!names.length || deletingSelected) return;
    setDeletingSelected(true);
    try {
      if (props.onDeleteCategories) {
        await props.onDeleteCategories(names, mode);
      } else {
        for (const name of names) props.onDeleteCategory(name, mode);
      }
      exitSelectionMode();
    } catch (err: any) {
      Alert.alert('Delete failed', err?.message ?? 'Failed to delete selected categories.');
    } finally {
      setDeletingSelected(false);
    }
  };

  const confirmDeleteSelected = () => {
    if (selectedCategories.size < 2) return;
    Alert.alert(
      `Delete ${selectedCategories.size} categor${selectedCategories.size === 1 ? 'y' : 'ies'}?`,
      'Choose what to delete.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove categories', style: 'destructive', onPress: () => runDeleteSelected('unlink') },
        { text: 'Delete categories + photos', style: 'destructive', onPress: () => runDeleteSelected('purge') },
      ],
    );
  };

  const openRename = () => {
    if (!selectedName) return;
    setRenameText(selectedName);
    setRenameOpen(true);
  };

  const runRename = async () => {
    if (!selectedName || renaming) return;
    const nextName = renameText.trim().toLowerCase();
    if (!nextName) return;
    if (nextName === selectedName.trim().toLowerCase()) {
      setRenameOpen(false);
      return;
    }
    setRenaming(true);
    try {
      if (!props.onRenameCategory) throw new Error('Rename is not configured on the server.');
      await props.onRenameCategory(selectedName, nextName);
      setRenameOpen(false);
      exitSelectionMode();
    } catch (err: any) {
      Alert.alert('Rename failed', err?.message ?? 'Failed to rename category.');
    } finally {
      setRenaming(false);
    }
  };

  const MediaCard = (p: { doc: ServerDoc; index: number }) => {
    const anim = useRef(new Animated.Value(0)).current;
    useEffect(() => {
      Animated.timing(anim, {
        toValue: 1,
        duration: 360,
        delay: Math.min(p.index * 30, 360),
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }, [anim, p.index]);
    const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] });
    const uri = resolveDocUri(props.apiBase, p.doc);

    return (
      <Animated.View style={[styles.mcGridItem, { opacity: anim, transform: [{ scale }] }]}>
        <View style={styles.mcMediaCard}>
          <Pressable onPress={() => uri && props.onView(uri)} style={styles.assetPressable}>
            {uri ? (
              <Image source={{ uri }} style={styles.mcMediaImage} />
            ) : (
              <View style={[styles.mcMediaImage, styles.assetMissing]}>
                <Text style={styles.placeholderText}>No preview</Text>
              </View>
            )}
            <LinearGradient
              pointerEvents="none"
              colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.78)']}
              locations={[0.35, 1]}
              style={styles.mcMediaGradient}
            />
          </Pressable>

          <Pressable
            hitSlop={10}
            onPress={() => {
              Alert.alert('Delete photo?', 'This removes it from the server.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => props.onDeleteDoc(p.doc.id) },
              ]);
            }}
            style={({ pressed }) => [styles.mcMediaDelete, pressed && styles.pressed]}
          >
            <Ionicons name="trash-outline" size={16} color="#fff" />
          </Pressable>

          <View style={styles.mcMediaFooter} pointerEvents="none">
            <Text style={styles.mcMediaCaption} numberOfLines={1}>
              {p.doc.caption || 'Screenshot'}
            </Text>
            <Text style={styles.mcMediaDate} numberOfLines={1}>
              {new Date(p.doc.createdAt).toLocaleDateString()}
            </Text>
          </View>
        </View>
      </Animated.View>
    );
  };

  if (props.activeCategory) {
    const title = props.activeCategory;
    return (
      <FlatList
        data={props.docsInActiveCategory}
        key={`media-${title}-${mediaColumns}`}
        keyExtractor={(item) => item.id}
        numColumns={mediaColumns}
        columnWrapperStyle={mediaRowStyle}
        contentContainerStyle={[...pageStyle, styles.mcGrid]}
        ListHeaderComponent={
          <View style={styles.mcDetailHeaderWrap}>
            <View style={styles.mcDetailHeader}>
              <View style={styles.mcDetailLeft}>
                <Pressable
                  onPress={() => props.onSetActiveCategory(null)}
                  style={({ pressed }) => [styles.mcBackButton, pressed && styles.mcBackButtonPressed]}
                  hitSlop={10}
                >
                  <Ionicons name="arrow-back" size={20} color={COLORS.text} />
                </Pressable>
                <View style={styles.mcDetailHeaderText}>
                  <Text style={styles.mcH1} numberOfLines={1}>
                    {title}
                  </Text>
                  <Text style={styles.mcMuted}>{props.docsInActiveCategory.length} item(s)</Text>
                </View>
              </View>

              <Pressable
                onPress={() => {
                  Alert.alert('Delete category', 'Choose what to delete.', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Remove category',
                      style: 'destructive',
                      onPress: () => props.onDeleteCategory(title, 'unlink'),
                    },
                    {
                      text: 'Delete category + photos',
                      style: 'destructive',
                      onPress: () => props.onDeleteCategory(title, 'purge'),
                    },
                  ]);
                }}
                style={({ pressed }) => [styles.mcDangerButton, pressed && styles.mcDangerButtonPressed]}
              >
                <Ionicons name="trash-outline" size={16} color={COLORS.danger} />
                <Text style={styles.mcDangerButtonText}>Delete category</Text>
              </Pressable>
            </View>

            {props.uiError && <Text style={[styles.inlineError, { marginTop: 14 }]}>{props.uiError}</Text>}

            {props.docsInActiveCategory.length === 0 && (
              <Text style={[styles.mcMuted, { marginTop: 16 }]}>No media in this category.</Text>
            )}
          </View>
        }
        renderItem={({ item, index }) => <MediaCard doc={item} index={index} />}
      />
    );
  }

  const query = categoryQuery.trim();
  const shownCount = visibleCategories.length;
  const empty = props.categories.length === 0 && !query;
  const noMatch = props.categories.length > 0 && !!query && shownCount === 0;

	  const categoriesHeader = (
	    <View style={styles.mcHeader}>
	      <View style={styles.mcHeaderTop}>
	        <View style={styles.mcHeaderTitles}>
	          <Text style={styles.mcH1}>Categories</Text>
	          <Text style={styles.mcMuted}>Your organized knowledge clusters.</Text>
	        </View>
	        <View style={styles.mcHeaderActions}>
	          <Pressable
	            onPress={() => setSortOpen(true)}
	            style={({ pressed }) => [styles.mcHeaderMenu, pressed && styles.pressed]}
	            hitSlop={8}
	          >
	            <Ionicons name="swap-vertical" size={18} color={COLORS.text} />
	          </Pressable>
	          <Pressable
	            onPress={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
	            style={({ pressed }) => [styles.mcHeaderMenu, pressed && styles.pressed]}
	            hitSlop={8}
	          >
	            <Ionicons name={selectionMode ? 'close' : 'ellipsis-horizontal'} size={20} color={COLORS.text} />
	          </Pressable>
	        </View>
	      </View>

      {selectionMode && (
        <View style={styles.mcSelectionBar}>
          <Text style={styles.mcSelectionText}>
            {selectedCategories.size ? `${selectedCategories.size} selected` : 'Select categories'}
          </Text>
          <View style={styles.mcSelectionActions}>
            <Pressable
              onPress={exitSelectionMode}
              style={({ pressed }) => [styles.mcSelectionButton, pressed && styles.pressed]}
              disabled={deletingSelected}
            >
              <Text style={styles.mcSelectionButtonText}>Done</Text>
            </Pressable>
            {selectedCategories.size === 1 && (
              <Pressable
                onPress={openRename}
                style={({ pressed }) => [styles.mcSelectionButton, pressed && styles.pressed]}
                disabled={renaming}
              >
                {renaming ? <ActivityIndicator size="small" color={COLORS.text} /> : null}
                <Text style={styles.mcSelectionButtonText}>Rename</Text>
              </Pressable>
            )}
            {selectedCategories.size >= 2 && (
              <Pressable
                onPress={confirmDeleteSelected}
                style={({ pressed }) => [styles.mcSelectionButtonDanger, pressed && styles.pressed]}
                disabled={deletingSelected}
              >
                {deletingSelected ? (
                  <ActivityIndicator size="small" color={COLORS.accentText} />
                ) : (
                  <Ionicons name="trash-outline" size={16} color={COLORS.accentText} />
                )}
                <Text style={styles.mcSelectionButtonDangerText}>Delete</Text>
              </Pressable>
            )}
          </View>
          <Text style={styles.mcSelectionHint}>Tap categories to select. Long-press also works.</Text>
        </View>
      )}

      <View style={styles.mcSearch}>
        <Ionicons name="search" size={16} color={COLORS.muted} style={styles.mcSearchIcon} />
        <TextInput
          value={categoryQuery}
          onChangeText={setCategoryQuery}
          placeholder="Search categories…"
          placeholderTextColor={COLORS.muted2}
          style={styles.mcSearchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="never"
        />
        {!!query && (
          <Pressable
            onPress={() => setCategoryQuery('')}
            hitSlop={10}
            style={({ pressed }) => [styles.mcSearchClear, pressed && styles.pressed]}
          >
            <Ionicons name="close-circle" size={18} color={COLORS.muted} />
          </Pressable>
        )}
      </View>

      {noMatch && <Text style={[styles.mcMuted, { marginTop: 12 }]}>No matching categories.</Text>}
      {props.uiError && <Text style={[styles.inlineError, { marginTop: 10 }]}>{props.uiError}</Text>}
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList
        data={listData}
        key={`cats-${categoryColumns}`}
        keyExtractor={(item) => item.name}
        numColumns={categoryColumns}
        columnWrapperStyle={categoryRowStyle}
        contentContainerStyle={[...pageStyle, { flexGrow: 1 }] as any}
        ItemSeparatorComponent={categoryColumns === 1 ? () => <View style={{ height: 24 }} /> : undefined}
        ListHeaderComponent={categoriesHeader}
        ListEmptyComponent={empty ? <CategoriesEmptyState onRefresh={props.onRefresh} /> : null}
	        renderItem={({ item, index }) => {
	          if (item.name === '__refresh__') return <CategoriesRefreshCard index={index} onRefresh={props.onRefresh} />;
	          return (
	            <CategoriesCategoryCard
	              name={item.name}
	              count={item.count}
	              updatedAt={(item as any).updatedAt ?? 0}
	              index={index}
	              selectionMode={selectionMode}
	              selected={selectedCategories.has(item.name)}
	              onOpen={props.onSetActiveCategory}
	              onToggle={toggleCategorySelected}
	            />
	          );
	        }}
	      />

	      <Modal visible={sortOpen} transparent animationType="fade" onRequestClose={() => setSortOpen(false)}>
	        <View style={styles.sortBackdrop}>
	          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSortOpen(false)} />
	          <View style={styles.sortCard}>
	            <Text style={styles.sortTitle}>Sort</Text>
	            {(
	              [
	                { key: 'name', dir: 'asc', label: 'Alphabetical (A → Z)' },
	                { key: 'name', dir: 'desc', label: 'Alphabetical (Z → A)' },
	                { key: 'count', dir: 'desc', label: 'Items (high → low)' },
	                { key: 'count', dir: 'asc', label: 'Items (low → high)' },
	                { key: 'updatedAt', dir: 'desc', label: 'Updated (newest → oldest)' },
	                { key: 'updatedAt', dir: 'asc', label: 'Updated (oldest → newest)' },
	              ] as const
	            ).map((opt) => {
	              const selectedOpt = categorySort.key === opt.key && categorySort.dir === opt.dir;
	              return (
	                <Pressable
	                  key={`${opt.key}-${opt.dir}`}
	                  onPress={() => {
	                    setCategorySort({ key: opt.key, dir: opt.dir });
	                    setSortOpen(false);
	                  }}
	                  style={({ pressed }) => [styles.sortRow, pressed && styles.pressed]}
	                >
	                  <Text style={styles.sortRowText}>{opt.label}</Text>
	                  {selectedOpt ? <Ionicons name="checkmark" size={18} color={COLORS.text} /> : null}
	                </Pressable>
	              );
	            })}
	          </View>
	        </View>
	      </Modal>
	
	      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
	        <View style={styles.renameBackdrop}>
	          <Pressable style={StyleSheet.absoluteFill} onPress={() => setRenameOpen(false)} />
          <View style={styles.renameCard}>
            <Text style={styles.renameTitle}>Rename category</Text>
            <TextInput
              value={renameText}
              onChangeText={setRenameText}
              placeholder="New name"
              placeholderTextColor={COLORS.muted2}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.renameInput}
            />
            <View style={styles.renameActions}>
              <Pressable
                onPress={() => setRenameOpen(false)}
                style={({ pressed }) => [styles.renameButton, pressed && styles.pressed]}
                disabled={renaming}
              >
                <Text style={styles.renameButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={runRename}
                style={({ pressed }) => [styles.renameButtonPrimary, pressed && styles.pressed]}
                disabled={renaming}
              >
                {renaming ? (
                  <ActivityIndicator size="small" color={COLORS.accentText} />
                ) : (
                  <Text style={styles.renameButtonPrimaryText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function TutorialModal(props: { visible: boolean; onClose: () => void; onGoToImport: () => void }) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={styles.tutorialBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} />
        <View style={styles.tutorialCard}>
          <View style={styles.tutorialHeader}>
            <View style={styles.tutorialIcon}>
              <Ionicons name="sparkles" size={18} color={COLORS.accentText} />
            </View>
            <Text style={styles.tutorialTitle}>Welcome to Nexus</Text>
            <Text style={styles.tutorialSubtitle}>Index your screenshots, then chat with them.</Text>
          </View>

          <View style={styles.tutorialSteps}>
            <View style={styles.tutorialStepRow}>
              <View style={styles.tutorialStepDot}>
                <Text style={styles.tutorialStepDotText}>1</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.tutorialStepTitle}>Import screenshots</Text>
                <Text style={styles.tutorialStepBody}>Tap + in chat (or Import in the menu) to load your latest screenshots.</Text>
              </View>
            </View>

            <View style={styles.tutorialStepRow}>
              <View style={styles.tutorialStepDot}>
                <Text style={styles.tutorialStepDotText}>2</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.tutorialStepTitle}>Index to your server</Text>
                <Text style={styles.tutorialStepBody}>Select screenshots and index them so Nexus can search them.</Text>
              </View>
            </View>

            <View style={styles.tutorialStepRow}>
              <View style={styles.tutorialStepDot}>
                <Text style={styles.tutorialStepDotText}>3</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.tutorialStepTitle}>Ask questions</Text>
                <Text style={styles.tutorialStepBody}>Back in Chat, ask anything. Nexus will retrieve matching screenshots.</Text>
              </View>
            </View>
          </View>

          <View style={styles.tutorialActions}>
            <Pressable onPress={props.onClose} style={({ pressed }) => [styles.renameButton, pressed && styles.pressed]}>
              <Text style={styles.renameButtonText}>Got it</Text>
            </Pressable>
            <Pressable onPress={props.onGoToImport} style={({ pressed }) => [styles.renameButtonPrimary, pressed && styles.pressed]}>
              <Text style={styles.renameButtonPrimaryText}>Go to Import</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  bootSplash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: COLORS.bg,
  },
  bootSplashOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: COLORS.bg,
  },
  bootIcon: {
    width: 84,
    height: 84,
    borderRadius: 18,
  },
  bootTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontFamily: FONT_HEADING_BOLD,
    letterSpacing: -0.2,
  },
  tutorialBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.26)',
    padding: 18,
    justifyContent: 'center',
  },
  tutorialCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
  },
  tutorialHeader: {
    alignItems: 'center',
    gap: 6,
    paddingBottom: 10,
  },
  tutorialIcon: {
    width: 36,
    height: 36,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
  },
  tutorialTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontFamily: FONT_HEADING_BOLD,
  },
  tutorialSubtitle: {
    color: COLORS.muted,
    fontSize: 13,
    textAlign: 'center',
    fontFamily: FONT_SANS,
  },
  tutorialSteps: {
    gap: 12,
    paddingVertical: 10,
  },
  tutorialStepRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  tutorialStepDot: {
    width: 26,
    height: 26,
    borderRadius: 10,
    backgroundColor: COLORS.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  tutorialStepDotText: {
    color: COLORS.text,
    fontSize: 12,
    fontFamily: FONT_SANS_BOLD,
  },
  tutorialStepTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  tutorialStepBody: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
    fontFamily: FONT_SANS,
    lineHeight: 16,
  },
  tutorialActions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
    paddingTop: 6,
  },
  glowLayer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    borderRadius: 9999,
    opacity: 0.35,
  },
  glowA: {
    width: 520,
    height: 520,
    backgroundColor: COLORS.accent,
    top: -240,
    left: -200,
  },
  glowB: {
    width: 420,
    height: 420,
    backgroundColor: COLORS.accent,
    bottom: -200,
    right: -160,
  },
  shell: {
    flex: 1,
    flexDirection: 'row',
  },
  shellMobile: {
    flexDirection: 'column',
  },
  main: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomColor: COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.surface,
  },
  topBarTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontFamily: FONT_HEADING_BOLD,
  },
  header: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomColor: COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.surface,
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontFamily: FONT_HEADING_BOLD,
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    paddingHorizontal: 72,
  },
  headerAction: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRightSpacer: {
    width: 40,
    height: 40,
  },
  topBarAction: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hamburgerIcon: {
    width: 22,
    height: 18,
    justifyContent: 'center',
    gap: 6,
  },
  hamburgerLine: {
    height: 2,
    borderRadius: 2,
    backgroundColor: COLORS.text,
  },
  hamburgerLineShort: {
    width: '75%',
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  brandIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  brandMarkWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  brandIconLarge: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  brandText: {
    color: COLORS.text,
    fontFamily: FONT_HEADING_BOLD,
    fontSize: 14,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: COLORS.border,
    borderWidth: 1,
    backgroundColor: COLORS.surfaceAlt,
  },
  iconButtonDanger: {
    borderColor: 'rgba(185, 28, 28, 0.25)',
    backgroundColor: COLORS.dangerSoft,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.18)',
    flexDirection: 'row',
  },
  menuPanel: {
    width: 260,
    backgroundColor: COLORS.surface,
    padding: 14,
    borderRightColor: COLORS.border,
    borderRightWidth: 1,
    gap: 12,
  },
  menuPanelSafe: {
    width: 280,
    backgroundColor: COLORS.surface,
    borderRightColor: COLORS.border,
    borderRightWidth: 1,
  },
  menuPanelInner: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 16,
    paddingTop: 10,
    gap: 12,
  },
  menuScrollArea: {
    flex: 1,
    position: 'relative',
  },
  menuScroll: {
    flex: 1,
  },
  menuScrollContent: {
    flexGrow: 1,
    paddingBottom: 16,
  },
  menuFadeBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 36,
  },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  menuNav: {
    marginTop: 10,
    gap: 10,
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.border,
    marginTop: 4,
    marginBottom: 2,
  },
  threadsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  threadsLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontFamily: FONT_SANS_SEMIBOLD,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  threadsNew: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
  },
  threadsListContent: {
    gap: 10,
    paddingVertical: 10,
    flexGrow: 1,
  },
  threadItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
  },
  threadItemActive: {
    backgroundColor: COLORS.pill,
  },
  threadTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  threadMeta: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 2,
    fontFamily: FONT_SANS,
  },
  threadMenuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.22)',
    justifyContent: 'flex-end',
    padding: 16,
  },
  threadMenuCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  threadMenuTitle: {
    color: COLORS.muted,
    fontSize: 12,
    fontFamily: FONT_SANS_SEMIBOLD,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 6,
  },
  threadMenuRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  threadMenuRowText: {
    color: COLORS.text,
    fontSize: 16,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  threadMenuRowTextDestructive: {
    color: COLORS.danger,
  },
  threadMenuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.border,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
  },
  menuItemActive: {
    backgroundColor: COLORS.pill,
  },
  menuItemText: {
    color: COLORS.text,
    fontSize: 15,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  menuItemTextActive: {
    color: COLORS.text,
  },
  menuFooter: {
    borderTopColor: COLORS.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    gap: 4,
  },
  menuFooterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: COLORS.surface,
  },
  menuFooterLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontFamily: FONT_SANS_SEMIBOLD,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  menuFooterValue: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: FONT_SANS,
    flex: 1,
  },
  screen: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  scroll: {
    padding: 16,
    paddingBottom: 100,
    gap: 16,
  },
  inlineError: {
    color: COLORS.danger,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: FONT_SANS,
  },
  inlineErrorPad: {
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.4,
  },
  chatList: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  messageRowUser: {
    flexDirection: 'row-reverse',
    alignSelf: 'flex-end',
  },
  messageRowAi: {
    alignSelf: 'flex-start',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  avatarUser: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.border,
  },
  avatarAi: {
    backgroundColor: COLORS.surfaceAlt,
    borderColor: COLORS.border,
  },
  messageBubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    borderWidth: 1,
  },
  messageBubbleUser: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.borderStrong,
    borderTopRightRadius: 6,
  },
  messageBubbleAi: {
    backgroundColor: COLORS.surfaceAlt,
    borderColor: COLORS.border,
    borderTopLeftRadius: 6,
  },
  messageText: {
    color: COLORS.text,
    fontSize: 14,
    lineHeight: 19,
    fontFamily: FONT_SANS,
  },
  messageTextUser: {
    color: COLORS.accentText,
  },
  sourcesRow: {
    gap: 10,
    paddingRight: 6,
  },
  sourceThumb: {
    width: 54,
    height: 54,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    overflow: 'hidden',
  },
  sourceThumbImage: {
    width: '100%',
    height: '100%',
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 16,
    width: 72,
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: 'rgba(167, 139, 250, 0.95)',
  },
  typingDotMid: {
    opacity: 0.7,
  },
  typingDotEnd: {
    opacity: 0.45,
  },
  composerOuter: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 16,
    marginBottom: 10,
    backgroundColor: 'transparent',
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  plusButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.pill,
  },
  composerPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.pill,
    borderRadius: 999,
    height: 44,
    paddingLeft: 14,
    paddingRight: 4,
  },
  composerInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 15,
    fontFamily: FONT_SANS,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonInactive: {
    backgroundColor: 'rgba(15, 23, 42, 0.12)',
  },
  sendButtonActive: {
    backgroundColor: COLORS.accent,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  pageHeaderText: {
    flex: 1,
  },
  pageTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontFamily: FONT_HEADING_BOLD,
  },
  pageSubtitle: {
    color: COLORS.muted,
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: FONT_SANS,
  },
  pillButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
  },
  pillButtonText: {
    color: COLORS.text,
    fontFamily: FONT_SANS_SEMIBOLD,
    fontSize: 13,
  },
  callout: {
    borderRadius: 14,
    borderColor: COLORS.border,
    borderWidth: 1,
    backgroundColor: COLORS.surfaceAlt,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  calloutText: {
    color: COLORS.text,
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
    fontFamily: FONT_SANS,
  },
  importBanner: {
    borderRadius: 14,
    borderColor: COLORS.border,
    borderWidth: 1,
    backgroundColor: COLORS.surfaceAlt,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  importBannerIcon: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  importBannerTitle: {
    color: COLORS.text,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  importBannerSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
    fontFamily: FONT_SANS,
  },
  placeholder: {
    paddingVertical: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
    padding: 16,
    gap: 8,
    alignItems: 'center',
  },
  emptyTitle: {
    color: COLORS.text,
    fontFamily: FONT_SANS_BOLD,
    fontSize: 14,
  },
  emptySubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
    fontFamily: FONT_SANS,
  },
  placeholderText: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    fontFamily: FONT_SANS,
  },
  assetGrid: {
    gap: 10,
  },
  assetRow: {
    gap: 10,
    marginBottom: 10,
  },
  assetWrapper: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
    borderColor: COLORS.border,
    borderWidth: 1,
    backgroundColor: COLORS.surfaceAlt,
  },
  assetPressable: {
    flex: 1,
  },
  asset: {
    width: '100%',
    height: '100%',
  },
  assetGradient: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.06)',
  },
  assetMissing: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surfaceAlt,
  },
  assetOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.12)',
    opacity: 0,
  },
  assetOverlaySelected: {
    opacity: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.16)',
  },
  check: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  checkSelected: {
    backgroundColor: COLORS.accent,
    borderColor: 'rgba(15, 23, 42, 0.25)',
  },
  assetLoader: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: COLORS.accent,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  assetLoaderError: {
    backgroundColor: COLORS.danger,
    borderColor: 'rgba(185, 28, 28, 0.25)',
  },
  videoBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
  },
  videoBadgeText: {
    color: COLORS.accentText,
    fontSize: 10,
    fontFamily: FONT_SANS_EXTRABOLD,
    letterSpacing: 0.6,
  },
  floatingBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 16,
    alignItems: 'center',
  },
  floatingBarCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: COLORS.shadow,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
  },
  floatingBarText: {
    color: COLORS.text,
    fontFamily: FONT_SANS_SEMIBOLD,
    fontSize: 14,
  },
  floatingBarCount: {
    color: COLORS.text,
    fontFamily: FONT_SANS_EXTRABOLD,
  },
  floatingBarDivider: {
    width: 1,
    height: 18,
    backgroundColor: COLORS.border,
  },
  floatingBarButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  floatingBarButtonText: {
    color: COLORS.accentText,
    fontFamily: FONT_SANS_EXTRABOLD,
    fontSize: 13,
  },

  mcPage: {
    width: '100%',
    maxWidth: 1280,
    alignSelf: 'center',
    paddingBottom: 40,
  },
  mcHeader: {
    marginBottom: 32,
    gap: 8,
  },
  mcHeaderTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  mcHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mcHeaderTitles: {
    flex: 1,
    gap: 8,
  },
  mcHeaderMenu: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
  },
  mcH1: {
    color: COLORS.text,
    fontSize: 30,
    lineHeight: 36,
    fontFamily: FONT_HEADING_BOLD,
    letterSpacing: -0.6,
  },
  mcMuted: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 19,
    fontFamily: FONT_SANS,
  },
  mcSearch: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 48,
    borderRadius: 16,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
  },
  mcSearchIcon: {
    marginTop: 1,
  },
  mcSearchInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 15,
    fontFamily: FONT_SANS,
    paddingVertical: 0,
  },
  mcSearchClear: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
  },
  mcGridItem: {
    flex: 1,
  },
  mcGrid: {
    paddingTop: 0,
  },
  mcGridRow: {
    gap: 24,
    marginBottom: 24,
  },
  mcGridRowTight: {
    gap: 16,
    marginBottom: 16,
  },
  mcCard: {
    flex: 1,
    minHeight: 240,
    borderRadius: 24,
    padding: 24,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    overflow: 'hidden',
    shadowColor: COLORS.shadow,
    shadowOpacity: 0.10,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 2,
  },
  mcCardPressed: {
    transform: [{ scale: 0.985 }],
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.surfaceAlt,
  },
  mcCardDecor: {
    position: 'absolute',
    right: -40,
    top: -40,
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: COLORS.text,
    opacity: 0.05,
  },
  mcCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  mcCardIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
  },
  mcIconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  mcIconButtonPressed: {
    backgroundColor: COLORS.overlay,
  },
  mcSelectPill: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
  },
  mcSelectPillPressed: {
    backgroundColor: COLORS.overlay,
    borderColor: COLORS.borderStrong,
  },
  mcSelectPillSelected: {
    backgroundColor: COLORS.accent,
    borderColor: 'rgba(15, 23, 42, 0.25)',
  },
  mcCardBottom: {
    marginTop: 32,
    gap: 4,
  },
  mcCardTitle: {
    color: COLORS.text,
    fontSize: 20,
    lineHeight: 26,
    fontFamily: FONT_HEADING_BOLD,
  },
  mcMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  mcMetaText: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: FONT_SANS,
  },
  mcMetaDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.borderStrong,
  },
  mcHoverAction: {
    position: 'absolute',
    right: 24,
    bottom: 24,
    opacity: 0.75,
  },
  mcHoverActionCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.overlay,
    borderColor: COLORS.border,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mcDashedCard: {
    flex: 1,
    minHeight: 240,
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: 'transparent',
  },
  mcDashedCardPressed: {
    backgroundColor: COLORS.surfaceAlt,
    borderColor: COLORS.borderStrong,
    transform: [{ scale: 0.985 }],
  },
  mcDashedIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surfaceAlt,
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  mcDashedText: {
    color: COLORS.text,
    fontSize: 16,
    fontFamily: FONT_SANS_MEDIUM,
  },
  mcEmptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 24,
    paddingBottom: 40,
  },
  mcEmptyCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: 'transparent',
  },
  mcEmptyTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  mcEmptySubtitle: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    fontFamily: FONT_SANS,
  },
  mcCardSelected: {
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.surfaceAlt,
  },
  mcSelectionBar: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: 18,
    padding: 12,
    gap: 10,
  },
  mcSelectionText: {
    color: COLORS.text,
    fontSize: 13,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  mcSelectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mcSelectionButton: {
    flexDirection: 'row',
    gap: 8,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mcSelectionButtonText: {
    color: COLORS.text,
    fontSize: 13,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  mcSelectionButtonDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: COLORS.accent,
  },
  mcSelectionButtonDangerText: {
    color: COLORS.accentText,
    fontSize: 13,
    fontFamily: FONT_SANS_EXTRABOLD,
  },
  mcSelectionHint: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: FONT_SANS,
  },
  renameBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  renameCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    padding: 16,
    gap: 12,
    shadowColor: COLORS.shadow,
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 12 },
    elevation: 4,
  },
  renameTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  renameInput: {
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
    paddingHorizontal: 14,
    color: COLORS.text,
    fontSize: 15,
    fontFamily: FONT_SANS,
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  sortBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sortCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    padding: 16,
    shadowColor: COLORS.shadow,
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 12 },
    elevation: 4,
  },
  sortTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontFamily: FONT_SANS_SEMIBOLD,
    marginBottom: 10,
  },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
    marginTop: 10,
  },
  sortRowText: {
    color: COLORS.text,
    fontFamily: FONT_SANS,
    fontSize: 13,
  },
  renameButton: {
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  renameButtonText: {
    color: COLORS.text,
    fontSize: 13,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  renameButtonPrimary: {
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 86,
  },
  renameButtonPrimaryText: {
    color: COLORS.accentText,
    fontSize: 13,
    fontFamily: FONT_SANS_EXTRABOLD,
  },
  mcDetailHeaderWrap: {
    marginBottom: 22,
  },
  mcDetailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  mcDetailLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  mcBackButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
  },
  mcBackButtonPressed: {
    backgroundColor: COLORS.overlay,
    borderColor: COLORS.borderStrong,
  },
  mcDetailHeaderText: {
    flex: 1,
    gap: 2,
  },
  mcDangerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
  },
  mcDangerButtonPressed: {
    backgroundColor: COLORS.overlay,
    borderColor: 'rgba(185, 28, 28, 0.25)',
  },
  mcDangerButtonText: {
    color: COLORS.danger,
    fontSize: 13,
    fontFamily: FONT_SANS_MEDIUM,
  },
  mcMediaCard: {
    flex: 1,
    aspectRatio: 9 / 16,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
  },
  mcMediaImage: {
    width: '100%',
    height: '100%',
  },
  mcMediaGradient: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.6,
  },
  mcMediaDelete: {
    position: 'absolute',
    top: 12,
    left: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.48)',
    borderColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mcMediaFooter: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    gap: 2,
  },
  mcMediaCaption: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 11,
    lineHeight: 15,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  mcMediaDate: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 11,
    lineHeight: 15,
    fontFamily: FONT_SANS,
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  categoryCard: {
    width: '48%',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
    padding: 12,
    gap: 10,
  },
  categoryCardMain: {
    gap: 10,
  },
  categoryIcon: {
    width: 44,
    height: 44,
    borderRadius: 16,
    backgroundColor: COLORS.accent,
    borderColor: COLORS.border,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryName: {
    color: COLORS.text,
    fontSize: 15,
    fontFamily: FONT_SANS_BOLD,
  },
  categoryCount: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: FONT_SANS,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  detailHeaderText: {
    flex: 1,
  },
  deleteBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 154, 162, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sidebar: {
    width: 260,
    padding: 16,
    borderRightColor: COLORS.border,
    borderRightWidth: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.surface,
  },
  sidebarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
  },
  sidebarTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontFamily: FONT_HEADING_BOLD,
  },
  sidebarNav: {
    marginTop: 14,
    gap: 10,
    flex: 1,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: COLORS.surface,
  },
  navItemActive: {
    backgroundColor: COLORS.pill,
  },
  navIcon: {
    marginRight: 10,
  },
  navText: {
    color: COLORS.text,
    fontSize: 14,
    fontFamily: FONT_SANS_SEMIBOLD,
  },
  navTextActive: {
    color: COLORS.text,
  },
  navDot: {
    marginLeft: 'auto',
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: COLORS.text,
  },
  sidebarFooter: {
    borderTopColor: COLORS.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    gap: 4,
  },
  sidebarFooterLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontFamily: FONT_SANS_SEMIBOLD,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sidebarFooterValue: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: FONT_SANS,
  },
  viewerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
  },
  viewerCard: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 18 },
    elevation: 4,
  },
  viewerImage: {
    width: '100%',
    height: '100%',
  },
});
