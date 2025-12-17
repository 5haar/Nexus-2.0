import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import * as MediaLibrary from 'expo-media-library';
import { useFonts } from 'expo-font';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  NativeModules,
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

type ChatEntry = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
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
const FALLBACK_HEADER_HEIGHT = 56;
const FALLBACK_TOPBAR_HEIGHT = 56;

const COLORS = {
  bg: '#ffffff',
  surface: '#ffffff',
  surfaceAlt: '#f8fafc',
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

const apiFetch = async <T,>(apiBase: string, path: string, init?: RequestInit): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, init);
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

  const { width } = useWindowDimensions();
  const isWide = width >= 860;

  const [route, setRoute] = useState<RouteKey>('chat');
  const [menuOpen, setMenuOpen] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [topBarHeight, setTopBarHeight] = useState(0);

  const [permission, setPermission] = useState<MediaLibrary.PermissionResponse | null>(null);
  const [loadingScreenshots, setLoadingScreenshots] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [screenshots, setScreenshots] = useState<ResolvedAsset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assetStageById, setAssetStageById] = useState<Record<string, 'uploading' | 'indexing' | 'done' | 'error'>>(
    {},
  );

  const [docs, setDocs] = useState<ServerDoc[]>([]);
  const [uiError, setUiError] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [chatThinking, setChatThinking] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);

  useEffect(() => {
    MediaLibrary.getPermissionsAsync(false).then((p) => setPermission(p));
    refreshDocs();
  }, []);

  useEffect(() => {
    if (route === 'categories') refreshDocs();
    if (route !== 'categories') setActiveCategory(null);
  }, [route]);

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

  const saveApiBase = async () => {
    const next = apiDraft.trim().replace(/\/+$/, '');
    if (!next) return;
    setApiBase(next);
    await AsyncStorage.setItem(API_BASE_STORAGE_KEY, next);
    setApiModalOpen(false);
  };

  const refreshDocs = async () => {
    try {
      const data = await apiFetch<{ docs: ServerDoc[] }>(apiBase, '/api/docs');
      setDocs(data.docs ?? []);
    } catch (err: any) {
      setUiError(err?.message ?? 'Failed to load stored documents');
    }
  };

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
    const uri = item.uri || (await ensureAssetUri(item.asset));
    if (!uri) throw new Error('No local URI for asset');

    const form = new FormData();
    form.append('file', {
      uri,
      name: item.filename || `${item.id}.jpg`,
      type: item.mediaType === MediaLibrary.MediaType.video ? 'video/mp4' : 'image/jpeg',
    } as any);
    form.append('createdAt', String(item.createdAt ?? Date.now()));

    let res: Response;
    try {
      res = await fetch(`${apiBase}/api/upload`, { method: 'POST', body: form });
    } catch (err: any) {
      const detail = String(err?.message ?? err ?? '');
      Alert.alert('Network error', `Can’t reach your server at:\n${apiBase}`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Set API URL', onPress: openApiModal },
      ]);
      throw new Error(
        `Network request failed (API: ${apiBase}). Make sure the server is reachable from your phone.\n${detail}`.trim(),
      );
    }
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(detail || 'Upload failed');
    }
    const json = await res.json();
    return json.doc as ServerDoc;
  };

  const handleSendToAI = async () => {
    if (!selected.size || processing) return;
    setProcessing(true);
    setUiError(null);
    try {
      const targets = screenshots.filter((s) => selected.has(s.id)).slice(0, 10);
      const uploaded: ServerDoc[] = [];
      for (const asset of targets) {
        setAssetStageById((prev) => ({ ...prev, [asset.id]: 'uploading' }));
        const stageTimer = setTimeout(() => {
          setAssetStageById((prev) => (prev[asset.id] === 'uploading' ? { ...prev, [asset.id]: 'indexing' } : prev));
        }, 550);
        try {
          uploaded.push(await uploadAssetToServer(asset));
          setAssetStageById((prev) => ({ ...prev, [asset.id]: 'done' }));
        } catch (err) {
          setAssetStageById((prev) => ({ ...prev, [asset.id]: 'error' }));
          throw err;
        } finally {
          clearTimeout(stageTimer);
        }
      }
      if (uploaded.length) setDocs((prev) => [...uploaded, ...prev]);
      setSelected(new Set());
    } catch (err: any) {
      setUiError(err?.message ?? 'Failed to process screenshots');
    } finally {
      setProcessing(false);
    }
  };

  const handleAsk = async () => {
    if (!chatInput.trim() || chatThinking) return;
    const prompt = chatInput.trim();
    setChatInput('');
    setChatThinking(true);
    setUiError(null);

    const userEntry: ChatEntry = { id: randomId(), role: 'user', text: prompt };
    const assistantId = randomId();
    setChatHistory((prev) => [{ id: assistantId, role: 'assistant', text: '', streaming: true }, userEntry, ...prev]);

    const updateAssistant = (text: string) => {
      setChatHistory((prev) => {
        const existing = prev.find((e) => e.id === assistantId);
        if (existing) return prev.map((e) => (e.id === assistantId ? { ...e, text } : e));
        return [{ id: assistantId, role: 'assistant', text, streaming: true }, ...prev];
      });
    };

    const setAssistantStreaming = (streaming: boolean) => {
      setChatHistory((prev) => prev.map((e) => (e.id === assistantId ? { ...e, streaming } : e)));
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
          ws.send(JSON.stringify({ type: 'search', query: prompt }));
        };

        ws.onmessage = (evt) => {
          let parsed: any;
          try {
            parsed = JSON.parse(String(evt.data));
          } catch {
            return;
          }

          if (parsed.type === 'matches') {
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
    }
  };

  const categories = useMemo(() => {
    const map: Record<string, number> = {};
    for (const doc of docs) {
      for (const c of doc.categories ?? []) {
        const key = c.trim().toLowerCase();
        if (!key) continue;
        map[key] = (map[key] ?? 0) + 1;
      }
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [docs]);

  const docsInActiveCategory = useMemo(() => {
    if (!activeCategory) return [];
    const target = activeCategory.toLowerCase();
    return docs.filter((doc) => doc.categories.some((c) => c.trim().toLowerCase() === target));
  }, [docs, activeCategory]);

  const deleteDoc = async (docId: string) => {
    await apiFetch<{ ok: boolean }>(apiBase, `/api/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' });
    setDocs((prev) => prev.filter((d) => d.id !== docId));
  };

  const deleteCategory = async (name: string, mode: 'unlink' | 'purge' | 'unlink-delete-orphans') => {
    await apiFetch<{ ok: boolean }>(
      apiBase,
      `/api/categories/${encodeURIComponent(name)}?mode=${encodeURIComponent(mode)}`,
      { method: 'DELETE' },
    );
    setActiveCategory(null);
    refreshDocs();
  };

  const headerTitle = route === 'chat' ? 'Chat' : route === 'import' ? 'Import' : 'Categories';
  const keyboardVerticalOffset =
    Platform.OS === 'ios'
      ? isWide
        ? topBarHeight || FALLBACK_TOPBAR_HEIGHT
        : headerHeight || FALLBACK_HEADER_HEIGHT
      : 0;

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
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.bootSplash}>
          <Image source={require('./assets/icon.png')} style={styles.bootIcon} />
          <Text style={styles.bootTitle}>Nexus</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />

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
            onMeasuredHeight={(h) => setHeaderHeight(h)}
          />
        )}

        <View style={styles.main}>
          {isWide && <TopBar title={headerTitle} onMeasuredHeight={(h) => setTopBarHeight(h)} />}
          {route === 'chat' ? (
            <ChatScreen
              chatHistory={chatHistory}
              chatInput={chatInput}
              onChangeChatInput={setChatInput}
              chatThinking={chatThinking}
              onSend={handleAsk}
              keyboardVerticalOffset={keyboardVerticalOffset}
            />
          ) : route === 'import' ? (
            <ImportScreen
              uiError={uiError}
              permissionStatus={permission?.status ?? null}
              loadingScreenshots={loadingScreenshots}
              selectedCount={selected.size}
              processing={processing}
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
                  for (const name of names) {
                    await apiFetch<{ ok: boolean }>(
                      apiBase,
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
                await apiFetch<{ ok: boolean }>(apiBase, `/api/categories/${encodeURIComponent(from)}`, {
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
          onClose={() => setMenuOpen(false)}
          onNavigate={(next) => {
            setRoute(next);
            setMenuOpen(false);
          }}
          onPressApi={openApiModal}
        />
      )}

      <Modal visible={!!viewerUri} transparent animationType="fade" onRequestClose={() => setViewerUri(null)}>
        <View style={styles.viewerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewerUri(null)} />
          {viewerUri && (
            <View style={styles.viewerCard}>
              <Image source={{ uri: viewerUri }} style={styles.viewerImage} resizeMode="contain" />
            </View>
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
              value={apiDraft}
              onChangeText={setApiDraft}
              placeholder="http://192.168.0.5:4000"
              placeholderTextColor={COLORS.muted2}
              autoCapitalize="none"
              autoCorrect={false}
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
  );
}

function AppHeader(props: { title: string; onOpenMenu: () => void; onMeasuredHeight?: (height: number) => void }) {
  return (
    <View
      style={styles.header}
      onLayout={(e) => {
        props.onMeasuredHeight?.(e.nativeEvent.layout.height);
      }}
    >
      <View style={styles.brand}>
        <View style={styles.brandIcon}>
          <Ionicons name="sparkles" size={16} color={COLORS.accentText} />
        </View>
        <Text style={styles.brandText}>Nexus</Text>
      </View>
      <Text pointerEvents="none" style={styles.headerTitle} numberOfLines={1}>
        {props.title}
      </Text>
      <Pressable
        onPress={props.onOpenMenu}
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        hitSlop={10}
      >
        <Ionicons name="menu" size={22} color={COLORS.text} />
      </Pressable>
    </View>
  );
}

function TopBar(props: { title: string; onMeasuredHeight?: (height: number) => void }) {
  return (
    <View
      style={styles.topBar}
      onLayout={(e) => {
        props.onMeasuredHeight?.(e.nativeEvent.layout.height);
      }}
    >
      <Text style={styles.topBarTitle}>{props.title}</Text>
    </View>
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
        <View style={styles.brandIconLarge}>
          <Ionicons name="sparkles" size={18} color={COLORS.accentText} />
        </View>
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

function HamburgerMenu(props: {
  apiBase: string;
  visible: boolean;
  route: RouteKey;
  onClose: () => void;
  onNavigate: (route: RouteKey) => void;
  onPressApi?: () => void;
}) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={styles.menuBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} />
        <SafeAreaView style={styles.menuPanelSafe}>
          <View style={styles.menuPanelInner}>
            <View style={styles.menuHeader}>
              <View style={styles.brand}>
                <View style={styles.brandIcon}>
                  <Ionicons name="sparkles" size={16} color={COLORS.accentText} />
                </View>
                <Text style={styles.brandText}>Nexus</Text>
              </View>
              <Pressable onPress={props.onClose} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                <Ionicons name="close" size={20} color={COLORS.text} />
              </Pressable>
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

            <View style={styles.menuFooter}>
              <Text style={styles.menuFooterLabel}>API</Text>
              <Pressable onPress={props.onPressApi} disabled={!props.onPressApi} style={({ pressed }) => pressed && styles.pressed}>
                <Text style={styles.menuFooterValue} numberOfLines={2}>
                  {props.apiBase}
                </Text>
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function ChatScreen(props: {
  chatHistory: ChatEntry[];
  chatInput: string;
  onChangeChatInput: (text: string) => void;
  chatThinking: boolean;
  onSend: () => void;
  keyboardVerticalOffset: number;
}) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
      keyboardVerticalOffset={props.keyboardVerticalOffset}
    >
      <FlatList
        data={props.chatHistory}
        inverted
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.chatList}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={null}
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
                <Text style={[styles.messageText, isUser && styles.messageTextUser]}>{item.text}</Text>
              </View>
            </View>
          );
        }}
      />
      <View style={styles.composerOuter}>
        <View style={styles.composerGlow} pointerEvents="none" />
        <View style={styles.composerInner}>
          <Pressable style={({ pressed }) => [styles.composerIconButton, pressed && styles.pressed]} hitSlop={8}>
            <Ionicons name="image-outline" size={20} color={COLORS.muted} />
          </Pressable>
          <TextInput
            placeholder="Ask about your screenshots…"
            placeholderTextColor={COLORS.muted2}
            value={props.chatInput}
            onChangeText={props.onChangeChatInput}
            style={styles.composerInput}
            multiline
          />
          <Pressable
            onPress={props.onSend}
            style={({ pressed }) => [
              styles.sendButton,
              (props.chatThinking || !props.chatInput.trim()) && styles.disabled,
              pressed && styles.pressed,
            ]}
            hitSlop={8}
          >
            <Ionicons name="send" size={18} color={COLORS.accentText} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function ImportScreen(props: {
  uiError: string | null;
  permissionStatus: MediaLibrary.PermissionStatus | null;
  loadingScreenshots: boolean;
  selectedCount: number;
  processing: boolean;
  onLoadScreenshots: () => void;
  onIndexSelected: () => void;
  screenshots: ResolvedAsset[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  assetStageById: Record<string, 'uploading' | 'indexing' | 'done' | 'error'>;
}) {
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
              const showLoader = stage === 'uploading' || stage === 'indexing';
              return (
                <Pressable onPress={() => props.onToggleSelect(item.id)} style={styles.assetWrapper}>
                  <Image source={{ uri: item.uri }} style={styles.asset} />
                  <View style={styles.assetGradient} pointerEvents="none" />
                  <View style={[styles.assetOverlay, isSelected && styles.assetOverlaySelected]} pointerEvents="none" />
                  <View style={[styles.check, isSelected && styles.checkSelected]}>
                    {isSelected && <Ionicons name="checkmark" size={14} color="#fff" />}
                  </View>
                  {showLoader && (
                    <View style={styles.assetLoader}>
                      <ActivityIndicator size="small" color={COLORS.accentText} />
                    </View>
                  )}
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
                props.processing && styles.disabled,
                pressed && styles.pressed,
              ]}
              disabled={props.processing}
            >
              <Ionicons
                name={props.processing ? 'hourglass-outline' : 'cloud-upload-outline'}
                size={16}
                color={COLORS.accentText}
              />
              <Text style={styles.floatingBarButtonText}>{props.processing ? 'Indexing…' : 'Index selected'}</Text>
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
              <Text style={styles.mcMetaText}>Updated today</Text>
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
  categories: { name: string; count: number }[];
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

  const pageStyle = useMemo(() => [styles.mcPage, { padding: pagePadding }], [pagePadding]);
  const categoryRowStyle = categoryColumns > 1 ? styles.mcGridRow : undefined;
  const mediaRowStyle = mediaColumns > 1 ? styles.mcGridRowTight : undefined;
  const visibleCategories = useMemo(() => {
    const query = categoryQuery.trim().toLowerCase();
    if (!query) return props.categories;
    return props.categories.filter((c) => c.name.toLowerCase().includes(query));
  }, [categoryQuery, props.categories]);
  const listData = useMemo(() => {
    const query = categoryQuery.trim();
    if (props.categories.length === 0 && !query) return [];
    return [...visibleCategories, { name: '__refresh__', count: 0 }];
  }, [categoryQuery, props.categories.length, visibleCategories]);
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
        <Pressable
          onPress={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
          style={({ pressed }) => [styles.mcHeaderMenu, pressed && styles.pressed]}
        >
          <Ionicons name={selectionMode ? 'close' : 'ellipsis-horizontal'} size={20} color={COLORS.text} />
        </Pressable>
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
              index={index}
              selectionMode={selectionMode}
              selected={selectedCategories.has(item.name)}
              onOpen={props.onSetActiveCategory}
              onToggle={toggleCategorySelected}
            />
          );
        }}
      />

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
    paddingHorizontal: 92,
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
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  menuNav: {
    marginTop: 10,
    gap: 10,
    flex: 1,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: COLORS.surfaceAlt,
    borderColor: COLORS.border,
    borderWidth: 1,
  },
  menuItemActive: {
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.overlay,
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
    padding: 14,
    borderTopColor: COLORS.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.surface,
  },
  composerGlow: {
    position: 'absolute',
    left: 14,
    right: 14,
    top: 10,
    bottom: 10,
    borderRadius: 20,
    backgroundColor: COLORS.overlay,
  },
  composerInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: COLORS.surfaceAlt,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
  },
  composerIconButton: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 15,
    fontFamily: FONT_SANS,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 42,
    maxHeight: 120,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
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
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceAlt,
  },
  navItemActive: {
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.overlay,
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
    width: '92%',
    height: '92%',
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
