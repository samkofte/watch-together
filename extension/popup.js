document.getElementById('connectBtn').onclick = () => {
  const room = document.getElementById('roomIdInput').value.trim() || 'default-room';
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: (r) => {
          if (window.connectToWatchParty) window.connectToWatchParty(r);
          else alert('Bu sekmede aktif bir video oynatıcı bulunamadı.');
        },
        args: [room]
      });
    }
  });
};
