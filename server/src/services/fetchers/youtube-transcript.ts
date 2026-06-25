// YouTube transcript fetching via RapidAPI yt-api

const RAPIDAPI_HOST = 'yt-api.p.rapidapi.com';

export function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
      if (parsed.pathname === '/watch') {
        const id = parsed.searchParams.get('v');
        return id && /^[\w-]{11}$/.test(id) ? id : null;
      }
      const shortMatch = parsed.pathname.match(/^\/(?:embed|v|shorts)\/([\w-]{11})/);
      if (shortMatch) return shortMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

export function isYoutubeVideoUrl(url: string): boolean {
  return extractVideoId(url) !== null;
}

interface SubtitleTrack {
  languageName: string;
  languageCode: string;
  url: string;
  isTranslatable?: boolean;
}

// Decode XML/HTML entities (timedtext double-encodes some, e.g. &amp;#39;).
function decodeEntities(input: string): string {
  const once = (s: string): string => s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return once(once(input));
}

export async function fetchYoutubeTranscript(
  videoId: string,
  rapidApiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const timeoutSignal = signal ?? AbortSignal.timeout(30000);
  // yt-api exposes available subtitle tracks (each with a timedtext URL),
  // not the transcript text directly. Fetch the track list, then the XML.
  const url = `https://${RAPIDAPI_HOST}/subtitles?id=${encodeURIComponent(videoId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-rapidapi-key': rapidApiKey,
      'x-rapidapi-host': RAPIDAPI_HOST,
    },
    signal: timeoutSignal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RapidAPI subtitles error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const tracks = data.subtitles as SubtitleTrack[] | undefined;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('No transcript available for this video');
  }

  // Prefer a manual/auto English track, else fall back to the first available.
  const track = tracks.find((t) => t.languageCode === 'en')
    ?? tracks.find((t) => t.languageCode?.startsWith('en'))
    ?? tracks[0];

  const ttRes = await fetch(track.url, { signal: timeoutSignal });
  if (!ttRes.ok) {
    throw new Error(`YouTube timedtext error ${ttRes.status}`);
  }
  const xml = await ttRes.text();
  const segments = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => decodeEntities(m[1]));

  const transcript = segments.join(' ').replace(/\s+/g, ' ').trim();
  if (!transcript) {
    throw new Error('No transcript available for this video');
  }
  return transcript;
}

interface YoutubeVideoMeta {
  title: string;
  author: string | null;
  thumbnailUrl: string | null;
}

export async function fetchYoutubeMetadata(
  videoId: string,
  signal?: AbortSignal,
): Promise<YoutubeVideoMeta> {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
  try {
    const res = await fetch(oembedUrl, {
      signal: signal ?? AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      return {
        title: data.title || `YouTube Video ${videoId}`,
        author: data.author_name || null,
        thumbnailUrl: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };
    }
  } catch {
    // oEmbed failed, fall back to static thumbnail
  }

  return {
    title: `YouTube Video ${videoId}`,
    author: null,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}
