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

interface TranscriptSegment {
  text: string;
  duration: number;
  offset: number;
  lang: string;
}

export async function fetchYoutubeTranscript(
  videoId: string,
  rapidApiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `https://${RAPIDAPI_HOST}/video/transcript?videoId=${encodeURIComponent(videoId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-rapidapi-key': rapidApiKey,
      'x-rapidapi-host': RAPIDAPI_HOST,
    },
    signal: signal ?? AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RapidAPI transcript error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const segments = data.content as TranscriptSegment[] | undefined;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('No transcript available for this video');
  }

  return segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
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
