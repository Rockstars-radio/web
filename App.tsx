import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  AppState,
  Animated,
  Easing,
  Image,
  ImageBackground,
  ImageSourcePropType,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type AppStateStatus,
} from 'react-native';

const STREAMS = {
  high: {
    label: 'Rápido',
    detail: 'MP3 · arranque inmediato',
    url: 'https://radio.rockstars.com.co/listen/rockstars/rockstars.mp3',
  },
  mobile: {
    label: 'Ahorro de datos',
    detail: 'AAC · menor consumo',
    url: 'https://radio.rockstars.com.co/listen/rockstars/rock-mobile.aac',
  },
} as const;

const NOW_PLAYING_ENDPOINT = 'https://radio.rockstars.com.co/api/nowplaying/rockstars';
const API_ORIGIN = 'https://radio.rockstars.com.co';
const REQUESTS_PER_PAGE = 6;
const REQUESTS_REFRESH_INTERVAL_MS = 45000;
const SIGNAL_COPY = 'SEÑAL DE ALTO VOLTAJE';
const DEFAULT_COVER = require('./assets/rockstars-logo-white.png');
const STAGE_BACKGROUND = require('./assets/rock-wall-stage.png');
const IS_WEB = Platform.OS === 'web';

type StreamKey = keyof typeof STREAMS;
type WebPlaybackState = 'idle' | 'buffering' | 'primed' | 'playing' | 'blocked' | 'error';

type NowPlayingInfo = {
  songTitle: string;
  songArtist: string;
  songText: string;
  stationName: string;
  coverArt: string | null;
  elapsed: number;
  duration: number;
  progressPercent: number;
  updatedLabel: string;
  history: Array<{
    id: string;
    title: string;
    artist: string;
    text: string;
    coverArt: string | null;
    playedLabel: string;
  }>;
  playerUrl: string | null;
  playlistUrl: string | null;
  requestListUrl: string | null;
  requestEnabled: boolean;
};

type RequestSong = {
  requestId: string;
  requestUrl: string;
  title: string;
  artist: string;
  album: string;
  text: string;
  coverArt: string | null;
};

const FALLBACK_NOW_PLAYING: NowPlayingInfo = {
  songTitle: 'Rock sin pausas',
  songArtist: 'Rockstars',
  songText: 'La radio que inmortaliza el Rock',
  stationName: 'Rockstars',
  coverArt: null,
  elapsed: 0,
  duration: 0,
  progressPercent: 0,
  updatedLabel: 'Esperando metadata en vivo',
  history: [],
  playerUrl: 'https://radio.rockstars.com.co/public/rockstars',
  playlistUrl: 'https://radio.rockstars.com.co/public/rockstars/playlist.m3u',
  requestListUrl: 'https://radio.rockstars.com.co/api/station/1/requests',
  requestEnabled: true,
};

function formatSongClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0:00';
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function getDayMomentLabel() {
  const hour = new Date().getHours();

  if (hour >= 5 && hour < 12) {
    return 'mañana';
  }

  if (hour >= 12 && hour < 19) {
    return 'tarde';
  }

  return 'noche';
}

function buildNowPlaying(payload: any): NowPlayingInfo {
  const song = payload?.now_playing?.song ?? {};
  const live = payload?.live?.is_live ?? false;
  const stationName = payload?.station?.name ?? 'Rockstars';
  const elapsed = Number(payload?.now_playing?.elapsed ?? 0);
  const duration = Number(payload?.now_playing?.duration ?? 0);
  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (elapsed / duration) * 100)) : 0;
  const history = Array.isArray(payload?.song_history)
    ? payload.song_history.slice(0, 15).map((entry: any) => ({
        id: String(entry?.sh_id ?? entry?.song?.id ?? Math.random()),
        title: entry?.song?.title || 'Tema anterior',
        artist: entry?.song?.artist || 'Rockstars',
        text: entry?.song?.text || 'Rock sin pausas',
        coverArt: entry?.song?.art || entry?.song?.art_100 || null,
        playedLabel: entry?.played_at
          ? new Date(entry.played_at * 1000).toLocaleTimeString('es-CO', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : 'Hace un momento',
      }))
    : [];

  return {
    songTitle: song.title || 'Rock sin pausas',
    songArtist: song.artist || (live ? 'En vivo ahora' : 'Rockstars'),
    songText: song.text || 'La radio que inmortaliza el Rock',
    stationName,
    coverArt: song.art || song.art_100 || null,
    elapsed,
    duration,
    progressPercent,
    updatedLabel: `Actualizado ${new Date().toLocaleTimeString('es-CO', {
      hour: '2-digit',
      minute: '2-digit',
    })}`,
    history,
    playerUrl: payload?.station?.public_player_url || payload?.station?.url || null,
    playlistUrl: payload?.station?.playlist_m3u_url || payload?.station?.playlist_pls_url || null,
    requestListUrl:
      payload?.station?.id != null ? `${API_ORIGIN}/api/station/${payload.station.id}/requests` : null,
    requestEnabled: Boolean(payload?.station?.requests_enabled),
  };
}

function toAbsoluteUrl(url: string) {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return `${API_ORIGIN}${url.startsWith('/') ? url : `/${url}`}`;
}

function withFreshQuery(url: string) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}rt=${Date.now()}`;
}

function buildRequestSong(entry: any): RequestSong {
  return {
    requestId: String(entry?.request_id ?? entry?.song?.id ?? Math.random()),
    requestUrl: toAbsoluteUrl(entry?.request_url ?? ''),
    title: entry?.song?.title || 'Canción disponible',
    artist: entry?.song?.artist || 'Rockstars',
    album: entry?.song?.album || '',
    text: entry?.song?.text || 'Rock sin pausas',
    coverArt: entry?.song?.art || entry?.song?.art_100 || null,
  };
}

function shuffleItems<T>(items: T[]) {
  const nextItems = [...items];

  for (let index = nextItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const currentItem = nextItems[index];
    nextItems[index] = nextItems[swapIndex];
    nextItems[swapIndex] = currentItem;
  }

  return nextItems;
}

function isActiveWebSpinner(
  playbackState: WebPlaybackState,
  shouldKeepPlaying: boolean,
  audioUnlocked: boolean,
) {
  if (!shouldKeepPlaying) {
    return false;
  }

  if (!audioUnlocked) {
    return true;
  }

  return playbackState === 'buffering' || playbackState === 'error';
}

const webPlayButtonStyle: CSSProperties = {
  width: 82,
  height: 82,
  borderRadius: 999,
  border: 'none',
  background: '#D81921',
  color: '#FFFFFF',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 12px 30px rgba(216, 25, 33, 0.35)',
};

const webPlayButtonIconStyle: CSSProperties = {
  fontSize: 26,
  fontWeight: 900,
  lineHeight: 1,
};

const webAudioElementStyle: CSSProperties = {
  display: 'none',
};

export default function App() {
  const { width } = useWindowDimensions();
  const [selectedStream, setSelectedStream] = useState<StreamKey>('high');
  const [shouldKeepPlaying, setShouldKeepPlaying] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<NowPlayingInfo>(FALLBACK_NOW_PLAYING);
  const [metadataReady, setMetadataReady] = useState(false);
  const [metadataError, setMetadataError] = useState(false);
  const [webPlaybackState, setWebPlaybackState] = useState<WebPlaybackState>('idle');
  const [webAudioUnlocked, setWebAudioUnlocked] = useState(false);
  const [activeConsoleTab, setActiveConsoleTab] = useState<'requests' | 'history'>('requests');
  const [webVolume, setWebVolume] = useState(0.75);
  const [requestSongs, setRequestSongs] = useState<RequestSong[]>([]);
  const [requestSearch, setRequestSearch] = useState('');
  const [requestPage, setRequestPage] = useState(1);
  const [requestLoading, setRequestLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestFeedback, setRequestFeedback] = useState<string | null>(null);
  const [submittingRequestId, setSubmittingRequestId] = useState<string | null>(null);

  const webAudioRef = useRef<HTMLAudioElement | null>(null);
  const appStateRef = useRef<AppStateStatus>(IS_WEB ? 'active' : AppState.currentState);
  const resumeAfterInterruptionRef = useRef(false);
  const spinnerRotation = useRef(new Animated.Value(0)).current;
  const activeStream = STREAMS[selectedStream];
  const player = useAudioPlayer(activeStream.url, {
    keepAudioSessionActive: true,
  });
  const nativeStatus = useAudioPlayerStatus(player);
  const isWideLayout = width >= 760;
  const isPhoneLayout = width < 620;
  const isCompactLayout = width < 430;
  const isExpoGo =
    !IS_WEB &&
    Constants.executionEnvironment === 'storeClient' &&
    Constants.expoVersion != null;
  const canUseNativeLockScreen = !IS_WEB && !isExpoGo;

  const safeNativePlay = () => {
    try {
      player.play();
    } catch {
      // En Expo Go preferimos no romper la UI si el stream tarda o falla al iniciar.
    }
  };

  const safeNativePause = () => {
    try {
      player.pause();
    } catch {
      // Si el player ya está detenido, no necesitamos interrumpir la experiencia.
    }
  };

  const attemptWebPlayback = async () => {
    const audio = webAudioRef.current;

    if (!audio) {
      return;
    }

    setWebPlaybackState('buffering');
    audio.muted = false;
    audio.volume = webVolume;

    try {
      await audio.play();
      setWebPlaybackState('playing');
      setWebAudioUnlocked(true);
    } catch {
      setWebPlaybackState('blocked');
    }
  };

  const forceStartWebPlayback = () => {
    const audio = webAudioRef.current;

    if (!audio) {
      return;
    }

    audio.muted = false;
    audio.volume = webVolume;

    const playPromise = audio.play();
    setShouldKeepPlaying(true);
    setWebAudioUnlocked(true);

    playPromise
      .then(() => {
        setWebPlaybackState('playing');
      })
      .catch(() => {
        setWebPlaybackState('blocked');
      });
  };

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(() => {
      // Si un dispositivo no soporta algún modo, la app sigue funcionando.
    });
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadMetadata = async () => {
      try {
        const response = await fetch(NOW_PLAYING_ENDPOINT);

        if (!response.ok) {
          throw new Error(`Metadata unavailable: ${response.status}`);
        }

        const payload = await response.json();

        if (!mounted) {
          return;
        }

        setNowPlaying(buildNowPlaying(payload));
        setMetadataReady(true);
        setMetadataError(false);
      } catch {
        if (!mounted) {
          return;
        }

        setMetadataReady(true);
        setMetadataError(true);
      }
    };

    loadMetadata();
    const timer = setInterval(loadMetadata, 15000);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!nowPlaying.requestListUrl) {
      setRequestSongs([]);
      setRequestLoading(false);
      setRequestError(null);
    }
  }, [nowPlaying.requestListUrl]);

  const loadRequestSongs = useCallback(
    async ({ silent = false, clearFeedback = false }: { silent?: boolean; clearFeedback?: boolean } = {}) => {
      if (!nowPlaying.requestListUrl) {
        return;
      }

      if (!silent) {
        setRequestLoading(true);
      }

      setRequestError(null);

      if (clearFeedback) {
        setRequestFeedback(null);
      }

      try {
        const response = await fetch(withFreshQuery(nowPlaying.requestListUrl), {
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`Request list unavailable: ${response.status}`);
        }

        const payload = await response.json();
        const nextSongs = Array.isArray(payload)
          ? shuffleItems(payload.map((entry: any) => buildRequestSong(entry)))
          : [];

        setRequestSongs(nextSongs);
      } catch {
        if (!silent) {
          setRequestError('No pudimos cargar el catálogo de pedidos.');
        }
      } finally {
        if (!silent) {
          setRequestLoading(false);
        }
      }
    },
    [nowPlaying.requestListUrl],
  );

  useEffect(() => {
    if (activeConsoleTab !== 'requests' || !nowPlaying.requestListUrl) {
      return;
    }

    void loadRequestSongs({ silent: requestSongs.length > 0 });
    const refreshTimer = setInterval(() => {
      void loadRequestSongs({ silent: true });
    }, REQUESTS_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(refreshTimer);
    };
  }, [activeConsoleTab, loadRequestSongs, nowPlaying.requestListUrl]);

  useEffect(() => {
    setRequestPage(1);
  }, [requestSearch]);

  useEffect(() => {
    if (!IS_WEB) {
      return;
    }

    const audio = webAudioRef.current;

    if (!audio) {
      return;
    }

    audio.preload = 'none';
    audio.crossOrigin = 'anonymous';
    audio.volume = webVolume;
    audio.muted = false;
    (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    audio.src = activeStream.url;

    if (shouldKeepPlaying) {
      void attemptWebPlayback();
    }

    return () => {
      audio.pause();
      audio.src = '';
    };
  }, [activeStream.url, selectedStream, shouldKeepPlaying, webVolume]);

  useEffect(() => {
    if (!IS_WEB) {
      return;
    }

    const audio = webAudioRef.current;

    if (!audio) {
      return;
    }

    audio.volume = webVolume;
    audio.muted = false;

    if (!shouldKeepPlaying) {
      audio.pause();
      setWebPlaybackState('idle');
      return;
    }

    if (audio.paused) {
      void attemptWebPlayback();
    }
  }, [shouldKeepPlaying, webVolume]);

  useEffect(() => {
    if (!IS_WEB) {
      return;
    }

    const audio = webAudioRef.current;

    if (!audio) {
      return;
    }

    audio.volume = webVolume;
  }, [webVolume]);

  useEffect(() => {
    if (
      !IS_WEB ||
      !shouldKeepPlaying ||
      !webAudioUnlocked ||
      !['buffering', 'error', 'idle', 'blocked'].includes(webPlaybackState)
    ) {
      return;
    }

    const recoveryTimer = setTimeout(() => {
      const audio = webAudioRef.current;

      if (!audio) {
        return;
      }

      void attemptWebPlayback();
    }, 1800);

    return () => {
      clearTimeout(recoveryTimer);
    };
  }, [shouldKeepPlaying, webAudioUnlocked, webPlaybackState]);

  useEffect(() => {
    if (IS_WEB) {
      return;
    }

    player.volume = webVolume;
  }, [player, webVolume]);

  useEffect(() => {
    if (!(IS_WEB ? isActiveWebSpinner(webPlaybackState, shouldKeepPlaying, webAudioUnlocked) : Boolean(nativeStatus?.isBuffering))) {
      spinnerRotation.stopAnimation();
      spinnerRotation.setValue(0);
      return;
    }

    const animation = Animated.loop(
      Animated.timing(spinnerRotation, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );

    animation.start();

    return () => {
      animation.stop();
      spinnerRotation.stopAnimation();
      spinnerRotation.setValue(0);
    };
  }, [nativeStatus?.isBuffering, shouldKeepPlaying, spinnerRotation, webAudioUnlocked, webPlaybackState]);

  useEffect(() => {
    if (IS_WEB || !shouldKeepPlaying) {
      return;
    }

    safeNativePlay();
  }, [player, selectedStream, shouldKeepPlaying]);

  useEffect(() => {
    if (IS_WEB || !shouldKeepPlaying || nativeStatus?.playing || nativeStatus?.isBuffering) {
      return;
    }

    if (resumeAfterInterruptionRef.current) {
      return;
    }

    const recoveryTimer = setTimeout(() => {
      safeNativePlay();
    }, 1800);

    return () => {
      clearTimeout(recoveryTimer);
    };
  }, [nativeStatus?.isBuffering, nativeStatus?.playing, player, selectedStream, shouldKeepPlaying]);

  useEffect(() => {
    if (IS_WEB) {
      return;
    }

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextAppState;

      if (previousState === 'active' && nextAppState !== 'active' && shouldKeepPlaying) {
        resumeAfterInterruptionRef.current = true;
        return;
      }

      if (nextAppState === 'active' && resumeAfterInterruptionRef.current && shouldKeepPlaying) {
        resumeAfterInterruptionRef.current = false;

        setTimeout(() => {
          safeNativePlay();
        }, 900);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [shouldKeepPlaying]);

  useEffect(() => {
    if (!canUseNativeLockScreen) {
      return;
    }

    if (!shouldKeepPlaying || !nativeStatus?.playing) {
      player.setActiveForLockScreen(false);
      return;
    }

    player.setActiveForLockScreen(
      true,
      {
        title: nowPlaying.songTitle,
        artist: nowPlaying.songArtist,
        albumTitle: nowPlaying.stationName,
        artworkUrl: nowPlaying.coverArt || undefined,
      },
      {
        showSeekBackward: false,
        showSeekForward: false,
      },
    );
  }, [
    canUseNativeLockScreen,
    nativeStatus?.playing,
    nowPlaying.coverArt,
    nowPlaying.songArtist,
    nowPlaying.songTitle,
    nowPlaying.stationName,
    player,
    shouldKeepPlaying,
  ]);

  useEffect(() => {
    if (!canUseNativeLockScreen || !shouldKeepPlaying || !nativeStatus?.playing) {
      return;
    }

    player.updateLockScreenMetadata({
      title: nowPlaying.songTitle,
      artist: nowPlaying.songArtist,
      albumTitle: nowPlaying.stationName,
      artworkUrl: nowPlaying.coverArt || undefined,
    });
  }, [
    canUseNativeLockScreen,
    nativeStatus?.playing,
    nowPlaying.coverArt,
    nowPlaying.songArtist,
    nowPlaying.songTitle,
    nowPlaying.stationName,
    player,
    shouldKeepPlaying,
  ]);

  useEffect(() => {
    return () => {
      if (canUseNativeLockScreen) {
        player.clearLockScreenControls();
      }
    };
  }, [canUseNativeLockScreen, player]);

  const artworkSource: ImageSourcePropType = nowPlaying.coverArt
    ? { uri: nowPlaying.coverArt }
    : DEFAULT_COVER;

  const isPlaying = IS_WEB ? webPlaybackState === 'playing' : Boolean(nativeStatus?.playing);
  const isBuffering = IS_WEB ? webPlaybackState === 'buffering' : Boolean(nativeStatus?.isBuffering);
  const autoplayBlocked = IS_WEB && webPlaybackState === 'blocked';
  const showSpinner = IS_WEB
    ? isActiveWebSpinner(webPlaybackState, shouldKeepPlaying, webAudioUnlocked)
    : Boolean(nativeStatus?.isBuffering);
  const spinnerStyle = {
    transform: [
      {
        rotate: spinnerRotation.interpolate({
          inputRange: [0, 1],
          outputRange: ['0deg', '360deg'],
        }),
      },
    ],
  };

  const playerStatusLabel = !shouldKeepPlaying
    ? 'Listo para reproducir'
    : autoplayBlocked
    ? 'Pulsa PLAY para activar el audio'
    : isBuffering
      ? 'Cargando la señal...'
      : isPlaying
        ? 'ON AIR'
        : shouldKeepPlaying
          ? 'Recuperando la señal...'
          : 'Listo para reproducir';

  const playButtonLabel = shouldKeepPlaying
      ? 'PAUSE'
      : 'PLAY';
  const requestsTabDetail = `Elige el próximo golpe de la ${getDayMomentLabel()}`;
  const normalizedRequestSearch = requestSearch.trim().toLowerCase();
  const filteredRequestSongs = normalizedRequestSearch
    ? requestSongs.filter((item) =>
        [item.title, item.artist, item.album, item.text]
          .join(' ')
          .toLowerCase()
          .includes(normalizedRequestSearch),
      )
    : requestSongs;
  const totalRequestPages = Math.max(1, Math.ceil(filteredRequestSongs.length / REQUESTS_PER_PAGE));
  const safeRequestPage = Math.min(requestPage, totalRequestPages);
  const pagedRequestSongs = filteredRequestSongs.slice(
    (safeRequestPage - 1) * REQUESTS_PER_PAGE,
    safeRequestPage * REQUESTS_PER_PAGE,
  );

  const handleOpenUrl = (url: string | null) => {
    if (!url) {
      return;
    }

    Linking.openURL(url).catch(() => {
      // Si no se puede abrir, simplemente no interrumpimos la experiencia.
    });
  };

  const handleTogglePlayback = () => {
    if (autoplayBlocked) {
      forceStartWebPlayback();
      return;
    }

    if (shouldKeepPlaying) {
      setShouldKeepPlaying(false);

      if (IS_WEB) {
        webAudioRef.current?.pause();
      } else {
        safeNativePause();
      }

      return;
    }

    setShouldKeepPlaying(true);

    if (IS_WEB) {
      forceStartWebPlayback();
    } else {
      player.play();
    }
  };

  const handleSelectStream = (nextStream: StreamKey) => {
    if (nextStream === selectedStream) {
      return;
    }

    if (!IS_WEB && shouldKeepPlaying) {
      safeNativePause();
    }

    setSelectedStream(nextStream);
  };

  const handleOpenRequestTab = () => {
    setActiveConsoleTab('requests');
    setRequestFeedback(null);
    void loadRequestSongs({ silent: requestSongs.length > 0 });
  };

  const handleRefreshRequests = async () => {
    await loadRequestSongs({ clearFeedback: true });
  };

  const handleSubmitRequest = async (item: RequestSong) => {
    if (!item.requestUrl) {
      return;
    }

    setSubmittingRequestId(item.requestId);
    setRequestFeedback(null);
    setRequestError(null);

    try {
      const response = await fetch(item.requestUrl, {
        method: 'POST',
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.success) {
        throw new Error(payload?.message || `Request failed: ${response.status}`);
      }

      setRequestFeedback(`Listo: ${item.title} quedó solicitada para sonar pronto.`);
      void loadRequestSongs({ silent: true });
    } catch {
      setRequestError('No pudimos enviar el pedido. Intenta de nuevo en unos segundos.');
    } finally {
      setSubmittingRequestId(null);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />

      <ImageBackground
        source={STAGE_BACKGROUND}
        resizeMode="cover"
        style={styles.wallBackdrop}
        imageStyle={styles.wallBackdropImage}
      >
        <View style={styles.wallVignette} />
      </ImageBackground>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, isPhoneLayout && styles.scrollContentPhone]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.pageShell, isPhoneLayout && styles.pageShellPhone]}>
          <View style={[styles.heroPanel, isPhoneLayout && styles.heroPanelPhone]}>
            <Image
              source={DEFAULT_COVER}
              resizeMode="contain"
              style={[
                styles.logoCentered,
                isPhoneLayout && styles.logoCenteredPhone,
                isCompactLayout && styles.logoCenteredCompact,
              ]}
              accessibilityLabel="Logo de Rockstars"
            />
            <Text
              style={[
                styles.heroSubtitleCentered,
                isPhoneLayout && styles.heroSubtitleCenteredPhone,
              ]}
            >
              ¡La radio que inmortaliza el Rock!
            </Text>
          </View>

          <View style={styles.playerDeck}>
            <View
              style={[
                styles.playerStrip,
                !isWideLayout && styles.playerStripStacked,
                isPhoneLayout && styles.playerStripPhone,
              ]}
            >
              <Image
                source={artworkSource}
                style={[styles.playerArtwork, isPhoneLayout && styles.playerArtworkPhone]}
                resizeMode="cover"
              />

              <View style={[styles.playerStripMain, isPhoneLayout && styles.playerStripMainPhone]}>
                <View style={[styles.playerStripTop, isPhoneLayout && styles.playerStripTopPhone]}>
                  <View style={styles.signalBadge}>
                    {showSpinner ? (
                      <Animated.View style={[styles.loadingSpinner, spinnerStyle]} />
                    ) : (
                      <View style={styles.signalDot} />
                    )}
                    <Text style={styles.signalBadgeText}>{SIGNAL_COPY}</Text>
                  </View>
                  <Text style={[styles.playerUpdatedText, isPhoneLayout && styles.playerUpdatedTextPhone]}>
                    {playerStatusLabel}
                  </Text>
                </View>

                <Text style={[styles.playerSongTitle, isPhoneLayout && styles.playerSongTitlePhone]} numberOfLines={2}>
                  {nowPlaying.songTitle}
                </Text>
                <Text style={[styles.playerSongArtist, isPhoneLayout && styles.playerSongArtistPhone]} numberOfLines={1}>
                  {nowPlaying.songArtist}
                </Text>
                <Text style={[styles.playerSongCopy, isPhoneLayout && styles.playerSongCopyPhone]} numberOfLines={2}>
                  {nowPlaying.songText}
                </Text>

                <View style={[styles.progressMetaRow, isCompactLayout && styles.progressMetaRowCompact]}>
                  <Text style={styles.progressMetaLabel}>Tema actual</Text>
                  <Text style={styles.progressMetaTime}>
                    {formatSongClock(nowPlaying.elapsed)} / {formatSongClock(nowPlaying.duration)}
                  </Text>
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressTrackFill,
                      { width: `${nowPlaying.progressPercent}%` },
                    ]}
                  />
                </View>

                <View style={[styles.playerUtilityRow, isPhoneLayout && styles.playerUtilityRowPhone]}>
                  <View style={styles.streamToggleRow}>
                    {(Object.keys(STREAMS) as StreamKey[]).map((streamKey) => {
                      const stream = STREAMS[streamKey];
                      const isSelected = streamKey === selectedStream;

                      return (
                        <Pressable
                          key={streamKey}
                          onPress={() => handleSelectStream(streamKey)}
                          style={({ pressed }) => [
                            styles.streamPillCompact,
                            isPhoneLayout && styles.streamPillCompactPhone,
                            isSelected && styles.streamPillActive,
                            pressed && styles.streamPillPressed,
                          ]}
                        >
                          <Text
                            style={[
                              styles.streamPillLabel,
                              isPhoneLayout && styles.streamPillLabelPhone,
                              isSelected && styles.streamPillLabelActive,
                            ]}
                          >
                            {stream.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  {IS_WEB ? (
                    <View style={styles.volumeInline}>
                      <Text style={styles.volumeLabel}>Volumen</Text>
                      {createElement('input', {
                        type: 'range',
                        min: 0,
                        max: 100,
                        value: Math.round(webVolume * 100),
                        onChange: (event: Event) => {
                          const target = event.target as HTMLInputElement;
                          setWebVolume(Number(target.value) / 100);
                        },
                        style: {
                          width: '100%',
                          accentColor: '#D81921',
                          cursor: 'pointer',
                        } as CSSProperties,
                      })}
                    </View>
                  ) : null}
                </View>
              </View>

              <View
                style={[
                  styles.playerActionColumn,
                  !isWideLayout && styles.playerActionColumnStacked,
                  isPhoneLayout && styles.playerActionColumnPhone,
                ]}
              >
                {IS_WEB
                  ? createElement(
                      'button',
                      {
                        type: 'button',
                        onClick: handleTogglePlayback,
                        style: webPlayButtonStyle,
                      },
                      createElement(
                        'span',
                        { style: webPlayButtonIconStyle },
                        shouldKeepPlaying && !autoplayBlocked ? 'II' : '▶',
                      ),
                    )
                  : (
                      <Pressable
                        onPress={handleTogglePlayback}
                        style={({ pressed }) => [
                          styles.playButton,
                          isPhoneLayout && styles.playButtonPhone,
                          pressed && styles.playButtonPressed,
                        ]}
                      >
                        <Text style={[styles.playButtonIcon, isPhoneLayout && styles.playButtonIconPhone]}>
                          {shouldKeepPlaying && !autoplayBlocked ? 'II' : '▶'}
                        </Text>
                      </Pressable>
                    )}
                <Text
                  style={[
                    styles.inlinePlayButtonLabel,
                    isPhoneLayout && styles.inlinePlayButtonLabelPhone,
                  ]}
                >
                  {playButtonLabel}
                </Text>
              </View>

              {IS_WEB
                ? createElement('audio', {
                    ref: (element: HTMLAudioElement | null) => {
                      webAudioRef.current = element;
                    },
                    preload: 'none',
                    style: webAudioElementStyle,
                    onPlay: () => {
                      setShouldKeepPlaying(true);
                      setWebAudioUnlocked(true);
                      setWebPlaybackState('playing');
                    },
                    onPause: () => {
                      setShouldKeepPlaying(false);
                      setWebPlaybackState('idle');
                    },
                    onLoadStart: () => setWebPlaybackState('buffering'),
                    onWaiting: () => setWebPlaybackState('buffering'),
                    onStalled: () => setWebPlaybackState('buffering'),
                    onCanPlay: () => {
                      setWebPlaybackState(shouldKeepPlaying ? 'playing' : 'idle');
                    },
                    onPlaying: () => {
                      setWebPlaybackState('playing');
                    },
                    onError: () => setWebPlaybackState('error'),
                  })
                : null}
            </View>

            <View style={[styles.consoleTabsCard, isPhoneLayout && styles.consoleTabsCardPhone]}>
              <View style={[styles.tabRow, isPhoneLayout && styles.tabRowPhone]}>
                <Pressable
                  onPress={handleOpenRequestTab}
                  style={({ pressed }) => [
                    styles.tabButton,
                    isPhoneLayout && styles.tabButtonPhone,
                    activeConsoleTab === 'requests' && styles.tabButtonActive,
                    pressed && styles.tabButtonPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.tabButtonLabel,
                      isPhoneLayout && styles.tabButtonLabelPhone,
                      activeConsoleTab === 'requests' && styles.tabButtonLabelActive,
                    ]}
                  >
                    Pedidos
                  </Text>
                  <Text
                    style={[
                      styles.tabButtonDetail,
                      isPhoneLayout && styles.tabButtonDetailPhone,
                      activeConsoleTab === 'requests' && styles.tabButtonDetailActive,
                    ]}
                  >
                    {requestsTabDetail}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => setActiveConsoleTab('history')}
                  style={({ pressed }) => [
                    styles.tabButton,
                    isPhoneLayout && styles.tabButtonPhone,
                    activeConsoleTab === 'history' && styles.tabButtonActive,
                    pressed && styles.tabButtonPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.tabButtonLabel,
                      isPhoneLayout && styles.tabButtonLabelPhone,
                      activeConsoleTab === 'history' && styles.tabButtonLabelActive,
                    ]}
                  >
                    Historial
                  </Text>
                  <Text
                    style={[
                      styles.tabButtonDetail,
                      isPhoneLayout && styles.tabButtonDetailPhone,
                      activeConsoleTab === 'history' && styles.tabButtonDetailActive,
                    ]}
                  >
                    Últimos 15 temas que han sonado
                  </Text>
                </Pressable>
              </View>

              {activeConsoleTab === 'requests' ? (
                <View style={[styles.inlinePanel, isPhoneLayout && styles.inlinePanelPhone]}>
                  <View style={[styles.requestToolbar, isPhoneLayout && styles.requestToolbarStacked]}>
                    <View style={[styles.requestSearchBox, isPhoneLayout && styles.requestSearchBoxPhone]}>
                      <TextInput
                        value={requestSearch}
                        onChangeText={setRequestSearch}
                        placeholder="Busca artista, canción o álbum"
                        placeholderTextColor="#7D7D7D"
                        style={styles.requestSearchInput}
                      />
                    </View>

                    <Pressable
                      onPress={() => {
                        void handleRefreshRequests();
                      }}
                      style={({ pressed }) => [
                        styles.requestToolbarButton,
                        isPhoneLayout && styles.requestToolbarButtonPhone,
                        pressed && styles.actionButtonPressed,
                      ]}
                    >
                      <Text style={styles.requestToolbarButtonText}>Recargar</Text>
                    </Pressable>
                  </View>

                  <View style={[styles.requestPagerRow, isPhoneLayout && styles.requestPagerRowPhone]}>
                    <Text style={styles.requestPagerText}>
                      Página {safeRequestPage} de {totalRequestPages}
                    </Text>
                    <View style={[styles.requestPagerButtons, isCompactLayout && styles.requestPagerButtonsPhone]}>
                      <Pressable
                        onPress={() => setRequestPage((current) => Math.max(1, current - 1))}
                        style={({ pressed }) => [
                          styles.requestPagerButton,
                          isCompactLayout && styles.requestPagerButtonPhone,
                          safeRequestPage === 1 && styles.requestPagerButtonDisabled,
                          pressed && safeRequestPage > 1 && styles.actionButtonPressed,
                        ]}
                        disabled={safeRequestPage === 1}
                      >
                        <Text style={styles.requestPagerButtonText}>Anterior</Text>
                      </Pressable>

                      <Pressable
                        onPress={() =>
                          setRequestPage((current) => Math.min(totalRequestPages, current + 1))
                        }
                        style={({ pressed }) => [
                          styles.requestPagerButton,
                          isCompactLayout && styles.requestPagerButtonPhone,
                          safeRequestPage === totalRequestPages && styles.requestPagerButtonDisabled,
                          pressed && safeRequestPage < totalRequestPages && styles.actionButtonPressed,
                        ]}
                        disabled={safeRequestPage === totalRequestPages}
                      >
                        <Text style={styles.requestPagerButtonText}>Siguiente</Text>
                      </Pressable>
                    </View>
                  </View>

                  {requestFeedback ? (
                    <View style={styles.requestFeedbackSuccess}>
                      <Text style={styles.requestFeedbackText}>{requestFeedback}</Text>
                    </View>
                  ) : null}

                  {requestError ? (
                    <View style={styles.requestFeedbackError}>
                      <Text style={styles.requestFeedbackText}>{requestError}</Text>
                    </View>
                  ) : null}

                  {requestLoading ? (
                    <Text style={styles.requestLoadingText}>Cargando catálogo de pedidos...</Text>
                  ) : (
                    <ScrollView
                      style={[styles.requestList, isPhoneLayout && styles.requestListPhone]}
                      contentContainerStyle={styles.requestListContent}
                    >
                      {pagedRequestSongs.length > 0 ? (
                        pagedRequestSongs.map((item) => (
                          <View key={item.requestId} style={[styles.requestRow, isPhoneLayout && styles.requestRowPhone]}>
                            <Image
                              source={item.coverArt ? { uri: item.coverArt } : DEFAULT_COVER}
                              style={[styles.requestArtwork, isPhoneLayout && styles.requestArtworkPhone]}
                            />

                            <View style={[styles.requestSongCopy, isPhoneLayout && styles.requestSongCopyPhone]}>
                              <Text style={[styles.requestSongTitle, isPhoneLayout && styles.requestSongTitlePhone]} numberOfLines={1}>
                                {item.title}
                              </Text>
                              <Text style={[styles.requestSongArtist, isPhoneLayout && styles.requestSongArtistPhone]} numberOfLines={1}>
                                {item.artist}
                              </Text>
                              {item.album ? (
                                <Text style={styles.requestSongAlbum} numberOfLines={1}>
                                  {item.album}
                                </Text>
                              ) : null}
                            </View>

                            <Pressable
                              onPress={() => {
                                void handleSubmitRequest(item);
                              }}
                              style={({ pressed }) => [
                                styles.requestActionButton,
                                isPhoneLayout && styles.requestActionButtonPhone,
                                pressed && styles.actionButtonPressed,
                                submittingRequestId === item.requestId && styles.requestActionButtonDisabled,
                              ]}
                              disabled={submittingRequestId === item.requestId}
                            >
                              <Text style={styles.requestActionButtonText}>
                                {submittingRequestId === item.requestId ? 'Enviando...' : 'Solicitar'}
                              </Text>
                            </Pressable>
                          </View>
                        ))
                      ) : (
                        <View style={styles.requestEmptyState}>
                          <Text style={styles.requestEmptyTitle}>Sin resultados</Text>
                          <Text style={styles.requestEmptyCopy}>
                            Prueba con otro artista, canción o álbum.
                          </Text>
                        </View>
                      )}
                    </ScrollView>
                  )}
                </View>
              ) : (
                <View style={[styles.inlinePanel, isPhoneLayout && styles.inlinePanelPhone]}>
                  <Text style={[styles.historyHeading, isPhoneLayout && styles.historyHeadingPhone]}>
                    Últimas canciones al aire
                  </Text>
                  <Text style={[styles.historySubheading, isPhoneLayout && styles.historySubheadingPhone]}>
                    Recorre los temas que han pasado por la cabina.
                  </Text>

                  <ScrollView
                    style={[styles.requestList, isPhoneLayout && styles.requestListPhone]}
                    contentContainerStyle={styles.requestListContent}
                  >
                    {nowPlaying.history.length > 0 ? (
                      nowPlaying.history.map((item) => (
                        <View key={item.id} style={[styles.historyHeroItem, isPhoneLayout && styles.historyHeroItemPhone]}>
                          <Image
                            source={item.coverArt ? { uri: item.coverArt } : DEFAULT_COVER}
                            style={[styles.historyHeroArtwork, isPhoneLayout && styles.historyHeroArtworkPhone]}
                          />
                          <View style={[styles.historyHeroCopy, isPhoneLayout && styles.historyHeroCopyPhone]}>
                            <Text style={[styles.historyTitle, isPhoneLayout && styles.historyTitlePhone]} numberOfLines={1}>
                              {item.title}
                            </Text>
                            <Text style={[styles.historyArtist, isPhoneLayout && styles.historyArtistPhone]} numberOfLines={1}>
                              {item.artist}
                            </Text>
                            <Text style={styles.historyHeroMeta} numberOfLines={1}>
                              {item.text}
                            </Text>
                          </View>
                          <Text style={[styles.historyTime, isPhoneLayout && styles.historyTimePhone]}>
                            {item.playedLabel}
                          </Text>
                        </View>
                      ))
                    ) : (
                      <View style={styles.requestEmptyState}>
                        <Text style={styles.requestEmptyTitle}>Sin historial disponible</Text>
                        <Text style={styles.requestEmptyCopy}>
                          La metadata irá llenando esta sección en cuanto lleguen más temas.
                        </Text>
                      </View>
                    )}
                  </ScrollView>
                </View>
              )}
            </View>

            <View style={[styles.footerPlateScene, isPhoneLayout && styles.footerPlateScenePhone]}>
              <View style={styles.footerPlate}>
                <View style={styles.footerPlateInner}>
                  <Text
                    style={[styles.footerManifesto, isPhoneLayout && styles.footerManifestoPhone]}
                    numberOfLines={isPhoneLayout ? 2 : 1}
                  >
                    <Text style={styles.footerManifestoHighlight}>Rockstars</Text> para quienes viven el rock como un <Text style={styles.footerManifestoHighlight}>estilo de vida</Text>, no como una moda pasajera.
                  </Text>
                  <View style={[styles.footerUnderline, isPhoneLayout && styles.footerUnderlinePhone]}>
                    <View style={[styles.footerUnderlineOuter, isPhoneLayout && styles.footerUnderlineOuterPhone]} />
                    <View style={[styles.footerUnderlineMid, isPhoneLayout && styles.footerUnderlineMidPhone]} />
                    <View style={[styles.footerUnderlineCore, isPhoneLayout && styles.footerUnderlineCorePhone]} />
                    <View style={[styles.footerUnderlineMid, isPhoneLayout && styles.footerUnderlineMidPhone]} />
                    <View style={[styles.footerUnderlineOuter, isPhoneLayout && styles.footerUnderlineOuterPhone]} />
                  </View>
                </View>
              </View>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#050505',
  },
  wallBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#120C0C',
  },
  wallBackdropImage: {
    opacity: 0.5,
  },
  wallVignette: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.54)',
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 36,
  },
  scrollContentPhone: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 24,
  },
  pageShell: {
    width: '100%',
    maxWidth: 1120,
    alignSelf: 'center',
    gap: 24,
  },
  pageShellPhone: {
    gap: 18,
  },
  heroPanel: {
    borderRadius: 34,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 6,
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 0,
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  heroPanelPhone: {
    paddingHorizontal: 4,
    paddingTop: 8,
    paddingBottom: 2,
  },
  liveChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(216, 25, 33, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(216, 25, 33, 0.48)',
  },
  liveDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: '#FF4A52',
  },
  liveChipText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  liveChipCentered: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(216, 25, 33, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(216, 25, 33, 0.48)',
  },
  logo: {
    width: '100%',
    height: 188,
    marginTop: 18,
  },
  logoCentered: {
    width: '100%',
    maxWidth: 340,
    height: 220,
    marginTop: 20,
  },
  logoCenteredPhone: {
    maxWidth: 260,
    height: 168,
    marginTop: 8,
  },
  logoCenteredCompact: {
    maxWidth: 230,
    height: 148,
  },
  heroTitle: {
    marginTop: 12,
    color: '#FFFFFF',
    fontSize: 40,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  heroSubtitle: {
    marginTop: 6,
    color: '#FF4A52',
    fontSize: 22,
    fontWeight: '800',
  },
  heroTitleCentered: {
    marginTop: 8,
    color: '#FFFFFF',
    fontSize: 54,
    fontWeight: '900',
    letterSpacing: 1.4,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  heroSubtitleCentered: {
    marginTop: 2,
    color: '#FF2D38',
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 0.2,
    textShadowColor: 'rgba(216, 25, 33, 0.35)',
    textShadowOffset: { width: 0, height: 6 },
    textShadowRadius: 14,
  },
  heroSubtitleCenteredPhone: {
    marginTop: 0,
    fontSize: 18,
    lineHeight: 24,
    paddingHorizontal: 18,
  },
  heroManifesto: {
    marginTop: 14,
    color: '#E8E8E8',
    fontSize: 17,
    lineHeight: 27,
    maxWidth: 760,
  },
  playerDeck: {
    gap: 22,
  },
  playerStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    padding: 18,
    borderRadius: 30,
    backgroundColor: 'rgba(9, 9, 12, 0.94)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    shadowColor: '#D81921',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  playerStripStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  playerStripPhone: {
    gap: 14,
    padding: 14,
    borderRadius: 24,
  },
  playerArtwork: {
    width: 130,
    height: 130,
    borderRadius: 26,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  playerArtworkPhone: {
    width: 92,
    height: 92,
    borderRadius: 20,
    alignSelf: 'center',
  },
  playerStripMain: {
    flex: 1,
    gap: 6,
  },
  playerStripMainPhone: {
    gap: 4,
  },
  playerStripTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
  playerStripTopPhone: {
    alignItems: 'flex-start',
    gap: 8,
  },
  playerUpdatedText: {
    color: '#B8B8B8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  playerUpdatedTextPhone: {
    fontSize: 10,
  },
  playerSongTitle: {
    marginTop: 4,
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '900',
  },
  playerSongTitlePhone: {
    marginTop: 2,
    fontSize: 22,
    lineHeight: 26,
  },
  playerSongArtist: {
    color: '#F2F2F2',
    fontSize: 18,
    fontWeight: '700',
  },
  playerSongArtistPhone: {
    fontSize: 15,
  },
  playerSongCopy: {
    color: '#BFBFBF',
    fontSize: 13,
    lineHeight: 18,
  },
  playerSongCopyPhone: {
    fontSize: 12,
    lineHeight: 17,
  },
  playerUtilityRow: {
    marginTop: 10,
    gap: 12,
  },
  playerUtilityRowPhone: {
    marginTop: 8,
    gap: 10,
  },
  volumeInline: {
    gap: 8,
  },
  playerActionColumn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minWidth: 94,
  },
  playerActionColumnStacked: {
    alignSelf: 'center',
  },
  playerActionColumnPhone: {
    minWidth: 0,
    alignSelf: 'center',
    gap: 8,
  },
  coverArt: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  coverShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(5, 5, 5, 0.6)',
  },
  stageLightLeft: {
    position: 'absolute',
    top: -80,
    left: 40,
    width: 160,
    height: 240,
    borderRadius: 80,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    transform: [{ rotate: '14deg' }],
  },
  stageLightRight: {
    position: 'absolute',
    top: -70,
    right: 30,
    width: 170,
    height: 250,
    borderRadius: 85,
    backgroundColor: 'rgba(216, 25, 33, 0.18)',
    transform: [{ rotate: '-16deg' }],
  },
  vinylRingOuter: {
    position: 'absolute',
    top: '16%',
    alignSelf: 'center',
    width: 230,
    height: 230,
    borderRadius: 115,
    borderWidth: 2,
    borderColor: 'rgba(216, 25, 33, 0.28)',
  },
  vinylRingInner: {
    position: 'absolute',
    top: '22%',
    alignSelf: 'center',
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
  },
  playButton: {
    width: 82,
    height: 82,
    borderRadius: 41,
    backgroundColor: '#D81921',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#D81921',
    shadowOpacity: 0.38,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  playButtonPhone: {
    width: 74,
    height: 74,
    borderRadius: 37,
  },
  playButtonPressed: {
    opacity: 0.86,
    transform: [{ scale: 0.98 }],
  },
  playButtonIcon: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '900',
    marginLeft: 2,
  },
  playButtonIconPhone: {
    fontSize: 23,
  },
  playButtonLabel: {
    position: 'absolute',
    top: '48%',
    alignSelf: 'center',
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  artFooter: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: 24,
    paddingBottom: 24,
    gap: 6,
  },
  artEyebrow: {
    color: '#FF5D64',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  songTitle: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '900',
  },
  songArtist: {
    color: '#F2F2F2',
    fontSize: 20,
    fontWeight: '700',
  },
  songText: {
    color: '#D1D1D1',
    fontSize: 14,
    lineHeight: 20,
  },
  controlRack: {
    gap: 18,
  },
  signalBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  signalDot: {
    width: 9,
    height: 9,
    borderRadius: 999,
    backgroundColor: '#2AE78B',
  },
  signalBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  inlinePlayButtonLabel: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  inlinePlayButtonLabelPhone: {
    fontSize: 12,
  },
  statusCard: {
    padding: 22,
    borderRadius: 28,
    backgroundColor: 'rgba(8, 8, 10, 0.84)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  statusHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  sectionLabel: {
    color: '#A1A1A1',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  loadingSpinner: {
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    borderTopColor: '#D81921',
  },
  statusValue: {
    marginTop: 10,
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '900',
  },
  statusHint: {
    marginTop: 8,
    color: '#C2C2C2',
    fontSize: 14,
    lineHeight: 20,
  },
  statusMicrocopy: {
    marginTop: 10,
    color: '#B0B0B0',
    fontSize: 13,
    lineHeight: 19,
  },
  progressMetaRow: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  progressMetaRowCompact: {
    marginTop: 14,
    flexWrap: 'wrap',
  },
  progressMetaLabel: {
    color: '#ECECEC',
    fontSize: 13,
    fontWeight: '700',
  },
  progressMetaTime: {
    color: '#A9A9A9',
    fontSize: 12,
    fontWeight: '700',
  },
  progressTrack: {
    marginTop: 10,
    height: 7,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  progressTrackFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#D81921',
  },
  utilityRow: {
    marginTop: 18,
    gap: 16,
  },
  streamToggleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  streamPill: {
    minWidth: 150,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  streamPillCompact: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  streamPillCompactPhone: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streamPillActive: {
    backgroundColor: 'rgba(216, 25, 33, 0.16)',
    borderColor: 'rgba(216, 25, 33, 0.54)',
  },
  streamPillPressed: {
    opacity: 0.86,
  },
  streamPillLabel: {
    color: '#F2F2F2',
    fontSize: 14,
    fontWeight: '800',
  },
  streamPillLabelPhone: {
    fontSize: 13,
  },
  streamPillLabelActive: {
    color: '#FFFFFF',
  },
  streamPillDetail: {
    marginTop: 3,
    color: '#A7A7A7',
    fontSize: 11,
    fontWeight: '600',
  },
  streamPillDetailActive: {
    color: '#FFD5D8',
  },
  volumeBlock: {
    gap: 8,
  },
  volumeLabel: {
    color: '#BDBDBD',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  consoleTabsCard: {
    padding: 24,
    borderRadius: 30,
    backgroundColor: 'rgba(9, 9, 12, 0.95)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    shadowColor: '#D81921',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  consoleTabsCardPhone: {
    padding: 16,
    borderRadius: 24,
  },
  tabRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  tabRowPhone: {
    gap: 8,
  },
  tabButton: {
    flex: 1,
    minWidth: 220,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  tabButtonPhone: {
    minWidth: 0,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
  },
  tabButtonActive: {
    backgroundColor: 'rgba(216, 25, 33, 0.16)',
    borderColor: 'rgba(216, 25, 33, 0.44)',
  },
  tabButtonPressed: {
    opacity: 0.88,
  },
  tabButtonLabel: {
    color: '#F5F5F5',
    fontSize: 16,
    fontWeight: '900',
  },
  tabButtonLabelPhone: {
    fontSize: 15,
  },
  tabButtonLabelActive: {
    color: '#FFFFFF',
  },
  tabButtonDetail: {
    marginTop: 4,
    color: '#A7A7A7',
    fontSize: 12,
    lineHeight: 17,
  },
  tabButtonDetailPhone: {
    fontSize: 11,
    lineHeight: 15,
  },
  tabButtonDetailActive: {
    color: '#FFD0D3',
  },
  inlinePanel: {
    marginTop: 18,
  },
  inlinePanelPhone: {
    marginTop: 14,
  },
  actionRow: {
    marginTop: 18,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  actionButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  actionButtonPressed: {
    opacity: 0.84,
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  historyPanel: {
    marginTop: 18,
    gap: 10,
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  historyArtwork: {
    width: 46,
    height: 46,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  historyCopy: {
    flex: 1,
    gap: 2,
  },
  historyTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  historyArtist: {
    color: '#B9B9B9',
    fontSize: 12,
    fontWeight: '600',
  },
  historyTime: {
    color: '#8F8F8F',
    fontSize: 11,
    fontWeight: '700',
  },
  historyHeading: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '900',
  },
  historyHeadingPhone: {
    fontSize: 20,
  },
  historySubheading: {
    marginTop: 6,
    color: '#A9A9A9',
    fontSize: 13,
    lineHeight: 19,
  },
  historySubheadingPhone: {
    fontSize: 12,
    lineHeight: 17,
  },
  historyHeroItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  historyHeroItemPhone: {
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  historyHeroArtwork: {
    width: 54,
    height: 54,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  historyHeroArtworkPhone: {
    width: 48,
    height: 48,
  },
  historyHeroCopy: {
    flex: 1,
    gap: 3,
  },
  historyHeroCopyPhone: {
    minWidth: 0,
  },
  historyHeroMeta: {
    color: '#8B8B8B',
    fontSize: 11,
    fontWeight: '600',
  },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 24,
    zIndex: 50,
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
  },
  requestModal: {
    width: '100%',
    maxWidth: 940,
    maxHeight: '88%',
    borderRadius: 28,
    padding: 22,
    backgroundColor: 'rgba(14, 14, 18, 0.98)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  requestModalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  requestModalTitle: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '900',
  },
  requestModalSubtitle: {
    marginTop: 4,
    color: '#B9B9B9',
    fontSize: 14,
    lineHeight: 20,
  },
  modalCloseButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  modalCloseButtonText: {
    color: '#FFFFFF',
    fontSize: 26,
    lineHeight: 28,
    fontWeight: '700',
  },
  requestToolbar: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  requestToolbarStacked: {
    marginTop: 16,
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 10,
  },
  requestSearchBox: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    paddingHorizontal: 14,
  },
  requestSearchBoxPhone: {
    width: '100%',
  },
  requestSearchInput: {
    color: '#FFFFFF',
    fontSize: 15,
    paddingVertical: 12,
  },
  requestToolbarButton: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  requestToolbarButtonPhone: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  requestToolbarButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  requestPagerRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  requestPagerRowPhone: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 10,
  },
  requestPagerText: {
    color: '#B6B6B6',
    fontSize: 13,
    fontWeight: '700',
  },
  requestPagerButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  requestPagerButtonsPhone: {
    width: '100%',
  },
  requestPagerButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  requestPagerButtonPhone: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  requestPagerButtonDisabled: {
    opacity: 0.4,
  },
  requestPagerButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  requestFeedbackSuccess: {
    marginTop: 16,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: 'rgba(26, 124, 74, 0.22)',
    borderWidth: 1,
    borderColor: 'rgba(71, 196, 124, 0.42)',
  },
  requestFeedbackError: {
    marginTop: 16,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: 'rgba(216, 25, 33, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(216, 25, 33, 0.34)',
  },
  requestFeedbackText: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
  },
  requestLoadingText: {
    marginTop: 22,
    color: '#D7D7D7',
    fontSize: 15,
    fontWeight: '700',
  },
  requestList: {
    marginTop: 18,
    maxHeight: 520,
  },
  requestListPhone: {
    maxHeight: 470,
  },
  requestListContent: {
    gap: 10,
    paddingBottom: 8,
  },
  requestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  requestRowPhone: {
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  requestArtwork: {
    width: 54,
    height: 54,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  requestArtworkPhone: {
    width: 48,
    height: 48,
  },
  requestSongCopy: {
    flex: 1,
    gap: 2,
  },
  requestSongCopyPhone: {
    minWidth: 0,
  },
  requestSongTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  requestSongTitlePhone: {
    fontSize: 14,
  },
  requestSongArtist: {
    color: '#D1D1D1',
    fontSize: 13,
    fontWeight: '700',
  },
  requestSongArtistPhone: {
    fontSize: 12,
  },
  requestSongAlbum: {
    color: '#888888',
    fontSize: 11,
    fontWeight: '600',
  },
  requestActionButton: {
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: '#D81921',
  },
  requestActionButtonPhone: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  requestActionButtonDisabled: {
    opacity: 0.72,
  },
  requestActionButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  requestEmptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 8,
  },
  requestEmptyTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
  },
  requestEmptyCopy: {
    color: '#A7A7A7',
    fontSize: 14,
  },
  footerPlateScene: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  footerPlateScenePhone: {
    paddingTop: 2,
    paddingBottom: 8,
  },
  footerPlate: {
    width: '100%',
    maxWidth: 1040,
  },
  footerPlateInner: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  footerManifesto: {
    color: '#E9E9E9',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 0.1,
  },
  footerManifestoPhone: {
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 10,
  },
  footerManifestoHighlight: {
    fontWeight: '900',
    color: '#FFFFFF',
  },
  footerUnderline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
  },
  footerUnderlinePhone: {
    gap: 4,
    marginTop: 8,
  },
  footerUnderlineOuter: {
    width: 90,
    height: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 45, 56, 0.18)',
  },
  footerUnderlineOuterPhone: {
    width: 34,
  },
  footerUnderlineMid: {
    width: 58,
    height: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 45, 56, 0.42)',
  },
  footerUnderlineMidPhone: {
    width: 24,
  },
  footerUnderlineCore: {
    width: 140,
    height: 3,
    borderRadius: 999,
    backgroundColor: '#FF2D38',
  },
  footerUnderlineCorePhone: {
    width: 68,
  },
  historyTitlePhone: {
    fontSize: 13,
  },
  historyArtistPhone: {
    fontSize: 11,
  },
  historyTimePhone: {
    width: '100%',
    marginLeft: 62,
    marginTop: 4,
    fontSize: 10,
  },
});
