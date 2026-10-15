# 🎬 WatchTogether & WatchParty Real-Time Senkron İzleme Platformu

Bu proje; [Watch2Gether](https://w2g.tv/), [Teleparty](https://www.teleparty.com/) ve [WatchTogether.watch](https://watchtogether.watch/) platformlarının ağ trafiği, istemci-sunucu senkronizasyon protokolleri ve oynatıcı sarmalayıcı (player wrapper) mimarileri tersine mühendislik ile çözümlenerek sıfırdan geliştirilmiştir.

---

## 🔍 Tersine Mühendislik Analizi (Platformların Çalışma Mantığı)

1. **İçerik Re-streaming Yapmaz:**
   - W2G, Teleparty veya WatchTogether sunucuları video içeriğini indirip dağıtmaz. Video oynatma tamamen **istemci tarafında (Client-Side)** gerçekleşir.
2. **Authoritative Clock & WebSocket Sync:**
   - Sunucu merkezi zaman referansını (`currentTime`, `state`, `lastUpdated`) tutar.
   - Oynat (`play`), Duraklat (`pause`) veya İleri/Geri sarma (`seek`) olayları WebSocket ile odaya anında yansıtılır.
3. **Drift Reconciliation (Zaman Kaymasını Düzeltme):**
   - Ağ gecikmesi ve cihaz farkından dolayı oluşan süre kaymaları periyodik kalp atışı (`heartbeat`) ile telafi edilir (Örn: fark > 1.2s ise yumuşak seek ile senkrona çekilir).
4. **Çoklu Sağlayıcı & Dış Bağlantı Desteği (Universal Player):**
   - **YouTube:** Resmî IFrame JavaScript API dinlenir.
   - **HLS (.m3u8):** Native HLS.js motoruyla doğrudan oynatılır (Dizi/Film API akışları vb.).
   - **Direct Video (.mp4 / .webm):** HTML5 Video element API ile senkronlanır.

---

## 🚀 Çalıştırma

```bash
cd watchparty-app
npm install
node server.js
```

Tarayıcınızda açın:
👉 **`http://localhost:4000`**

---

## 🎯 Özellikler

- **Oda Sistemi:** Rastgele veya özel oda kodlarıyla anında oda oluşturma / katılma.
- **Dışarıdan Link Ekleme:**
  - YouTube linkleri (`https://www.youtube.com/watch?v=...`)
  - Canlı yayın & Dizi HLS `.m3u8` linkleri
  - Direkt video dosyaları (`.mp4`, `.webm`)
- **Host Yetkilendirmesi:** Odayı kuran kişi yönetici (`👑 Host`) olur, ayrıldığında devredilir.
- **Canlı Sohbet & Tepkiler (Reactions):** Ekran üzerinde uçuşan dinamik emojiler (`❤️`, `🔥`, `🍿`, vb.) ve gerçek zamanlı mesajlaşma.
