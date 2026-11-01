# telegram-notify

> [OpenCode](https://opencode.ai) için iki yönlü Telegram köprüsü: turların sonucu
> telefonuna düşer, Telegram'dan yazdığın mesaj oturumun yeni promptu olur.

Uzun bir işi başlatıp masadan kalkabilirsin. İş bitince (ya da hata verince) Telegram'dan
haberin olur; cevabı oradan yazarak OpenCode'u kaldığın yerden devam ettirirsin.
Eklenti global olarak yüklenir, açık olan her projede çalışır ve bildirimleri tek bir
sohbete gönderir.

```
✅ Tur tamamlandı
Proje: telegram-notify — C:\Projects\telegram-notify

README eklendi, .gitignore ve LICENSE hazır. Sırada commit var.

↩️ Yeni prompt için bu mesaja yanıt yazın.
```

> Arayüz metinleri Türkçedir; kodu `src/index.ts` içinden değiştirebilirsin.

## Neleri bildirir

| Olay | Telegram'a giden |
| --- | --- |
| `permission.asked` | ⏳ Onay bekleniyor / ❓ Soru bekleniyor — eylem, kaynak ve proje adı |
| `form.created` | ❓ Soru soruldu — sorulan başlıklar ve proje adı |
| `session.execution.succeeded` | ✅ Tur tamamlandı — son asistan yanıtının ilk 4000 karakteri |
| `session.execution.failed` | ❌ Tur hata ile bitti — hata metni |

Alt oturumların (sub-agent) turları bildirilmez, yalnızca üst seviye oturumlar haber verir.
Uzun mesajlar 3900 karakterden bölünerek birden fazla Telegram mesajı olarak gider
(üst sınır ~40.000 karakter).

## Telegram'dan OpenCode'a

| Yaptığın | Sonuç |
| --- | --- |
| Bir bildirime **yanıt** yazmak | O bildirimi gönderen oturuma prompt olarak gider |
| **Normal** mesaj | En son bildirim gönderen oturuma gider |
| `/stop` · `/dur` | Çalışan turu durdurur |
| `/id` | Bu sohbetin chat id'sini söyler |
| `/help` · `/start` | Kısa kullanım özeti |
| Diğer `/komut` | Bilinmeyen komut uyarısı |

Her iletilen prompt için Telegram'da `📨 İletildi → <oturum>` onayı gelir. Oturum artık
yoksa ya da bilinmiyorsa eklenti bunu söyler; sessizce yutmaz.

## Kurulum

### 1. Bir bot oluştur

1. Telegram'da [@BotFather](https://t.me/BotFather) → `/newbot` → **token**'ı not al.
2. Bota **bir kez sen mesaj at** — botlar sohbeti kendiliğinden başlatamaz.
3. Chat id'ni öğren: [@userinfobot](https://t.me/userinfobot) gibi bir bota yaz, ya da
   `https://api.telegram.org/bot<TOKEN>/getUpdates` çıktısındaki `message.chat.id`.
4. Bot'ta webhook **olmamalı** (eklenti `getUpdates` ile uzun polling yapar):

   ```sh
   curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
   ```

### 2. Eklentiyi ekle

```sh
opencode plugin add github:olcanaskar/telegram-notify
```

Ya da elle: bu depoyu `~/.config/opencode/plugins/telegram-notify/` altına kopyala
(Windows'ta `%USERPROFILE%\.config\opencode\plugins\telegram-notify\`), içinde
`index.ts` bulunsun.

### 3. Yapılandır

`~/.config/opencode/telegram-notify.json` dosyasını oluştur:

```json
{
  "botToken": "123456789:AA...",
  "chatId": "123456789",
  "debug": false,
  "notify": {
    "input": true,
    "done": true,
    "error": true
  },
  "inbound": {
    "enabled": true
  }
}
```

Hazır şablon: [`telegram-notify.example.json`](telegram-notify.example.json)

### 4. Dene

OpenCode'u yeniden başlat, sonra:

```
/telegram-test
```

Telegram'a `🔔 OpenCode test bildirimi — kurulum çalışıyor.` düşerse hazırsın.

## Yapılandırma

Ayarlar üç yerden okunur, **önce gelen kazanır**:

1. `opencode.json` içindeki eklenti seçenekleri (`botToken`, `chatId`, `inbound`)
2. Ortam değişkenleri: `OPENCODE_TELEGRAM_BOT_TOKEN`, `OPENCODE_TELEGRAM_CHAT_ID`
3. `~/.config/opencode/telegram-notify.json`

| Alan | Varsayılan | Açıklama |
| --- | --- | --- |
| `botToken` | — | **Zorunlu.** BotFather token'ı |
| `chatId` | — | **Zorunlu.** Bildirimlerin gideceği tek sohbet; başka sohbetler yok sayılır |
| `notify.input` | `true` | Onay/soru bekleyen istekleri bildir |
| `notify.done` | `true` | Tamamlanan turları bildir |
| `notify.error` | `true` | Hatalı turları bildir |
| `inbound.enabled` | `true` | Telegram'dan gelen mesajları prompt olarak kabul et |
| `debug` | `false` | `telegram-notify-debug.log` dosyasına ayrıntılı kayıt yaz |

`botToken` ya da `chatId` yoksa eklenti sessizce devre dışı kalır ve konsola tek satır
uyarı yazar; OpenCode'un açılmasını engellemez.

## Nasıl çalışır

Global eklenti her yüklü konum için bir kez örneklenir ve her örnek **her** sunucu
olayını alır. İki mekanizma bunu tek bir akışa indirir:

- **Tek gönderim:** her olay kimliği için `wx` (özel oluşturma) ile kilit dosyası alınır;
  yarışı kazanan tek örnek mesajı gönderir.
- **Tek polling:** `telegram-notify-poll.lock` içinde pid + token + zaman damgası tutulur
  ve 30 saniyede bir tazelenir. Kilit sahibi ölürse (90 saniye bayat) başka bir örnek
  devralır.

Diğer ayrıntılar:

- `getUpdates` offset'i diske yazılır, böylece her güncelleme **tam bir kez** işlenir.
- İlk açılışta geçmişin yalnızca son 20 güncellemesi okunur ve **15 dakikadan yeni**
  olanlar teslim edilir; eski bir birikim taze prompt gibi tekrar oynatılmaz.
- Bildirim ↔ oturum eşlemesi Telegram `message_id`'si üzerinden tutulur, yani günler
  sonra bir bildirime yanıt yazsan bile doğru oturuma gider (7 gün saklanır).
- Bağlantı koparsa 5 saniye bekleyip yeniden dener; webhook çakışması (HTTP 409)
  üç kez üst üste gelirse durur ve Telegram'dan webhook'u kaldırmanı söyler.

### Diske yazılanlar

Hepsi `~/.config/opencode/` altında:

| Yol | İçerik |
| --- | --- |
| `telegram-notify.json` | Ayarlar (token burada) |
| `telegram-notify-offset.json` | Son işlenen `update_id` |
| `telegram-notify-poll.lock` | Aktif polling sahibi |
| `telegram-notify-seen/` | Gönderilmiş olay kimlikleri (2 gün) |
| `telegram-notify-routes/` | `message_id` → oturum eşlemesi (7 gün) |
| `telegram-notify-last/` | Sohbet başına son bildiren oturum |
| `telegram-notify-debug.log` | `debug: true` iken kayıt (512 KB'ta sıfırlanır) |

## Sınırlar

- **Tek sohbet.** `chatId` dışındaki sohbetler yok sayılır; ekip/çok kullanıcı desteği yok.
- **Yalnızca metin.** Fotoğraf, dosya, ses iletildiğinde eklenti bunu söyler.
- **Onay ve sorular Telegram'dan yanıtlanamaz.** Bildirimi görürsün ama kararı OpenCode
  arayüzünde vermen gerekir; eklenti bunu mesajın altına yazar.
- **Webhook kullanılmaz.** Bot'ta webhook tanımlıysa polling çalışmaz.
- OAuth/`fetch` nedeniyle **Node 18+** gerekir.

## Güvenlik

- `botToken` bir paroladır: botunu ele geçiren herkes mesajlarını okur ve senin adına
  prompt gönderebilir. Token'ı repoya **koyma** — `.gitignore` bunu engeller.
- `chatId` senin kullanıcı kimliğindir; token ile birlikte paylaşma.
- Bot, gelen mesajı yalnızca `chatId` eşleşirse işler; yine de token sızarsa hemen
  BotFather'dan `/revoke` ile yenile.

## Lisans

[MIT](LICENSE)
