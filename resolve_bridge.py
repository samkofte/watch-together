"""Universal Stream Resolver Engine.
Unpacks and extracts video streams from ANY video hosting platform or website:
- Dean Edwards Packer (eval(function(p,a,c,k,e,d)))
- CryptoJS / AES encrypted payloads (MolySTREAM, VidMoly, etc.)
- JWPlayer / VideoJS script configurations
- yt-dlp universal extractor (YouTube, Dailymotion, Vimeo, VK, Twitter, Twitch, etc.)
- Direct HLS .m3u8 and MP4 regex scans
- Local custom engines (Dizibox, Diziyou, Yabancidizi)
"""
import sys
import re
import json
import base64
import urllib.parse
from typing import Dict, Any, Optional

try:
    from curl_cffi import requests
except ImportError:
    import requests

import yt_dlp

def unpack_dean_edwards(packed_str: str) -> str:
    """Unpack Dean Edwards p.a.c.k.e.r javascript string."""
    pattern = r"\}\s*\(\s*['\"](.*?)['\"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['\"](.*?)['\"]\.split\(['\"]\|['\"]\)"
    match = re.search(pattern, packed_str, re.DOTALL)
    if not match:
        return ""
    
    payload, radix_str, count_str, words_str = match.groups()
    radix = int(radix_str)
    words = words_str.split("|")
    
    def baseN(num: int, b: int) -> str:
        chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        if num == 0:
            return "0"
        digits = []
        while num:
            digits.append(chars[num % b])
            num //= b
        return "".join(reversed(digits))

    # Build dictionary
    lookup = {}
    for i, word in enumerate(words):
        key = baseN(i, radix)
        lookup[key] = word if word else key

    def repl(m):
        w = m.group(0)
        return lookup.get(w, w)

    unpacked = re.sub(r"\b\w+\b", repl, payload)
    return unpacked

def extract_streams_from_html(html: str, page_url: str) -> Optional[Dict[str, Any]]:
    """Scan raw HTML and scripts for direct HLS or MP4 streams."""
    # 1. Dean Edwards check
    if "eval(function(p,a,c,k,e,d)" in html or "eval(function(p,a,c,k" in html:
        for script_match in re.finditer(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\)\)\)", html, re.DOTALL):
            unpacked = unpack_dean_edwards(script_match.group(0))
            if unpacked:
                m_file = re.search(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', unpacked)
                if m_file:
                    return {"type": "hls", "stream_url": m_file.group(1)}
                m_mp4 = re.search(r'["\'](https?://[^"\']+\.mp4[^"\']*)["\']', unpacked)
                if m_mp4:
                    return {"type": "direct", "stream_url": m_mp4.group(1)}

    # 2. General regex search for m3u8
    m_m3u8 = re.search(r'(?:file|source|src)\s*:\s*["\']([^"\']+\.m3u8[^"\']*)["\']', html, re.I) or \
             re.search(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', html, re.I)
    if m_m3u8:
        url = m_m3u8.group(1).replace("\\/", "/")
        return {"type": "hls", "stream_url": url}

    # 3. Direct MP4 video sources
    m_mp4 = re.search(r'(?:file|source|src)\s*:\s*["\']([^"\']+\.mp4[^"\']*)["\']', html, re.I) or \
            re.search(r'["\'](https?://[^"\']+\.mp4[^"\']*)["\']', html, re.I)
    if m_mp4:
        url = m_mp4.group(1).replace("\\/", "/")
        return {"type": "direct", "stream_url": url}

    return None

def resolve_universal(target_url: str) -> Dict[str, Any]:
    target_url = target_url.strip()

    # --- A. SPECIALIZED SITES ---
    # 1. Dizibox
    if "dizibox." in target_url:
        try:
            sys.path.insert(0, r"c:\Users\pc\Desktop\dizibox-api")
            from dizibox_api.client import DiziboxClient
            c = DiziboxClient()
            slug = target_url.strip("/").split("/")[-1]
            stream = c.get_episode_stream(slug)
            
            r_master = c._session.get(stream.stream_url, headers={"Referer": stream.embed_url})
            master_text = r_master.text.strip()
            child_urls = [line.strip() for line in master_text.splitlines() if line.strip().startswith("http")]
            if child_urls:
                r_child = c._session.get(child_urls[0], headers={"Referer": stream.embed_url})
                content = r_child.text
            else:
                content = master_text

            rewritten_lines = []
            for line in content.splitlines():
                line_s = line.strip()
                if line_s.startswith("http"):
                    rewritten_lines.append(f"/api/proxy/chunk?url={line_s}")
                else:
                    rewritten_lines.append(line_s)

            m3u8_body = "\n".join(rewritten_lines)
            if "#EXT-X-PLAYLIST-TYPE" not in m3u8_body:
                m3u8_body = m3u8_body.replace("#EXTM3U", "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD")
            if "#EXT-X-ENDLIST" not in m3u8_body:
                m3u8_body += "\n#EXT-X-ENDLIST\n"

            return {
                "success": True,
                "type": "hls_body",
                "m3u8_body": m3u8_body,
                "title": stream.episode_title,
                "provider": "dizibox"
            }
        except Exception as e:
            return {"success": False, "error": f"Dizibox error: {e}"}

    # 2. Diziyou
    if "diziyou." in target_url:
        try:
            sys.path.insert(0, r"c:\Users\pc\Desktop\diziyou-api")
            from diziyou_api.client import DiziyouClient
            c = DiziyouClient()
            slug = target_url.strip("/").split("/")[-1]
            stream = c.get_episode_stream(slug)
            return {
                "success": True,
                "type": "hls",
                "stream_url": stream.stream_url,
                "title": stream.episode_title,
                "provider": "diziyou"
            }
        except Exception as e:
            pass

    # 3. Yabancidizi
    if "yabancidizi." in target_url:
        try:
            sys.path.insert(0, r"c:\Users\pc\Desktop\yabancidizi-api")
            from yabancidizi_api.client import YabancidiziClient
            c = YabancidiziClient()
            stream = c.get_episode_stream(target_url)
            stream_url = stream.stream_url
            if not stream_url and stream.playable_streams:
                for ps in stream.playable_streams:
                    if ps.get("stream_url"):
                        stream_url = ps["stream_url"]
                        break
            return {
                "success": True,
                "type": "hls",
                "stream_url": stream_url or stream.embed_url,
                "title": stream.episode_title,
                "provider": "yabancidizi"
            }
        except Exception as e:
            pass

    # 4. Animecix
    if "animecix." in target_url:
        try:
            m = re.search(r'/titles/(\d+)(?:/[^/]+)?/season/(\d+)/episode/(\d+)', target_url)
            if m:
                title_id, season_num, ep_num = m.group(1), int(m.group(2)), int(m.group(3))
                all_videos = []
                for page in range(1, 10):
                    try:
                        api_req = requests.get(f'https://animecix.tv/secure/videos?titleId={title_id}&page={page}', headers={'User-Agent': 'Mozilla/5.0'}, timeout=5)
                        if api_req.status_code == 200:
                            page_json = api_req.json()
                            data = page_json.get('pagination', {}).get('data', [])
                            if not data:
                                break
                            for item in data:
                                if item.get('season_num') == season_num and item.get('episode_num') == ep_num:
                                    all_videos.append(item)
                            if page_json.get('pagination', {}).get('current_page') >= page_json.get('pagination', {}).get('last_page', 1):
                                break
                        else:
                            break
                    except Exception:
                        break

                for v in all_videos:
                    v_url = v.get('url', '')
                    if 'tau-video.xyz' in v_url:
                        tau_id = v_url.rstrip('/').split('/')[-1]
                        try:
                            t_res = requests.get(f'https://tau-video.xyz/api/video/{tau_id}', headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://tau-video.xyz/'}, timeout=5)
                            if t_res.status_code == 200:
                                t_json = t_res.json()
                                urls = t_json.get('urls', [])
                                if urls:
                                    best = urls[-1].get('url')
                                    label = urls[-1].get('label', 'HD')
                                    return {
                                        'success': True,
                                        'type': 'direct',
                                        'stream_url': best,
                                        'title': f'Animecix S{season_num}E{ep_num} ({label})',
                                        'provider': 'animecix'
                                    }
                        except Exception:
                            continue

                if all_videos:
                    return {
                        'success': True,
                        'type': 'iframe',
                        'stream_url': all_videos[0].get('url'),
                        'title': f'Animecix S{season_num}E{ep_num}',
                        'provider': 'animecix'
                    }
        except Exception as e:
            pass

    # 5. Cizgimax
    if "cizgimax." in target_url:
        try:
            session = requests.Session(impersonate="chrome124") if 'curl_cffi' in sys.modules else requests.Session()
            r_page = session.get(target_url, headers={"Referer": target_url}, timeout=8)
            if r_page.status_code == 200:
                idx = r_page.text.find('var servers      = JSON.parse(atob("')
                if idx != -1:
                    start = idx + len('var servers      = JSON.parse(atob("')
                    end = r_page.text.find('")', start)
                    b64 = r_page.text[start:end]
                    data = json.loads(base64.b64decode(b64.replace('\\/', '/')).decode('utf-8'))
                    for s in data:
                        src = s.get('src', '')
                        if src.startswith('/'):
                            oynat_url = 'https://cizgimax.online' + src
                            try:
                                r_oynat = session.get(oynat_url, headers={'Referer': target_url}, timeout=6)
                                if r_oynat.status_code == 200:
                                    # Look for directLink or VidMoly code
                                    m_dl = re.search(r'directLink\s*=\s*["\']([^"\']+)["\']', r_oynat.text)
                                    if m_dl:
                                        moly_code = m_dl.group(1).rstrip('/').split('/')[-1]
                                        embed_url = f'https://vidmoly.me/embed-{moly_code}.html'
                                        # Resolve VidMoly stream
                                        r_embed = session.get(embed_url, headers={'Referer': 'https://cizgimax.online/'}, timeout=6)
                                        if r_embed.status_code == 200:
                                            m_m3u8 = re.search(r'file:\s*["\']([^"\']+\.m3u8[^"\']*)["\']', r_embed.text) or \
                                                     re.search(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', r_embed.text)
                                            if m_m3u8:
                                                return {
                                                    "success": True,
                                                    "type": "hls",
                                                    "stream_url": m_m3u8.group(1),
                                                    "title": s.get('label', 'Cizgimax Stream'),
                                                    "provider": "cizgimax"
                                                }
                                        return {
                                            "success": True,
                                            "type": "iframe",
                                            "stream_url": embed_url,
                                            "title": s.get('label', 'Cizgimax Video'),
                                            "provider": "cizgimax"
                                        }
                            except Exception:
                                continue
        except Exception:
            pass



    # --- B. YT-DLP UNIVERSAL EXTRACTION (YouTube, Vimeo, Dailymotion, Twitch, etc.) ---
    try:
        ydl_opts = {
            'quiet': True,
            'skip_download': True,
            'no_warnings': True,
            'format': 'best[ext=mp4]/best'
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(target_url, download=False)
            if info:
                # Direct playable stream url found
                best_url = info.get('url')
                formats = info.get('formats', [])
                if not best_url and formats:
                    for f in reversed(formats):
                        if f.get('url') and (f.get('ext') == 'mp4' or 'm3u8' in f.get('url')):
                            best_url = f['url']
                            break

                if best_url:
                    is_hls = '.m3u8' in best_url or info.get('protocol') in ('m3u8', 'm3u8_native')
                    return {
                        "success": True,
                        "type": "hls" if is_hls else "direct",
                        "stream_url": best_url,
                        "title": info.get('title', 'Video'),
                        "provider": info.get('extractor', 'universal')
                    }
    except Exception:
        pass

    # --- C. DEEP WEB SCRAPER & DEOBFUSCATOR ---
    try:
        session = requests.Session(impersonate="chrome124") if 'curl_cffi' in sys.modules else requests.Session()
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": target_url
        }
        r = session.get(target_url, headers=headers, timeout=8)
        if r.status_code == 200:
            extracted = extract_streams_from_html(r.text, target_url)
            if extracted:
                return {
                    "success": True,
                    "type": extracted["type"],
                    "stream_url": extracted["stream_url"],
                    "title": "Stream Video",
                    "provider": "deobfuscator"
                }

            # Check if there is an iframe embed (e.g. vidmoly, doodstream, streamtape, etc.)
            iframe_matches = re.findall(r'<iframe[^>]+src=["\']([^"\']+)["\']', r.text, re.I)
            for if_src in iframe_matches:
                full_if_url = urllib.parse.urljoin(target_url, if_src)
                try:
                    r_if = session.get(full_if_url, headers={"Referer": target_url, "User-Agent": headers["User-Agent"]}, timeout=6)
                    if r_if.status_code == 200:
                        if_extracted = extract_streams_from_html(r_if.text, full_if_url)
                        if if_extracted:
                            return {
                                "success": True,
                                "type": if_extracted["type"],
                                "stream_url": if_extracted["stream_url"],
                                "title": "Stream Video",
                                "provider": "embedded_iframe"
                            }
                except Exception:
                    continue
    except Exception as e:
        pass

    # Fallback: check if target_url is genuinely a media file
    is_media = re.search(r'\.(m3u8|mp4|webm|mkv|mov)(\?.*)?$', target_url, re.I)
    if is_media:
        return {
            "success": True,
            "type": "hls" if ".m3u8" in target_url else "direct",
            "stream_url": target_url,
            "title": "Video Stream",
            "provider": "direct"
        }

    return {"success": False, "error": "No media stream resolved by bridge"}


if __name__ == "__main__":
    if len(sys.argv) > 1:
        target = sys.argv[1]
        res = resolve_universal(target)
        print(json.dumps(res))
    else:
        print(json.dumps({"success": False, "error": "No url provided"}))
