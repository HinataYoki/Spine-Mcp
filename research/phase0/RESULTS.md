# Phase 0 — Doğrulanmış sonuçlar (Spine 4.3.26 Pro, macOS, 2026-10-16)

Script'ler: `run_phase0.py`, `run_phase0b.py` (CLI), `probe_runtime.mjs` (spine-core 4.3.13). Ham çıktı: `results-a.json`, `results-b.json`.
Test verisi: spine-runtimes 4.3 örneklerinin **kopyaları** (`.lab/`, git dışı).

## CLI (Spine 4.3.26, launcher 4.3.08)

| # | Konu | Sonuç |
|---|---|---|
| 1 | Binary | `/Applications/Spine.app/Contents/MacOS/Spine`. **Claude Code sandbox'ında donar**, sandbox dışında çalışır. Editör açıkken çalışır. |
| 2 | Gecikme | Her çağrı **~3.1–3.4 sn** (JVM + launcher başlangıcı). Birden çok komut tek çağrıda zincirlenebilir (`-i … -e … -i … -e …`). |
| 3 | Export settings | `class: "json"` doğru (resmi `examples/export/json.json`). Bazı repoların `"export-json"`'u **yanlış**. PNG: `class: "export-png"`. |
| 4 | `-e json` | Kısayol çalışıyor; nonessential + pretty dahil. |
| 5 | `--set name=value` | Çalışıyor (`--set prettyPrint=false` → tek satır). 4.3.73-beta'da gelmiş. |
| 6 | `--last-export-settings` | Projede kayıtlı export yoksa sadece WARNING, rc=0. |
| 7 | Göreli `-o` | **Girdi projenin klasörüne göre** çözülür (cwd değil). → Her zaman mutlak yol. |
| 8 | PNG export `-o` | Klasör değil **dosya öneki**: `-o …/png/idle` → `png/idle_00.png…`. Klasör önceden var olmalı. |
| 9 | Headless PNG | Çalışıyor, Spine'ın kendi renderer'ı (birebir). MSAA/Warm Up yok (proje dersi) → nihai video GUI'den. |
| 10 | `-u 4.3.26` | Çalışıyor; sürüm sabitleme için her çağrıda kullan. |
| 11 | Hata | Olmayan girdi → rc=1 + `ERROR:` satırı. Bozuk JSON → rc=1 + `Cause: [serialize] …` satırı. Proje dokunulmaz. |
| 12 | Info `-i x.spine` | Proje sürümü, dopesheet FPS, skeleton boyutu, bone/slot/event/IK/transform/animasyon listeleri — hızlı özet için yeterli. |

## Import davranışı (MCP'nin yazma stratejisini belirleyen kısım)

| # | Deney | Sonuç |
|---|---|---|
| 13 | **Tam roundtrip** (`.spine`→JSON→**yeni** `.spine`) | Kayıplı: ~7 KB editör-içi veri kaybı (56.7→49.5 KB), icon'lu bone renkleri sıfırlanıyor, `audio`/`convex`/bbox rengi default'a dönüyor. **Mevcut projeyi bu yolla yeniden yazma.** |
| 14 | **Sadece animasyon import** `-i x.json -o proj.spine -a NAME -r` | Diğer her şey **birebir** (JSON diff = 0). İkinci ekleme +55 B (editör verisi korunuyor). **MCP'nin ana yazma yolu.** |
| 15 | Aynı isim, `--replace` yok | Silmez, `idle` → **`idle2`** olarak ekler. Güvenli varsayılan. |
| 16 | Aynı isim, `--replace` | Animasyonu tam değiştirir (diff = 0). Sadece açık onayla. |
| 17 | Hedefte olmayan bone'a key | **rc=0**, timeline **sessizce düşer**, log'da `Bone not found: …`. Bone eklenmez. |
| 18 | Hedef skin'de olmayan attachment key'i | **rc=0**, key düşer, log'da `attachment not found`. |
| 19 | Kaynak JSON'da geçersiz referans | rc=1, proje dokunulmaz. |
| 20 | Physics timeline'lı animasyon (celestial-circus `wind-idle`) | Birebir. |
| 21 | Slider constraint'li proje (diamond) | Animasyon birebir. |
| 22 | Deform timeline (alien `death`) | Birebir (sadece int/float gösterimi). |
| 23 | `--to <skeleton>` çok-skeleton'lı proje | Çalışıyor (skeleton ve animasyon). |
| 24 | Import projeyi **4.3.26 formatında yeniden kaydeder** | 4.3.00 örnekleri 4.3.26'ya yükseldi. Eski editörde açılmaz → kullanıcıya söyle / yedek al. |

**Sonuç → yazma stratejisi:** `export JSON → yeni isimli animasyonu üret → ön-doğrula (bone/slot/attachment hedefte var mı) → yedek → -a NAME -r → log'u parse et (warning = hata say) → tekrar export → diff ile doğrula`.

## spine-core 4.3.13 (Node 24, headless)

| # | Sonuç |
|---|---|
| 25 | JSON **atlas'sız** yüklenebiliyor: özel `AttachmentLoader` + sahte `TextureRegion`; region boyutları parse sonrası doldurulup `attachment.updateSequence()` çağrılır. |
| 26 | Hız: spineboy yükleme ~5 ms; animasyon başına tüm kareler (physics dahil) **1–6 ms**. → Ölçüm/doğrulama anlık. |
| 27 | 4.3 API değişti: `skeleton.setupPose()` (eski `setToSetupPose`), dünya transformu `bone.appliedPose.worldX` (eski `bone.worldX`), `AttachmentLoader` metodlarında yeni `placeholder` parametresi, `Animation.apply(… from: MixFrom, add, out, appliedPose)`. ART-PIPELINE `pose.mjs` doğrudan çalışmaz. |
| 28 | Bounds (`getBoundsRect`) ve NaN kontrolü doğru çalışıyor. |

## 4.3 JSON (gerçek export'lardan doğrulandı)

- `skeleton`: `hash`, `spine: "4.3.26"`, `x/y/width/height`, `images`, `audio`.
- Rotate key: `{"time": t, "value": deg}` — `angle` **değil**. Translate/scale/shear: `x`, `y`. Default değerler (time 0, value 0) yazılmaz.
- Curve: yok = linear, `"stepped"`, ya da mutlak koordinatlı bezier: 1-değerli timeline'da **4** sayı `[cx1, cy1, cx2, cy2]`, 2-değerli (translate/scale/shear) timeline'da **8** sayı (x sonra y).
- Constraint'ler tek `constraints` dizisinde, `type` ile; dizi sırası = güncelleme sırası. Animasyonda constraint timeline'ları `ik`/`transform`/`physics`/`slider`/`path` bölümlerinde, constraint adına göre.
- Transform: `source`, `localSource`, `localTarget`, `properties: { from: { offset, to: { to: { offset, max, scale } } } }`, `mixRotate/mixX/…`.
- Physics: `bone`, `x/y/rotate/scaleX/shearX`, `limit`, `fps`, `inertia`, `strength`, `damping`, `mass`, `wind`, `gravity`, `*Global`.
- Slider: `animation`, `bone`, `property`, `scale`, `max`, `local`, `loop`, `time`.
- Bone: `icon`, `color` (editör), `inherit`. Attachment tipleri: region, mesh, linkedmesh, clipping (`convex`), path, point, boundingbox.
- Resmi JSON format sayfası **güncel değil** (3.8). Referans: spine-core `SkeletonJson.ts` (4.3 branch) + gerçek export.

## Açık kalan (kullanıcı testi gerekli)

1. **Proje editörde açıkken CLI dosyayı değiştirirse ne olur?** Editör yeniden yükler mi, uyarır mı, kaydedince CLI değişikliğini ezer mi? (computer-use Spine'ı göremiyor: app bundle'ının ID'si yok.) → 2 dk'lık manuel test: bir örnek kopyasını aç, Claude animasyon eklesin, editörün tepkisine bak.
2. `-a` import sırasında hedef projede **kaydedilmemiş** editör değişiklikleri varsa (1. maddeyle aynı risk).
