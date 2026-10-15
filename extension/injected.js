// Injected into Netflix / Disney+ MAIN WORLD to directly interface with proprietary players
(function () {
  console.log('[WatchParty] Injected hook initialized in Main World');

  function getNetflixPlayer() {
    try {
      const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
      if (videoPlayer) {
        const sessions = videoPlayer.getAllPlayerSessionIds();
        if (sessions && sessions.length > 0) {
          return videoPlayer.getVideoPlayerBySessionId(sessions[sessions.length - 1]);
        }
      }
    } catch (e) {
      console.warn('[WatchParty] Error getting Netflix player:', e);
    }
    return null;
  }

  // Listen for commands dispatched by content.js
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'WATCHPARTY_EXT') {
      return;
    }

    const { action, time } = event.data;
    const netflix = getNetflixPlayer();

    if (netflix) {
      if (action === 'SEEK') {
        netflix.seek(Math.floor(time * 1000));
      } else if (action === 'PLAY') {
        netflix.play();
      } else if (action === 'PAUSE') {
        netflix.pause();
      }
    } else {
      // Fallback: standard HTML5 video tag
      const video = document.querySelector('video');
      if (video) {
        if (action === 'SEEK') video.currentTime = time;
        if (action === 'PLAY') video.play().catch(() => {});
        if (action === 'PAUSE') video.pause();
      }
    }
  });

  // Periodically report status back to content script
  setInterval(() => {
    const netflix = getNetflixPlayer();
    if (netflix) {
      window.postMessage({
        source: 'WATCHPARTY_PAGE',
        currentTime: netflix.getCurrentTime() / 1000,
        paused: netflix.isPaused ? netflix.isPaused() : false,
        duration: netflix.getDuration() / 1000
      }, '*');
    }
  }, 1000);
})();
