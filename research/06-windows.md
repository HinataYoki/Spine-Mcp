# Windows desteği planı (2026-10-20)

Hedef: spine-mcp Windows'ta da çalışsın; macOS'ta hiçbir davranış değişmesin. Kaynaklar: kod denetimi (subagent, ~40 bulgu), Windows CI taban çizgisi (249 unit testin 5'i düşüyor; typecheck geçiyor), Esoteric'in CLI ve ayarlar sayfaları (Windows'ta `Spine.com` konsol başlatıcısı; ayarlar `%USERPROFILE%\Spine`, macOS `~/Library/Application Support/Spine`, Linux `~/.spine`).

## İlke

- Platforma bağlı her şey tek yerde: `src/platform.ts`. Fonksiyonlar `platform`/`env` parametresi alır, böylece macOS'ta da Windows dalı unit testle denenir.
- macOS dalları birebir aynı kalır; her adımdan sonra macOS'ta tam test (Unity dahil) ve Windows CI.
- Doğrulanamayanlar (gerçek Windows'ta Spine/Unity) "doğrulanmadı" diye yazılır; tahmin, doğrulanmış gibi sunulmaz.

## Advisor incelemesinden

- Sıra riske göre: önce açık editör tespiti **kapalı başarısız olsun** (süreç listesi alınamazsa "bilinmiyor" → staging, not); Unity için de bilinmeyen durumda batch mode yok. Sonra kilitli dosyada geri alma (olmazsa yedeğin yolunu söyleyen yüksek sesli hata, asla "geri alındı" yalanı). Sonra taban çizgisi testleri, yollar, en son kozmetik ve belgeler.
- macOS'ta kalıcı anahtarlar (yedek, adım günlüğü, yazma kilidi, staging, export önbelleği) bayt bayt aynı kalır: yeni kimlik mantığı yalnız win32; darwin anahtarını sabitleyen test.
- Windows CI yalnız simülasyon değil kanıt da versin: gerçek PowerShell süreç listesi (Türkçe karakterli işaretli bir node süreci), büyük/küçük harf yol anahtarı, PowerShell'in paylaşımsız açtığı dosyada tekrar deneme; ImageMagick kurulup MVG/font yolları.
- Berkan'ın adı ASCII değil: Windows profil yolu "Işık" içerebilir; Spine.com'un argümanları ANSI kod sayfasıyla alıp almadığı doğrulanmadı → doctor uyarısı, doğrulanmadı diye yazılır.

## Adımlar (her biri ayrı commit)

1. **Platform katmanı** (`src/platform.ts`): süreç listesi (macOS/Linux `ps`, Windows PowerShell `Get-CimInstance Win32_Process`), dosya kimliği anahtarı (`realpathSync.native`, Windows'ta küçük harf), Unity yolu için `/`'a çevirme, klasör adı temizleme (Windows'ta yasak karakterler, ayrılmış adlar, uzunluk), BOM'suz JSON okuma, kilit hatalarına dayanıklı silme/yer değiştirme, süreç ağacını öldürme (`taskkill /T /F`), PATH'te ikili arama (PATHEXT), font adayları.
2. **Konumlar**: `config.ts` linux/darwin dallarında `posix.join`, Windows'ta LOCALAPPDATA yoksa `AppData\Local`; Spine ayar klasörü platforma göre; Rhubarb (`where`, `rhubarb.exe`); fontlar (`%WINDIR%\Fonts\arial*.ttf`).
3. **Güvenlik: açık editörü bulmak**: Spine editörü (Spine.exe/Spine.com, tırnaklı komut satırı) ve Unity editörü (`Unity.exe -projectpath "..."`) Windows'ta da tespit edilsin. Bulunamazsa sessiz kalmak yerine not.
4. **Yollar ve metin**: Unity asset yolları her zaman `/`; sondaki `\`; `.meta` CRLF; JSON BOM; geçici Unity projesinin `manifest.json`'ında `file:` yolu `/` ile; render klasör adları TS ve C#'ta aynı temizleyiciyle.
5. **Dosya sistemi dayanıklılığı**: geri alma (`restoreFile`) kilitli dosyada tekrar dener, olmazsa kopyalayıp sha ile doğrular; önbellek klasörü taşıma/silme EPERM/EBUSY'de tekrar dener; `finally` içindeki silmeler sonucu bozmaz.
6. **Süreçler**: `windowsHide: true`; zaman aşımında süreç ağacı öldürülür (Spine.com'un JVM'i, Unity'nin işçileri); img2webp çok kare verildiğinde 32k komut satırı sınırına takılmasın (göreli yol, `cwd`).
7. **Testler ve CI**: Windows CI (unit) + PowerShell süreç listesinin gerçek Windows'ta çalıştığını kanıtlayan test; `test:spine` betiği çapraz platform; testlerde `TEMP`/`TMP`; `.gitattributes`; testlerdeki `cp -cR` → `cpSync`.
8. **Belgeler**: README/USAGE'a Windows kurulumu (Spine.com, Unity Hub, ImageMagick/ffmpeg/Rhubarb winget, ortam değişkenleri, uzun yol ve ASCII olmayan kullanıcı adı uyarısı), sunucu açıklaması, doctor uyarıları.

## Kapsam dışı / doğrulanamayan

- Gerçek bir Windows makinesinde Spine Pro + Unity ile uçtan uca deneme (Berkan'da Windows varsa saha denemesi olarak).
- Java'nın konsol kod sayfası (ASCII olmayan yollar), Spine'ın Windows'ta `recent` dosyasındaki yol biçimi, render eşiklerinin D3D/ANGLE altında kalibrasyonu.

## Sonuç (0.47.0)

Planın 8 adımı yapıldı. CI'da gerçek Windows'ta doğrulananlar: PowerShell süreç listesi (ASCII dışı komut satırı), kilitli dosyada geri alma (bekleyip geçen kilit ve kalan kilit), zaman aşımında süreç ağacının bitmesi, ImageMagick'in Windows font yolu ve `@C:\...` MVG dosyasıyla yazı çizmesi, MCP sunucusunun stdio üzerinden başlayıp Spine gerektirmeyen 12 aracı "Berkan Işık" adlı klasörde çalıştırması. Doğrulanmayan (Windows makinesi + lisanslı Spine + Unity gerekir): Spine.com'un ASCII dışı yolları, Windows'ta editör süreç adı ve `recent-1.json` biçimi, Unity batch mode ve render eşikleri (D3D), Java'nın konsol kod sayfası.

## Saha denemesi kontrol listesi (Windows makinesi + lisanslı Spine + Unity)

1. `spine_doctor`: `editorWindowOpen: false` (`"unknown"` değil), uyarılar (ASCII dışı / uzun work folder).
2. ASCII dışı harfli bir klasördeki projeden export (`spine_inspect`): Spine.com bu yolu okuyor mu.
3. Spine açıkken `spine_editor_status` → `running: true`; bir yazma staging kopyasına gidiyor.
4. Editör kapalıyken, bir export sürerken `spine_editor_status` → `running: false` (spine-mcp'nin kendi CLI çağrısının Java süreci editör sanılmamalı).
5. Bir proje açıkken `projectOpen: "likely"` (`%USERPROFILE%\Spine\settings\recent-1.json` konumu ve biçimi).
6. `spine_unity_check` (render dahil): Windows Unity'de batch mode, eşikler (D3D).
7. `spine_unity_import` Unity açıkken: "copied" modu (Unity.exe -projectpath tespiti).

## Saha denemesi sonucu (2026-10-21, 0.49.1)

Windows 10 Pro, Spine 4.3.26 Professional (lisanslı), Unity 6000.0.62f1 + spine-unity 4.3.117, Node 24.20, ffmpeg (ImageMagick yok).

1. ✅ `spine_doctor`: `editorWindowOpen: false`, Professional, lisanslı; 54 karakterlik work folder uyarısı.
2. ✅ `…\Berkan Işık\çalışma ğü\bolt.spine`: Spine.com yolu okuyor; info, inspect, export, yazma, geri yükleme tamam.
3. ✅ Editör açıkken: Windows'ta editör tek süreç, komut satırı `"C:\Program Files\Spine\Spine.exe"` (argümansız, ayrı java süreci yok). `spine_editor_status` → `running: true`; yazma doğrulanmış staging kopyasına gitti.
4. ✅ CLI export sürerken `running: false`.
5. 🟡 `projectOpen: "possible"`: `%USERPROFILE%\Spine\settings\recent-1.json` okunuyor, son proje başkasıydı (beklenen).
6. ✅ `spine_unity_check` render dahil: Bolt parite ≤ 0.0001, IoU 0.97/0.96; bir oyunun SkeletonGraphic rig'i IoU 0.98. Unity test suite'i paralel işçilerle 18/18 (süreçler arası kilitten sonra, G108).
7. ✅ Unity açıkken `spine_unity_import`: hedef proje Unity editöründe açıkken "copied" modu (dosyalar kopyalandı, batch mode yok, prefab yapılamadığı söylendi); başka bir Unity projesi açıkken kapalı proje doğru "kapalı" sayıldı ve tam içe aktarma (SkeletonAnimation, SkeletonGraphic, SkeletonMecanim) yapıldı.

Testler: unit 286/286 (Windows), gerçek Spine 337/337 + 29 atlanan (Unity, ImageMagick, Rhubarb), Unity 18/18. Önce düşen 8 testin hiçbiri ürün hatası değildi: tırnaksız sahte editör yolu (Windows yolu boşlukta kesiliyor), `split("/")`, ImageMagick'siz showcase.

## İkinci saha denemesi kontrol listesi (0.54–0.56, ikinci makine)

0.54 (`spine_unity_check perf`), 0.55 (mesh uyumu) ve 0.56 (CanvasGroup) yalnız macOS'ta doğrulandı. Windows'ta:

1. `npm ci`, `npm run fixtures`, `SPINE_UNITY=1 npm run test:spine`: hepsi geçmeli (G120 tek başına tekrar).
2. `spine_unity_check` → `perf: { counts: [1, 50] }` spineboy'da: Windows Build Support modülüyle `.exe` oyuncu build ediliyor mu, uyarı var mı, `walk` iskelet başına µs ve threaded hızlanma makul mü (macOS M5: 11 µs, 100'de 2,2x).
3. `spine_rig_qa` bir prodüksiyon rig'inde: `mesh-art-outside` / `mesh-mostly-empty` / `mesh-image-resized` sayıları ve yanlış pozitiflerin *türü* (kasıtlı kırpılmış mesh, efekt quad'ı, sequence). Dönüşte sadece sayı ve tür yazılır.
4. `spine_update_images` dry-run, sanatı değişmiş bir mesh'te: `fit.before` / `fit.after` ve hull notu doğru mu.
5. `spine_unity_check` → `render: true, renderComponent: "graphic", canvasGroup: true` spineboy'da (D3D): macOS'taki gibi ayarsız solma yanlış, Detect Settings ile walk doğru, portal additive uyarısı mı.

