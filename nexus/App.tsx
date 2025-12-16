import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import * as MediaLibrary from 'expo-media-library';
import { useFonts } from 'expo-font';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
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

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

const FONT_SANS = 'Inter_400Regular';
const FONT_SANS_MEDIUM = 'Inter_500Medium';
const FONT_SANS_SEMIBOLD = 'Inter_600SemiBold';
const FONT_SANS_BOLD = 'Inter_700Bold';
const FONT_SANS_EXTRABOLD = 'Inter_800ExtraBold';
const FONT_HEADING_SEMIBOLD = 'PlusJakartaSans_600SemiBold';
const FONT_HEADING_BOLD = 'PlusJakartaSans_700Bold';
const FONT_HEADING_EXTRABOLD = 'PlusJakartaSans_800ExtraBold';

const randomId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const resolveDocUri = (doc: ServerDoc) => {
  if (!doc.uri) return null;
  if (doc.uri.startsWith('http')) return doc.uri;
  return `${API_BASE}${doc.uri}`;
};

const toWsUrl = (base: string) => {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const ensureAssetUri = async (asset: MediaLibrary.Asset) => {
  const info = await MediaLibrary.getAssetInfoAsync(asset);
  const legacyLocalUri = (asset as any).localUri as string | undefined;
  return info.localUri ?? legacyLocalUri ?? asset.uri;
};

const apiFetch = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${API_BASE}${path}`, init);
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

  const { width } = useWindowDimensions();
  const isWide = width >= 860;

  const [route, setRoute] = useState<RouteKey>('chat');
  const [menuOpen, setMenuOpen] = useState(false);

  const [permission, setPermission] = useState<MediaLibrary.PermissionResponse | null>(null);
  const [loadingScreenshots, setLoadingScreenshots] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [screenshots, setScreenshots] = useState<ResolvedAsset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [docs, setDocs] = useState<ServerDoc[]>([]);
  const [uiError, setUiError] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [chatThinking, setChatThinking] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);

  useEffect(() => {
    MediaLibrary.getPermissionsAsync().then((p) => setPermission(p));
    refreshDocs();
  }, []);

  useEffect(() => {
    if (route === 'categories') refreshDocs();
    if (route !== 'categories') setActiveCategory(null);
  }, [route]);

  const refreshDocs = async () => {
    try {
      const data = await apiFetch<{ docs: ServerDoc[] }>('/api/docs');
      setDocs(data.docs ?? []);
    } catch (err: any) {
      setUiError(err?.message ?? 'Failed to load stored documents');
    }
  };

  const handleRequestAccess = async () => {
    const response = await MediaLibrary.requestPermissionsAsync();
    setPermission(response);
    return response.status === 'granted';
  };

  const loadScreenshots = async () => {
    if (loadingScreenshots) return;
    setLoadingScreenshots(true);
    setUiError(null);
    try {
      const hasAccess = permission?.status === 'granted' ? true : await handleRequestAccess();
      if (!hasAccess) return;

      const album = await MediaLibrary.getAlbumAsync('Screenshots');
      const searchSource = album ? { album } : {};
      const result = await MediaLibrary.getAssetsAsync({
        ...searchSource,
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

    const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form });
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
        uploaded.push(await uploadAssetToServer(asset));
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
    setChatHistory((prev) => [userEntry, ...prev]);

    const assistantId = randomId();
    const updateAssistant = (text: string) => {
      setChatHistory((prev) => {
        const existing = prev.find((e) => e.id === assistantId);
        if (existing) return prev.map((e) => (e.id === assistantId ? { ...e, text } : e));
        return [{ id: assistantId, role: 'assistant', text }, ...prev];
      });
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
      const ws = new WebSocket(toWsUrl(API_BASE));
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
              try {
                ws.close();
              } finally {
                resolve();
              }
            });
          } else if (parsed.type === 'error') {
            finishOnce(() => {
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
    } finally {
      setChatThinking(false);
      if (!assistantText) {
        assistantText = 'No response (nothing indexed yet?). Go to Import and index screenshots first.';
        scheduleFlush();
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
    await apiFetch<{ ok: boolean }>(`/api/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' });
    setDocs((prev) => prev.filter((d) => d.id !== docId));
  };

  const deleteCategory = async (name: string, mode: 'unlink' | 'purge' | 'unlink-delete-orphans') => {
    await apiFetch<{ ok: boolean }>(
      `/api/categories/${encodeURIComponent(name)}?mode=${encodeURIComponent(mode)}`,
      { method: 'DELETE' },
    );
    setActiveCategory(null);
    refreshDocs();
  };

  const headerTitle = route === 'chat' ? 'Chat' : route === 'import' ? 'Import' : 'Categories';

  if (!fontsLoaded) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <View style={styles.fontSplash}>
          <ActivityIndicator size="large" color="#a78bfa" />
          <Text style={styles.fontSplashText}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View pointerEvents="none" style={styles.glowLayer}>
        <View style={[styles.glow, styles.glowA]} />
        <View style={[styles.glow, styles.glowB]} />
      </View>

      <View style={[styles.shell, !isWide && styles.shellMobile]}>
        {isWide ? (
          <Sidebar
            apiBase={API_BASE}
            route={route}
            onNavigate={(next) => {
              setRoute(next);
              setMenuOpen(false);
            }}
          />
        ) : (
          <AppHeader title={headerTitle} onOpenMenu={() => setMenuOpen(true)} />
        )}

        <View style={styles.main}>
          {isWide && <TopBar title={headerTitle} />}
          {route === 'chat' ? (
            <ChatScreen
              chatHistory={chatHistory}
              chatInput={chatInput}
              onChangeChatInput={setChatInput}
              chatThinking={chatThinking}
              onSend={handleAsk}
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
            />
          ) : (
            <CategoriesScreen
              uiError={uiError}
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
          apiBase={API_BASE}
          visible={menuOpen}
          route={route}
          onClose={() => setMenuOpen(false)}
          onNavigate={(next) => {
            setRoute(next);
            setMenuOpen(false);
          }}
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
    </SafeAreaView>
  );
}

function AppHeader(props: { title: string; onOpenMenu: () => void }) {
  return (
    <View style={styles.header}>
      <View style={styles.brand}>
        <View style={styles.brandIcon}>
          <Ionicons name="sparkles" size={16} color="#fff" />
        </View>
        <Text style={styles.brandText}>Nexus</Text>
      </View>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {props.title}
      </Text>
      <Pressable
        onPress={props.onOpenMenu}
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        hitSlop={10}
      >
        <Ionicons name="menu" size={22} color="#e9edff" />
      </Pressable>
    </View>
  );
}

function TopBar(props: { title: string }) {
  return (
    <View style={styles.topBar}>
      <Text style={styles.topBarTitle}>{props.title}</Text>
    </View>
  );
}

function Sidebar(props: { apiBase: string; route: RouteKey; onNavigate: (route: RouteKey) => void }) {
  const items: { key: RouteKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { key: 'chat', label: 'Chat', icon: 'chatbubbles-outline' },
    { key: 'import', label: 'Import', icon: 'image-outline' },
    { key: 'categories', label: 'Categories', icon: 'folder-open-outline' },
  ];

  return (
    <View style={styles.sidebar}>
      <View style={styles.sidebarHeader}>
        <View style={styles.brandIconLarge}>
          <Ionicons name="sparkles" size={18} color="#fff" />
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
                color={active ? '#a78bfa' : '#9aa6d6'}
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
        <Text style={styles.sidebarFooterValue} numberOfLines={2}>
          {props.apiBase}
        </Text>
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
}) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={styles.menuBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} />
        <View style={styles.menuPanel}>
          <View style={styles.menuHeader}>
            <View style={styles.brand}>
              <View style={styles.brandIcon}>
                <Ionicons name="sparkles" size={16} color="#fff" />
              </View>
              <Text style={styles.menuTitle}>Nexus</Text>
            </View>
            <Pressable onPress={props.onClose} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
              <Ionicons name="close" size={20} color="#e9edff" />
            </Pressable>
          </View>
          <Text style={styles.menuSubtitle} numberOfLines={2}>
            {props.apiBase}
          </Text>
          <View style={styles.menuDivider} />
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
                <Ionicons name={item.icon} size={18} color={isActive ? '#a78bfa' : '#9aa6d6'} />
                <Text style={[styles.menuItemText, isActive && styles.menuItemTextActive]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </View>
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
}) {
  const Typing = () => (
    <View style={[styles.messageRow, styles.messageRowAi]}>
      <View style={[styles.avatar, styles.avatarAi]}>
        <Ionicons name="sparkles" size={18} color="#c7d2fe" />
      </View>
      <View style={[styles.messageBubble, styles.messageBubbleAi, styles.typingBubble]}>
        <View style={styles.typingDot} />
        <View style={[styles.typingDot, styles.typingDotMid]} />
        <View style={[styles.typingDot, styles.typingDotEnd]} />
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 6 : 0}
    >
      <FlatList
        data={props.chatHistory}
        inverted
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.chatList}
        keyboardDismissMode="on-drag"
        ListHeaderComponent={props.chatThinking ? <Typing /> : null}
        renderItem={({ item }) => {
          const isUser = item.role === 'user';
          return (
            <View style={[styles.messageRow, isUser ? styles.messageRowUser : styles.messageRowAi]}>
              <View style={[styles.avatar, isUser ? styles.avatarUser : styles.avatarAi]}>
                <Ionicons name={isUser ? 'person' : 'sparkles'} size={18} color={isUser ? '#fff' : '#c7d2fe'} />
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
            <Ionicons name="image-outline" size={20} color="#9aa6d6" />
          </Pressable>
          <TextInput
            placeholder="Ask about your screenshots…"
            placeholderTextColor="#6f7ba6"
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
            <Ionicons name="send" size={18} color="#0b1224" />
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
            <Ionicons name="image-outline" size={16} color="#e9edff" />
            <Text style={styles.pillButtonText}>{props.loadingScreenshots ? 'Loading…' : 'Import'}</Text>
          </Pressable>
        </View>

        {props.uiError && <Text style={styles.inlineError}>{props.uiError}</Text>}

        {props.permissionStatus !== 'granted' && (
          <View style={styles.callout}>
            <Ionicons name="lock-closed-outline" size={16} color="#c7d2fe" />
            <Text style={styles.calloutText}>Allow Photo Library access to import screenshots.</Text>
          </View>
        )}

        {props.screenshots.length === 0 ? (
          <View style={styles.placeholder}>
            {props.loadingScreenshots ? (
              <ActivityIndicator color="#a78bfa" />
            ) : (
              <View style={styles.emptyCard}>
                <Ionicons name="images-outline" size={26} color="#9aa6d6" />
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
              return (
                <Pressable onPress={() => props.onToggleSelect(item.id)} style={styles.assetWrapper}>
                  <Image source={{ uri: item.uri }} style={styles.asset} />
                  <View style={styles.assetGradient} pointerEvents="none" />
                  <View style={[styles.assetOverlay, isSelected && styles.assetOverlaySelected]} pointerEvents="none" />
                  <View style={[styles.check, isSelected && styles.checkSelected]}>
                    {isSelected && <Ionicons name="checkmark" size={14} color="#fff" />}
                  </View>
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
              <Ionicons name={props.processing ? 'hourglass-outline' : 'cloud-upload-outline'} size={16} color="#fff" />
              <Text style={styles.floatingBarButtonText}>{props.processing ? 'Indexing…' : 'Index selected'}</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function CategoriesScreen(props: {
  uiError: string | null;
  categories: { name: string; count: number }[];
  activeCategory: string | null;
  onSetActiveCategory: (name: string | null) => void;
  docsInActiveCategory: ServerDoc[];
  onRefresh: () => void;
  onDeleteCategory: (name: string, mode: 'unlink' | 'purge' | 'unlink-delete-orphans') => void;
  onDeleteDoc: (docId: string) => void;
  onView: (uri: string) => void;
}) {
  const { width } = useWindowDimensions();
  const categoryColumns = width >= 1024 ? 3 : width >= 768 ? 2 : 1;
  const mediaColumns = width >= 1280 ? 5 : width >= 1024 ? 4 : width >= 768 ? 3 : 2;
  const pagePadding = width >= 768 ? 32 : 24;
  const [categoryQuery, setCategoryQuery] = useState('');

  const pageStyle = useMemo(() => [styles.mcPage, { padding: pagePadding }], [pagePadding]);
  const categoryRowStyle = categoryColumns > 1 ? styles.mcGridRow : undefined;
  const mediaRowStyle = mediaColumns > 1 ? styles.mcGridRowTight : undefined;
  const categoriesData = useMemo(
    () => [...props.categories, { name: '__refresh__', count: 0 }],
    [props.categories],
  );
  const filteredCategoriesData = useMemo(() => {
    const query = categoryQuery.trim().toLowerCase();
    if (!query) return categoriesData;
    const normal = props.categories.filter((c) => c.name.toLowerCase().includes(query));
    return [...normal, { name: '__refresh__', count: 0 }];
  }, [categoryQuery, categoriesData, props.categories]);

  const CategoryCard = (p: { name: string; count: number; index: number }) => {
    const anim = useRef(new Animated.Value(0)).current;
    useEffect(() => {
      Animated.timing(anim, {
        toValue: 1,
        duration: 420,
        delay: p.index * 100,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }, [anim, p.index]);

    const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });

    return (
      <Animated.View style={[styles.mcGridItem, { opacity: anim, transform: [{ translateY }] }]}>
        <Pressable
          onPress={() => props.onSetActiveCategory(p.name)}
          style={({ pressed }) => [styles.mcCard, pressed && styles.mcCardPressed]}
        >
          <View style={styles.mcCardDecor} pointerEvents="none" />
          <View style={styles.mcCardTop}>
            <View style={styles.mcCardIcon}>
              <Ionicons name="folder-open" size={22} color="#fff" />
            </View>
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.();
                Alert.alert(p.name, 'Category actions', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Open', onPress: () => props.onSetActiveCategory(p.name) },
                  {
                    text: 'Remove category',
                    style: 'destructive',
                    onPress: () => props.onDeleteCategory(p.name, 'unlink'),
                  },
                  {
                    text: 'Delete category + photos',
                    style: 'destructive',
                    onPress: () => props.onDeleteCategory(p.name, 'purge'),
                  },
                ]);
              }}
              onPressIn={(e) => e.stopPropagation?.()}
              style={({ pressed }) => [styles.mcIconButton, pressed && styles.mcIconButtonPressed]}
              hitSlop={10}
            >
              <Ionicons name="ellipsis-horizontal" size={20} color="#9aa6d6" />
            </Pressable>
          </View>

          <View style={styles.mcCardBottom}>
            <Text style={styles.mcCardTitle} numberOfLines={1}>
              {p.name}
            </Text>
            <View style={styles.mcMetaRow}>
              <Text style={styles.mcMetaText}>{p.count} items</Text>
              <View style={styles.mcMetaDot} />
              <View style={styles.mcMetaRow}>
                <Ionicons name="time-outline" size={14} color="#9aa6d6" />
                <Text style={styles.mcMetaText}>Updated today</Text>
              </View>
            </View>
          </View>

          <View style={styles.mcHoverAction} pointerEvents="none">
            <View style={styles.mcHoverActionCircle}>
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </View>
          </View>
        </Pressable>
      </Animated.View>
    );
  };

  const RefreshCard = (p: { index: number }) => {
    const anim = useRef(new Animated.Value(0)).current;
    useEffect(() => {
      Animated.timing(anim, {
        toValue: 1,
        duration: 420,
        delay: Math.min(p.index * 100, 400),
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }, [anim, p.index]);

    const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });
    return (
      <Animated.View style={[styles.mcGridItem, { opacity: anim, transform: [{ translateY }] }]}>
        <Pressable
          onPress={props.onRefresh}
          style={({ pressed }) => [styles.mcDashedCard, pressed && styles.mcDashedCardPressed]}
        >
          <View style={styles.mcDashedIcon}>
            <Ionicons name="folder-outline" size={26} color="#9aa6d6" />
          </View>
          <Text style={styles.mcDashedText}>Refresh</Text>
        </Pressable>
      </Animated.View>
    );
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
    const uri = resolveDocUri(p.doc);

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
                  <Ionicons name="arrow-back" size={20} color="#e9edff" />
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
                <Ionicons name="trash-outline" size={16} color="#fecdd3" />
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

  const renderCategoriesHeader = useMemo(() => {
    const query = categoryQuery.trim();
    const shownCount = filteredCategoriesData.length ? filteredCategoriesData.length - 1 : 0; // exclude refresh card
    const empty = props.categories.length === 0;
    const noMatch = !empty && shownCount === 0;

    return (
      <View style={styles.mcHeader}>
        <Text style={styles.mcH1}>Categories</Text>
        <Text style={styles.mcMuted}>Your organized knowledge clusters.</Text>

        <View style={styles.mcSearch}>
          <Ionicons name="search" size={16} color="#9aa6d6" style={styles.mcSearchIcon} />
          <TextInput
            value={categoryQuery}
            onChangeText={setCategoryQuery}
            placeholder="Search categories…"
            placeholderTextColor="#6f7aa8"
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
              <Ionicons name="close-circle" size={18} color="#9aa6d6" />
            </Pressable>
          )}
        </View>

        {empty && (
          <Text style={[styles.mcMuted, { marginTop: 12 }]}>
            No categories yet. Import and index some screenshots first.
          </Text>
        )}
        {noMatch && <Text style={[styles.mcMuted, { marginTop: 12 }]}>No matching categories.</Text>}
        {props.uiError && <Text style={[styles.inlineError, { marginTop: 10 }]}>{props.uiError}</Text>}
      </View>
    );
  }, [categoryQuery, filteredCategoriesData.length, props.categories.length, props.uiError]);

  return (
    <FlatList
      data={filteredCategoriesData}
      key={`cats-${categoryColumns}`}
      keyExtractor={(item) => item.name}
      numColumns={categoryColumns}
      columnWrapperStyle={categoryRowStyle}
      contentContainerStyle={pageStyle as any}
      ItemSeparatorComponent={categoryColumns === 1 ? () => <View style={{ height: 24 }} /> : undefined}
      ListHeaderComponent={renderCategoriesHeader}
      renderItem={({ item, index }) => {
        if (item.name === '__refresh__') return <RefreshCard index={index} />;
        return <CategoryCard name={item.name} count={item.count} index={index} />;
      }}
    />
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#050812',
  },
  fontSplash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  fontSplashText: {
    color: '#9aa6d6',
    fontSize: 13,
    fontFamily: FONT_SANS_MEDIUM,
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
    backgroundColor: '#7c3aed',
    top: -240,
    left: -200,
  },
  glowB: {
    width: 420,
    height: 420,
    backgroundColor: '#2563eb',
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
    borderBottomColor: 'rgba(255,255,255,0.08)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  topBarTitle: {
    color: '#f8f9ff',
    fontSize: 18,
    fontWeight: '900',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomColor: 'rgba(255,255,255,0.08)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  headerTitle: {
    color: '#f8f9ff',
    fontSize: 16,
    fontWeight: '900',
    flex: 1,
    textAlign: 'center',
    paddingHorizontal: 10,
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
    backgroundColor: '#7c3aed',
    borderColor: 'rgba(124,58,237,0.35)',
    borderWidth: 1,
  },
  brandIconLarge: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#7c3aed',
    borderColor: 'rgba(124,58,237,0.35)',
    borderWidth: 1,
  },
  brandText: {
    color: '#e9edff',
    fontWeight: '900',
    fontSize: 14,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  iconButtonDanger: {
    borderColor: 'rgba(255, 154, 162, 0.35)',
    backgroundColor: 'rgba(255, 154, 162, 0.10)',
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    flexDirection: 'row',
  },
  menuPanel: {
    width: 260,
    backgroundColor: 'rgba(10, 14, 30, 0.98)',
    padding: 14,
    borderRightColor: 'rgba(255,255,255,0.10)',
    borderRightWidth: 1,
    gap: 12,
  },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  menuTitle: {
    color: '#f8f9ff',
    fontSize: 18,
    fontWeight: '900',
  },
  menuSubtitle: {
    color: '#8a94bc',
    fontSize: 12,
    lineHeight: 16,
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.10)',
    marginVertical: 6,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
  },
  menuItemActive: {
    borderColor: 'rgba(167, 139, 250, 0.7)',
    backgroundColor: 'rgba(124, 58, 237, 0.10)',
  },
  menuItemText: {
    color: '#e1e7ff',
    fontSize: 15,
    fontWeight: '800',
  },
  menuItemTextActive: {
    color: '#f1edff',
  },
  screen: {
    flex: 1,
  },
  scroll: {
    padding: 16,
    paddingBottom: 100,
    gap: 16,
  },
  inlineError: {
    color: '#ff9aa2',
    fontSize: 13,
    lineHeight: 18,
  },
  inlineErrorPad: {
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  pressed: {
    opacity: 0.85,
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
    backgroundColor: '#7c3aed',
    borderColor: 'rgba(124,58,237,0.35)',
  },
  avatarAi: {
    backgroundColor: 'rgba(99, 102, 241, 0.14)',
    borderColor: 'rgba(255,255,255,0.10)',
  },
  messageBubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    borderWidth: 1,
  },
  messageBubbleUser: {
    backgroundColor: 'rgba(124, 58, 237, 0.95)',
    borderColor: 'rgba(124, 58, 237, 0.55)',
    borderTopRightRadius: 6,
  },
  messageBubbleAi: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderTopLeftRadius: 6,
  },
  messageText: {
    color: '#f0f3ff',
    fontSize: 14,
    lineHeight: 19,
  },
  messageTextUser: {
    color: '#ffffff',
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
    borderTopColor: 'rgba(255,255,255,0.08)',
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(5, 8, 18, 0.92)',
  },
  composerGlow: {
    position: 'absolute',
    left: 14,
    right: 14,
    top: 10,
    bottom: 10,
    borderRadius: 20,
    backgroundColor: 'rgba(124, 58, 237, 0.10)',
  },
  composerInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.12)',
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
    color: '#f8f9ff',
    fontSize: 15,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 42,
    maxHeight: 120,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: '#7c3aed',
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
    color: '#f8f9ff',
    fontSize: 22,
    fontWeight: '900',
  },
  pageSubtitle: {
    color: '#9aa6d6',
    marginTop: 4,
    fontSize: 13,
    lineHeight: 18,
  },
  pillButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  pillButtonText: {
    color: '#e9edff',
    fontWeight: '800',
    fontSize: 13,
  },
  callout: {
    borderRadius: 14,
    borderColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  calloutText: {
    color: '#d9e2ff',
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
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
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: 16,
    gap: 8,
    alignItems: 'center',
  },
  emptyTitle: {
    color: '#f0f3ff',
    fontWeight: '900',
    fontSize: 14,
  },
  emptySubtitle: {
    color: '#9aa6d6',
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  placeholderText: {
    color: '#8a94bc',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
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
    borderColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
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
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  assetMissing: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  assetOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.20)',
    opacity: 0,
  },
  assetOverlaySelected: {
    opacity: 1,
    backgroundColor: 'rgba(124, 58, 237, 0.22)',
  },
  check: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  checkSelected: {
    backgroundColor: '#7c3aed',
    borderColor: 'rgba(124, 58, 237, 0.4)',
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
    color: '#e9edff',
    fontSize: 10,
    fontWeight: '900',
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
    backgroundColor: '#f8f9ff',
    shadowColor: '#7c3aed',
    shadowOpacity: 0.25,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
  },
  floatingBarText: {
    color: '#0b1224',
    fontWeight: '800',
    fontSize: 14,
  },
  floatingBarCount: {
    color: '#7c3aed',
  },
  floatingBarDivider: {
    width: 1,
    height: 18,
    backgroundColor: 'rgba(11,18,36,0.14)',
  },
  floatingBarButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#7c3aed',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  floatingBarButtonText: {
    color: '#fff',
    fontWeight: '900',
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
  mcH1: {
    color: '#f8f9ff',
    fontSize: 30,
    lineHeight: 36,
    fontFamily: FONT_HEADING_BOLD,
    letterSpacing: -0.6,
  },
  mcMuted: {
    color: '#9aa6d6',
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
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  mcSearchIcon: {
    marginTop: 1,
  },
  mcSearchInput: {
    flex: 1,
    color: '#f8f9ff',
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
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    overflow: 'hidden',
    shadowColor: '#7c3aed',
    shadowOpacity: 0.08,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 2,
  },
  mcCardPressed: {
    transform: [{ scale: 0.985 }],
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  mcCardDecor: {
    position: 'absolute',
    right: -40,
    top: -40,
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: '#7c3aed',
    opacity: 0.08,
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
    backgroundColor: '#7c3aed',
    shadowColor: '#7c3aed',
    shadowOpacity: 0.25,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 2,
  },
  mcIconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.01)',
  },
  mcIconButtonPressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  mcCardBottom: {
    marginTop: 32,
    gap: 4,
  },
  mcCardTitle: {
    color: '#f8f9ff',
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
    color: '#9aa6d6',
    fontSize: 14,
    lineHeight: 20,
    fontFamily: FONT_SANS,
  },
  mcMetaDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.20)',
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
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: 'rgba(255,255,255,0.10)',
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
    borderColor: 'rgba(255,255,255,0.10)',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: 'rgba(255,255,255,0.00)',
  },
  mcDashedCardPressed: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderColor: 'rgba(167, 139, 250, 0.35)',
    transform: [{ scale: 0.985 }],
  },
  mcDashedIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
  },
  mcDashedText: {
    color: '#c7d2fe',
    fontSize: 16,
    fontFamily: FONT_SANS_MEDIUM,
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
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  mcBackButtonPressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255,255,255,0.16)',
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
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  mcDangerButtonPressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255, 154, 162, 0.35)',
  },
  mcDangerButtonText: {
    color: '#fecdd3',
    fontSize: 13,
    fontFamily: FONT_SANS_MEDIUM,
  },
  mcMediaCard: {
    flex: 1,
    aspectRatio: 9 / 16,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.04)',
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
    backgroundColor: 'rgba(0,0,0,0.40)',
    borderColor: 'rgba(255,255,255,0.10)',
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
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.05)',
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
    backgroundColor: '#7c3aed',
    borderColor: 'rgba(124, 58, 237, 0.35)',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryName: {
    color: '#f8f9ff',
    fontSize: 15,
    fontWeight: '900',
  },
  categoryCount: {
    color: '#9aa6d6',
    fontSize: 12,
    lineHeight: 16,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: 'rgba(255,255,255,0.08)',
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
    borderRightColor: 'rgba(255,255,255,0.10)',
    borderRightWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  sidebarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
  },
  sidebarTitle: {
    color: '#f8f9ff',
    fontSize: 18,
    fontWeight: '900',
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
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  navItemActive: {
    borderColor: 'rgba(167, 139, 250, 0.55)',
    backgroundColor: 'rgba(124, 58, 237, 0.10)',
  },
  navIcon: {
    marginRight: 10,
  },
  navText: {
    color: '#c7d2fe',
    fontSize: 14,
    fontWeight: '800',
  },
  navTextActive: {
    color: '#f1edff',
  },
  navDot: {
    marginLeft: 'auto',
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#a78bfa',
  },
  sidebarFooter: {
    borderTopColor: 'rgba(255,255,255,0.10)',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    gap: 4,
  },
  sidebarFooterLabel: {
    color: '#9aa6d6',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sidebarFooterValue: {
    color: '#c7d2fe',
    fontSize: 12,
    lineHeight: 16,
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
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.03)',
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
