# spine-mcp ne yapabiliyor, ne yapamıyor — 2026-10-17 (v0.5.0, 0.6.0 güncellemesiyle)

Bu belge iki şeyi karşılaştırır:

1. **spine-mcp'nin gerçek kapsamı:** her iddia koddan ve testlerden (88 unit, 19 gerçek Spine, 2 başsız Unity testi, 36 örnek projelik sweep) kontrol edildi.
2. **Spine kullananların gerçekten yaşadığı sorunlar:** kaynaklar Esoteric forumu (JSON API ile okunan ~60 konu), `spine-editor` / `spine-runtimes` GitHub issue'ları ve Spine dokümanları. Forum bağlantıları `https://esotericsoftware.com/forum/d/<no>` biçimindedir.

Reddit'e erişilemedi; oradan doğrulanmış bir şey yok. "Sıklık" değerlendirmeleri konu sayısı, yorum sayısı ve tarihlere dayanan yargıdır, ölçülmüş istatistik değildir.

## Kısa sonuç

spine-mcp, **Spine'ın hiç sahip olmadığı bir şeyi** veriyor: editörün scripting API'si yok ve Esoteric 2023–2025 arasında bunu açıkça reddetti (/d/26424, /d/28210, /d/23924). spine-mcp bu boşluğu resmi kanallardan (CLI, JSON, spine-core) dolduruyor. Kapsadığı alanlar:

- **Animasyon tarafındaki tekrarlı iş:** overlap, mirror, loop düzeltme, easing, retime.
- **Kalite kontrolü:** Spine'ın sessizce düşürdüğü key'ler, loop seam'leri, pop'lar.
- **Export ve Unity uyumu.**
- **Paylaşılabilir önizleme.**

Kapsamadığı alanlar (tasarım gereği ya da teknik imkânsızlık):

- art import,
- rig kurma (mesh/weight/constraint),
- çok kişili çalışma (binary `.spine` birleştirme),
- lip sync,
- canlı editörle etkileşim,
- lisans/CI sorunları.

| Alan | Kapsama | Bir cümle |
|---|---|---|
| Art hazırlama ve import | ❌ | Dokunmuyor; PSD import ve yeniden import Spine'da kalıyor. |
| Rig kurma | ❌ (okuma ✅) | Rig'i okur, ölçer, doğrular; kurmaz, değiştirmez. |
| Animasyon üretimi / tekrarlı iş | ✅ güçlü | Overlap, mirror, loop, easing, retime, slot/deform kaydırma; doğrulanmış yazma. |
| Kalite kontrol | ✅ güçlü | Sessiz key kaybı, seam, pop, NaN, mesh indeksleri; Spine'ın Problems görünümünün yakalamadıkları. |
| Export ve paketleme | ✅ | Çok ölçekli atlas, JSON/binary, spine-core ile export öncesi doğrulama; PMA/bleeding analizi yok. |
| Runtime entegrasyonu | 🟡 | Unity'de import + kemik paritesi var; mix/geçiş, performans, Godot/web yok. |
| İşbirliği / sürüm kontrolü | 🟡 | Yedek, geri alma, animasyon diff'i; `.spine` merge yok. |
| Önizleme ve paylaşım | ✅ | Spine render'ından etiketli WebP/GIF/MP4 tek çağrıda. |
| Lip sync / ses | ❌ | Yok. |
| Lisans / CI / headless | ❌ (kısmen hafifletir) | Pro lisansı şart; macOS; editör açıkken yazma riski. |

## 1. Ne yapabiliyor (kanıtlı)

### Okuma ve anlama

- **`spine_project_info`:** CLI'dan hızlı özet; birden fazla proje tek çağrıda.
- **`spine_export_json`:** değişiklik algılayan önbellekle tam JSON.
- **`spine_inspect`:** yapı, ham bölümler veya tek animasyonun tam key'leri.
- Bir projede birden fazla iskelet desteklenir. Essential projeleri de çalışır.

### Kalite kontrol (`spine_validate`)

- **Statik hatalar:** Spine'ın içe aktarırken sessizce attığı referanslar; bunlar Spine'ın exit 0 verdiği durumlardır (G-dosyaları).
  - eksik bone, slot, attachment, constraint, skin, event, animation
  - linked mesh kaynağı
  - mesh vertex/indeks hataları, weight bone indeksi
  - key sırası, bone sırası, çift isim
- **Uyarılar:** eğri biçimi, fazla kök.
- **Bilgi:** physics'li bone'a key atılmış.
- **Runtime:** spine-core ile yükleme, her animasyonu örnekleme, NaN pozları, loop seam (seam adımının komşu adımlara oranı).

### Ölçme

- **`spine_measure`:** kemik başına dönüş aralığı, uzanım, hız, açısal hız, tek kare pop, hold, seam adımı.
- **`spine_timing`:** key pozlar, poz aralıkları, segment süreleri, segment başına ease tipi, hold'lar.
- **`spine_compare_animations`:** A/B sayılar; istenirse yan yana render.

### Görme

- **`spine_render_frames`:** Spine'ın kendi renderer'ıyla kareler ve ajanın bakabileceği contact sheet. Başsız render'da physics warm-up yok (G10).
- **`spine_showcase`:** 1–4 animasyon aynı ölçekte, etiketli, yan yana. Çıktı WebP (alfa, GitHub'da sayfada oynar), GIF veya MP4.

### Yazma (hep yeni isim, hep dry-run önce)

- **`spine_add_animation`:** ajanın yazdığı 4.3 JSON animasyonunu ekler.
- **`spine_derive_animation`** şu işlemlerle:
  - `scaleValues`, `retime`
  - `offsetBones`, `offsetSlots` (loop'ta tam bezier bölme)
  - `loopFix`, `ease` (preset + cubic-bezier)
  - `swapBones`, `mirror` (dünya uzayında, deform köşe köşe)
  - `keepBones` / `dropBones`
- **Güvenlik zinciri:** doğrulama → eşzamanlılık kontrolü → sha256 yedek → animasyon-only import (`-a NAME --to SKEL -r`) → uyarı = hata → yeniden export → timeline ve davranış karşılaştırması → diğer animasyonlar ve yapı değişmedi mi → hata olursa otomatik geri alma.
- **`spine_list_backups` / `spine_restore_backup`.**

### Gönderme

- **`spine_export`:** JSON ve/veya binary, mesh'e duyarlı paketlenmiş atlas, birden fazla ölçek. Önce geçici klasör, spine-core'da gerçek atlasla yükleme, sonra kopya; var olan dosyalar `overwrite` olmadan reddedilir.
- **`spine_unity_check`:** başsız Unity'de spine-unity'nin kendi içe aktarıcısıyla import, her animasyonda kemik bazında spine-core paritesi.
  - Unity 6000.6 ve 2022.3'te Bolt ve spineboy'un 11 animasyonu 0.0005 birim içinde.
  - Kullanıcının Unity projelerine dokunmaz.

## 2. Ne yapamıyor (ve neden)

| Yapamadığı | Neden |
|---|---|
| Setup pose, bone, slot, skin, constraint, mesh, weight düzenlemek | Tam JSON roundtrip kayıplı (editöre özel veri düşüyor); yalnız animasyon import'u kayıpsız (D05, research/phase0). `.spine` binary'si okunmaz, yamalanmaz (lisans §12). |
| Yeni event tanımı, yeni attachment/görsel eklemek | Yapı değişikliği; yazma doğrulaması "yapı değişmedi" şartı koyar (`missing-event` hatası). |
| Art import, PSD, yeniden import | Kapsam dışı; Spine editöründe. |
| Canlı editörle konuşmak | Editörün API'si yok; araç dosya + CLI üzerinden çalışır. Editör açıkken yazılırsa ve kullanıcı eski hâli kaydederse değişiklik ezilir (her yazmada uyarı var). |
| Physics'i bake etmek | 0.7.0'da `bakePhysics` ile eklendi. Mirror hâlâ physics çıktısını aynalamaz (önce bake edilirse aynalanabilir). |
| Animasyonu başka iskelete retarget etmek | 0.8.0'da isim eşlemeli transfer var; değer uyarlayan (bone boyu/açı) retarget yok. |
| Lip sync, ses | Yok. |
| Sequence (kare kare) key'lerini kaydırmak | Raporlanır, kaydırılmaz. |
| Döndürülmüş ebeveyn altında translate mirror'ı | Yaklaşık yapılır ve not düşülür. |
| Asimetrik (yandan görünüş) mesh'lerin deform mirror'ı | Matematiksel karşılık yok; not düşülür. |
| AnimationState mix/geçiş, track katmanları | 0.6.0'da `spine_mix_check` ile eklendi. |
| Performans bütçesi raporu | 0.6.0'da `spine_budget` ile eklendi. |
| Unity'de görsel kontrol | 0.10.0'da eklendi: kamera render'ı Spine render'ıyla karşılaştırılır, PMA uyumsuzluğu yakalanır; URP/özel materyaller yok. |
| Godot, web, Unreal runtime kontrolü | Web: 0.10.0'da `spine_web_check` (spine-webgl). Godot/Unreal yok. |
| Windows / Linux | Test edilmedi; yollar macOS'a göre (`/Applications/...`). |
| Lisanssız çalışma | CLI yolları (export, render, yazma, Unity kontrolü) Spine Pro ister. Trial kaydetmez, export etmez. Essential mesh/IK'li projeleri kaydetmez, export etmez. Elinde JSON varsa okuma, ölçme ve JSON üzerinde derive çalışır. |

## 3. Spine kullanıcısının sorunları → spine-mcp

Durumlar: ✅ kapatıyor · 🟡 kısmen · ❌ kapatmıyor.

### Art ve import

| Sorun (kaynak) | Durum | Not |
|---|---|---|
| PSD import hataları 4.3'te sürüyor (/d/30086, /d/29992, /d/29894) | ❌ | Dokunmuyor. |
| Değişen art'ı yeniden import etmek rig'i bozuyor: görünürlük key'leri, weight'ler, mesh'ler (/d/29900, /d/26322) | ✅ (0.9.0) | Önlemez ama yakalar: `spine_snapshot` + `spine_reimport_diff` neyin bozulduğunu (kayıp/gizlenmiş key, silinen weight, mesh→region) ve her animasyonun nerede farklı oynadığını listeler. |
| İki karakterin görsel yolları çakışıyor (/d/29131) | ❌ | — |

### Rig

| Sorun | Durum | Not |
|---|---|---|
| Rig parçalarını iskeletler arası taşımak (spine-editor #582, #524) | ❌ | — |
| Numeric vertex, solo slot, cetvel vb. editör ergonomisi (#77, #604, #554) | ❌ | Editör UI'ı. |
| Skin / mix-and-match runtime sürprizleri (/d/18396, /d/24471) | 🟡 | `spine_render_frames` skin parametresi var; skin kombinasyonu önizlemesi yok. |

### Animasyon

| Sorun | Durum | Not |
|---|---|---|
| Overlap / follow-through elle (/d/16993, #153 negatif zaman) | ✅ | `offsetBones` loop'ta tam bezier bölmeyle ve yıkıcı değil (yeni animasyon). Raptor kuyruğunda gerçek projeye yazıldı. |
| Mirror / flip yok, "roadmap'te" (/d/27252, /d/8632) | ✅ | Dünya uzayında mirror, deform dahil; owl'da Spine'a yazılıp doğrulandı. Editörün hâlâ sunmadığı bir şey. |
| Loop seam ve pop'lar, bitiş key'ini elle kopyalamak (/d/7514, /d/11220, /d/26598) | ✅ | `spine_validate` seam/pop bulur; `loopFix` bitişi başlangıca eşitler (tam tur rotasyonu korur). |
| Easing ve eğri işleri | ✅ | `ease` presetleri ve cubic-bezier, segment başına. |
| Animasyonu başka iskelete taşımak, retarget (/d/13876, /d/16861) | ✅ (0.8.0, 0.10.0) | `spine_transfer_animation`: isimle eşleme, eksik raporu, doğrulanmış yazma; `retarget` translate'i hedef boyutuna ölçekler. |
| "CLI animasyon import edemez" (2020 personel yanıtı, /d/13876) | ✅ | 4.3'te `-a NAME --to SKEL -r` ile animasyon-only import çalışıyor (research/phase0); spine-mcp'nin yazma yolu bu. |
| Physics bake / loop'lanabilir physics (/d/25689, /d/30206; personel: "öncelik değil") | ✅ (0.7.0) | `bakePhysics`: simülasyondan key, loop kapatma, kendini doğrulama; resmi örneklerde 20 animasyon 0.55 birim içinde. Birkaç çevrimde tekrar eden hareket raporlanır. |
| Lip sync (/d/7621, 37 yorum) | ❌ | — |
| Tekrarlı işler için script/makro yok (/d/8741, /d/28210) | ✅ | spine-mcp'nin varlık sebebi: ajan doğal dille tarif edilen işi doğrulanmış işlemlere çeviriyor. |

### Kalite kontrol

| Sorun | Durum | Not |
|---|---|---|
| Export edilmiş veride doğrulayıcı/diff yok; Problems görünümü yalnız editör içi | ✅ | `spine_validate` (statik + runtime), `spine_compare_animations`, yazmada otomatik diff. |
| "Animation clean up" setup'a eşit key'leri silip Unity mix'inde pop yaratıyor (/d/24933) | ✅ (0.6.0) | `spine_mix_check` geçişleri ve katmanlı track'leri AnimationState ile oynatır; geç ilk key'leri ve katmanda sıçrayan özellikleri listeler. |
| Runtime'da eksik region hataları (/d/15902, /d/9759) | ✅ | `spine_export` her iskeleti gerçek atlasla yükler; `spine_unity_check` spine-unity içe aktarma hatalarını raporlar. |
| Editör / export / runtime sürüm uyuşmazlığı (/d/6534, /d/29959, /d/30156) | 🟡 | Editör `-u 4.3.26` ile sabit, spine-core 4.3, Unity kontrolü eşleşen runtime dalını kullanır; `spine_doctor` sürümleri gösterir. Kullanıcının oyun projesindeki runtime sürümünü kontrol etmez. |

### Export ve paketleme

| Sorun | Durum | Not |
|---|---|---|
| CLI parametre sırası sessizce çıktısız bırakıyor (/d/14258, 30 yorum) | ✅ | Doğru zincir sabitlendi; boş çıktı ve uyarılar hata sayılır. |
| Ölçekli atlas, binary/JSON birlikte | ✅ | Tek çağrı, spine-core doğrulaması. |
| Skin başına export / özel çıktı adı (/d/16698) | 🟡 | Atlas adı seçilebilir; skin başına export yok. |
| PMA halo / çift premultiply (/d/3132, /d/24261) | ✅ (0.10.0) | `spine_unity_check render` düz alfa / PMA uyumsuzluğunu görsel olarak yakalıyor. |
| Başsız / CI export, lisans (/d/3841, /d/24779) | ❌ | spine-mcp masaüstü Pro lisansıyla çalışır; CI lisansı Esoteric'te yalnız Enterprise. Görsel export OpenGL ister (resmi CLI dokümanı). |

### Runtime

| Sorun | Durum | Not |
|---|---|---|
| "Unity'de aynı mı oynuyor?" | ✅ | `spine_unity_check`: import + kemik paritesi. |
| Unity URP shader, SRP Batcher, ışık sorunları (/d/24609, /d/29280) | 🟡 (0.10.0) | Varsayılan materyalle render karşılaştırması (PMA yakalanıyor); URP/ışık yok. |
| Performans: vertex, bone, clipping maliyeti (/d/10025, /d/24125) | ✅ (0.6.0) | `spine_budget`: Spine Metrics her karede, draw call tahmini, limitler. |
| Godot / web / Construct runtime boşlukları (spine-runtimes #2910, #2322) | 🟡 (0.10.0) | Web: `spine_web_check`. Godot/Construct yok. |
| AnimationState mix pop'ları (/d/24933) | ✅ (0.6.0) | `spine_mix_check`. |

### İşbirliği

| Sorun | Durum | Not |
|---|---|---|
| Binary `.spine` git'te birleşmiyor (/d/10587, /d/18145) | 🟡 | Birleştiremez. Resmi iş akışındaki "animatör kopyası → ana projeye animasyon import" adımını otomatikleştirebilir (`spine_add_animation` + doğrulama); JSON diff'i okunur hâle getirir. |
| Geçmiş paneli / diff yok (/d/15848) | 🟡 | Her yazmada yedek, `spine_list_backups`, animasyon karşılaştırması. |
| Önizleme paylaşmak | ✅ | `spine_showcase` ve contact sheet'ler. |

## 4. Diğer Spine MCP'leriyle fark

Bulunan diğer projeler küçük: `1425sd/spine-mcp` (Spine 3.8, Windows, CLI sarmalayıcı), `nihatcagri44/spine-motion-mcp` (4.2, lint ve keyframe, v0.1), `sky-spine-mcp` (yalnız CLI), PSD→rig denemeleri ve `spine-animation-ai` (ticari olmayan lisans). Hepsi dışa aktarılmış JSON veya CLI üzerinde çalışıyor. Bunları README'lerinden biliyoruz; çalıştırılmadılar.

spine-mcp'yi ayıran şeyler:

- Doğrulanmış ve geri alınabilir yazma: sessiz key kaybını hata saymak, otomatik geri alma.
- Kare kare spine-core karşılaştırması.
- Deform dahil dünya uzayında mirror.
- Unity'de çalışma zamanı paritesi.
- 36 resmi örnekte sweep.

## 5. Kapatılabilecek en değerli boşluklar

Etki = forumdaki sıklık × spine-mcp'nin mevcut altyapısıyla yakınlık.

| # | Öneri | Kapattığı sorun | Efor |
|---|---|---|---|
| 1 | **Mix check:** iki animasyon arası geçişi (mix süresiyle, AnimationState ile) örnekleyip pop bulmak; "clean up" tuzağını yakalamak | /d/24933, mix pop'ları | S–M |
| 2 | **Performans bütçesi:** toplam vertex, bone/vertex weight, clipping, blend değişimi (draw call tahmini), atlas sayfası, mobil eşikleri | /d/10025, /d/24125 | S |
| 3 | **Animasyon transferi:** bir projeden diğerine isim eşleşmeli animasyon kopyası; eksik referans raporu, isim eşleme tablosu | /d/13876, retarget isteği | M |
| 4 | **Physics bake:** spine-core simülasyonundan seçilen bone'lara key yazmak, loop'u kapatmak | /d/25689, /d/30206 | M |
| 5 | **Re-import guard:** art değişikliğinden önce/sonra iskelet ve animasyon farkı raporu (kaybolan key, değişen mesh) | /d/29900 | S–M |
| 6 | **Unity görsel kontrol:** sahnede kamera render'ı ↔ Spine render'ı piksel farkı; PMA/materyal uyumu | URP/PMA konuları | M |
| 7 | **Godot / web parite** (spine-godot, spine-player) | Godot konuları | M–L |
| 8 | **Lip sync köprüsü:** Rhubarb çıktısından ağız attachment key'leri | /d/7621 | M |

## 6. Kim için ne ifade ediyor

- **Animatör:** overlap, mirror, loop düzeltme, easing, hız/genlik varyantları, A/B sayılar ve paylaşılabilir önizleme. Rig ve art'a dokunmaz; sanatsal karar animatörde kalır, her değişiklik yeni isimle gelir.
- **Technical artist:** sessiz key kaybı, seam/pop, mesh/weight indeks hataları, export doğrulama, Unity paritesi, çok örnekli sweep. Eksikleri: performans bütçesi, mix kontrolü, shader/PMA.
- **Oyun geliştirici:** doğrulanmış runtime export'u ve "Unity'de aynı oynuyor mu" cevabı. Eksik: Godot/web ve AnimationState geçişleri.
- **Ekip:** yedek, geri alma, animasyon diff'i; animatör kopyalarından ana projeye animasyon taşımayı otomatikleştirme potansiyeli. `.spine` merge'ü çözmez.

## Kaynaklar (seçme)

- Spine 4.3 duyurusu: https://esotericsoftware.com/blog/Spine-4.3-released
- CLI dokümanı: https://esotericsoftware.com/spine-command-line-interface
- Satın alma / lisans: https://esotericsoftware.com/spine-purchase
- Animasyon import kuralları: https://esotericsoftware.com/spine-import
- Forum konuları: yukarıdaki /d/<no> numaraları
- Editör issue'ları: https://github.com/EsotericSoftware/spine-editor/issues
- Runtime issue'ları: https://github.com/EsotericSoftware/spine-runtimes/issues
- Diğer MCP'ler:
  - https://github.com/1425sd/spine-mcp
  - https://github.com/nihatcagri44/spine-motion-mcp
  - https://glama.ai/mcp/servers/l8vf4qrj91
