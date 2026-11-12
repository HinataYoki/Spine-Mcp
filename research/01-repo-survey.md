# Spine MCP — Mevcut Repoların Analizi ve Tasarım Önerisi

> **Güncelleme (2026-10-16, Phase 0 sonrası):** Bu rapordaki şu kısımlar geçersiz/güncellendi:
> - §4 "Dil önerisi: Python" → DECISIONS D04 (TypeScript önerisi, gerekçeli revizyon).
> - §5 Faz 0 maddelerinin hepsi doğrulandı → `phase0/RESULTS.md` (`class: "json"`, `--set` çalışıyor, import davranışı, roundtrip kaybı).
> - §6 tablo: 4.3 farkları gerçek export'larla teyit edildi; rotate alanı `value`.

Tarih: 2026-10-16 · Hedef: macOS + Spine Pro · Yöntem: 16 repo tarball olarak indirildi, kod **çalıştırılmadan** statik okundu (5 paralel analiz).
Lisanslar elle doğrulandı; diğer bulgular analiz raporlarına dayanıyor, kritik olanlar Faz 0'da gerçek Spine ile teyit edilmeli.

> Düzeltme: İlk mesajda "en kapsamlısı zhoushengmin" demiştim. Kod incelemesi sonrası en değerli repo **ART-PIPELINE-MCP** (MIT, tipli 4.2 modeli, spine-core runtime doğrulama, otomatik mesh+weight, gerçek gait/IK, 489 test).

---

## 1. Özet tablo

| Repo | Lisans | Kod alınır mı | Spine | macOS | En güçlü tarafı | Risk / zayıflık |
|---|---|---|---|---|---|---|
| **kumikilongyeyo/ART-PIPELINE-MCP** | MIT | ✅ (atıfla) | 4.2.43 | ✅ | Tipli IR (pydantic, roundtrip-safe), spine-core ile runtime doğrulama + posed geometry render, contour→CDT mesh + heat weights, Froude tabanlı gait + IK foot plant, physics strand, easing→bezier | Yerinde yazma (backup/dry-run/atomic yok), 4.2'ye kilitli, slot-oyun FX'ine kaymış, 49 düşük seviye tool, ilk kullanımda otomatik `npm install` |
| **zhoushengmin/spine-mcp-server** | ❌ LICENSE dosyası yok | ❌ sadece fikir | 3.8.75 | ❌ (Windows path'leri) | `modifyProject` döngüsü (export→edit→validate→backup→import), "import'u yeni temp projeye yap, sonra üzerine kopyala" bulgusu, backup rotasyonu + rollback, node-canvas + spine-ts headless render | 3.8 JSON şeması (4.x'te kırılır), her edit'te tam export/import (yavaş), `vendor/spine-ts` kopyalanmamalı |
| **yb901104-wq/spine-mcp** | ❌ yok | ❌ sadece fikir | 4.1.24 | Çekirdek ✅, observer ❌ | **En iyi güvenlik tasarımı:** varsayılan dry-run, sha256 `expectedHash`, diff whitelist (izin verilmeyen JSON path'e dokunursa reddet), workspace path sınırlama, onaylı restore; spine-core ile yükleme testi; 36 anlamlı test | Sadece animasyon timeline'ları, CLI yok, lisanssız |
| **nihatcagri44/spine-motion-mcp** | MIT | ✅ | 4.2 | ✅ (mac CLI auto-detect) | Puppeteer + spine-player ile kare kare **GIF önizleme** (ajan için görsel geri bildirim), easing→bezier, `loopSmooth`, mobil lint (bone bütçesi, key yoğunluğu, loop pop) | Test yok, backup/dry-run yok, HTTP sunucu tüm arayüzlere auth'suz açık, CLI ayarları gerçek Spine'da denenmemiş |
| **kumikilongyeyo/gpt-spine-mcp** | MIT | ✅ (seçici) | 4.2 | ✅ | `spine_guard.py`: sha256 + sınırlı backup + temp→validate→`os.replace` atomik yazma (testli); PSD blend→Spine blend | Mesh/IK/motion yüzeysel, "intelligence" katmanı büyük isim/ince mantık |
| **egorfedorov/spine-mcp** | MIT | ✅ (az) | 4.2 / 4.3 CLI | ✅ | Temiz CLI wrapper, Spine CLI çıktısındaki gürültü satırlarını filtreleme, mac path | Animasyonlar sabit keyframe, test yok, `.spine` üzerine yazabiliyor |
| **K-ulucay/spine_anim_mcp** | MIT | ✅ (az) | 4.2 | ✅ | Analitik 2-bone IK çözücü + stance/swing ayak yolu, parametrik generator mimarisi | IK rotate key'e bake ediliyor (gerçek constraint değil), atlas placeholder, `animate_existing` skin/IK/animasyonları siliyor |
| **ampersante/spine2d-animation-mcp** (116★) | MIT | ✅ (az) | 4.2 | ✅ | PSD y-down → Spine y-up dönüşümü, world→local bone offset, `[pivot]` marker katmanı konvansiyonu | Sadece Faz 0 (1 tool, animasyon yok), "text prompt" yok. **`reference/SkeletonJson.java` Esoteric lisanslı — kopyalanmamalı** |
| **1425sd/spine-MCP** | Apache-2.0 | ✅ | 3.8.75 | ⚠️ | "Her zaman kopya üzerinde çalış + değişiklik manifest'i" deseni, yapılandırılmış CLI sonucu | JSON editleme sığ, "corpus" sadece istatistik (3.5/3.6 içerik), test yok |
| **neko233-com/spine233-agent-cli** (Go) | MIT | ⚠️ sadece güvenlik desenleri | 4.3 | ✅ | Preview-first, girdiyi asla ezmeme, `expectedMatches` + eski-değer eşleşmesi (fail-closed), yazdıktan sonra tekrar okuyup byte karşılaştırma, atomik yazma | **Kapalı binary `.spine` formatını decode/patch ediyor** (harici `spine233-file-parser`). Lisans §12(c) "decode/derive" yasağıyla çelişir — **bu yolu kullanmıyoruz** |
| **ghr132891/spine-animation-platform** | ❌ yok | ❌ sadece fikir | 3.8 / 4.2 | ✅ | `rig.py: validate_state` (en kapsamlı referans-bütünlük linter'ı: mesh UV/triangle, weight index, linkedmesh…), revision'lı mutate + history snapshot, headless runtime pose sampling, review bundle (contact sheet) | Codex CLI + kapalı görsel API'ye bağlı monolit, golf'lenmiş okunaksız kod, auth'suz 0.0.0.0, Cloudflare tunnel |
| claudeskydream-hash/spine2D-mcp | MIT | ❌ | 4.1 | ✅ | — | Keyword→preset, export'lar placeholder, sıfır değer |
| claudeskydream-hash/sky-spine-mcp | MIT | ✅ (cheat-sheet) | — | ⚠️ | CLI argv örnekleri (export/pack) | 6 tool, sadece export/pack/özet |

**Elenenler:** `yjh2222332024/SpineDoc-Aily-mcp` — Spine 2D ile ilgisi yok (doküman denetim aracı, isim çakışması); ayrıca hard-coded token'lı frp tunnel binary'leri içeriyor, çalıştırılmamalı. `SolarisNeko/neko233-ai-mcp-spine` ve `lujinyu223/spine2D_MCP` — sadece README, kod yok.

---

## 2. Ortak çıkarımlar

1. **Kimse editörü canlı kontrol etmiyor** — hepsi JSON + CLI (veya kendi JSON üretimi). Bu bizim mimari kararımızı doğruluyor.
2. **Hiçbiri tam paket değil:** derin Spine bilgisi (ART-PIPELINE) ile güçlü güvenlik (yb901104 / neko233 / gpt-spine guard) farklı repolarda.
3. **Sürüm kilidi her yerde:** 3.8.75 / 4.1.24 / 4.2.43. JSON şeması sürümler arası değişiyor (rotate `angle`→`value`, bezier gösterimi, 4.2 physics, 4.3 transform constraint mapping). Resmi [JSON format sayfası](https://esotericsoftware.com/spine-json-format) **güncel değil** (3.8 örnekleri, physics yok) — gerçek referans, hedef sürümün runtime reader'ı (`SkeletonJson`) ve spine-runtimes'taki örnek export'lar.
4. **En iyi doğrulama = resmi spine-core ile yükle + her kareyi poz'la** (ART-PIPELINE `validator/pose.mjs`, yb901104, ghr132891). Spine import'u da ikinci hakem (ART-PIPELINE import log'undaki "Fixed invalid triangulation" gibi onarım mesajlarını parse ediyor — çok iyi sinyal).
5. **Görsel geri bildirim kritik:** ajan sonucu görmeli. İki yol: (a) spine-core posed geometry → numpy/PIL render (ART-PIPELINE, hızlı, headless), (b) puppeteer + spine-player GIF (nihat, birebir runtime görüntüsü).

---

## 3. Lisans notları

- **Kod alınabilir (atıfla):** ART-PIPELINE, gpt-spine, egorfedorov, nihat, K-ulucay, ampersante, neko233 (MIT); 1425sd (Apache-2.0).
- **Sadece fikir:** zhoushengmin, yb901104, ghr132891 (lisans dosyası yok = tüm hakları saklı).
- **Asla kopyalama:** ampersante `reference/SkeletonJson.java`, zhoushengmin `vendor/spine-ts`, neko233 demo asset'leri (Esoteric lisanslı).
- **Spine Runtimes License** (spine-core / spine-player): Senin Pro lisansınla kendi kullanımın için sorun yok. MCP'yi yayınlarsak runtime'ları **vendor'lamadan npm bağımlılığı** olarak çekeriz; kullanıcının da Spine lisansı olması gerekir (hedef kitle zaten Spine kullanıcısı).
- **`.spine` binary'ye dokunmuyoruz** (lisans §12(c)). Proje dosyası sadece resmi CLI import/export ile üretilir.

---

## 4. Önerilen birleşik tasarım ("her birinden en iyisi")

| Katman | Kaynak | Not |
|---|---|---|
| Spine JSON modeli (IR) | ART-PIPELINE `ir.py` | Hedef sürüme port; `extra="allow"` ile bilinmeyen alanları koru |
| Timeline / easing→bezier | ART-PIPELINE `timeline.py` (+ nihat `easing.ts` karşılaştırma) | |
| Mesh + weights | ART-PIPELINE `geometry.py`, `weights.py`, `mesh.py` | Contour→Douglas-Peucker→CDT, heat weights |
| Rig + motion | ART-PIPELINE `rig_gait.py`, `rig_body.py`; K-ulucay `ik.py` (referans) | Slot-oyun FX kısmını alma |
| Doğrulama | ART-PIPELINE `runtime.py` + `validator/pose.mjs` + `qa.py`; ghr132891 `validate_state` fikirleri | Her yazmadan önce/sonra |
| Güvenlik | yb901104 fikirleri (dry-run varsayılan, diff whitelist, expectedHash), gpt-spine `spine_guard.py` (atomik + backup), neko233 desenleri (fail-closed eşleşme, yaz-oku-doğrula) | Backup'lar proje klasörünü kirletmesin (`.spine-mcp/backups`) |
| CLI wrapper | egorfedorov / nihat mac path tespiti + 1425sd yapılandırılmış sonuç + zhoushengmin "temp projeye import → atomik değiştir" | `-u` ile sürüm sabitleme |
| Önizleme | ART-PIPELINE `render.py` (hızlı, varsayılan) + nihat puppeteer GIF (opsiyonel, birebir) | |
| Tool yüzeyi | Az ve üst seviye (ART-PIPELINE'ın 49 tool'u fazla) | Örn. `inspect`, `edit` (dry-run'lı), `rig`, `animate`, `validate`, `preview`, `export` |

**Dil önerisi:** Python + küçük Node validator (ART-PIPELINE'ın yapısı). Gerekçe: en değerli kod (mesh/weight/gait/IR, ~40K satır, testli) Python; TS'e yeniden yazmak haftalar demek. spine-core zaten Node tarafında çalışıyor.

---

## 5. Faz 0 — Senin Mac'inde gerçek Spine ile doğrulanacaklar

1. **Export settings şeması:** bir projede `--last-export-settings` çalıştır → gerçek `class` değeri (`"json"` mı `"export-json"` mı? repolar çelişiyor).
2. **Import davranışı:** mevcut bir `.spine`'a `-o` ile import edince düzenlemeler kayboluyor mu? (zhoushengmin 3.8'de bunu buldu → temp proje + kopyalama.)
3. **Roundtrip kaybı:** `.spine` → JSON (nonessential) → `.spine` sonrası hangi editör-içi veriler düşüyor (görünüm/ghosting ayarları, klasörler vb.).
4. **Doğrulanmamış flag'ler:** `--set key=value` (pack) ve `--version` resmi dokümanda yok; denenmeli. (`-e json|binary|json+pack|binary+pack`, `-u`, `-r`, `-s`, `-m`, `-p`, `-j`, `-c` dokümanda var.)
5. **Hedef sürümün JSON farkları:** Spine'ın export ettiği gerçek JSON ile ART-PIPELINE IR'ı karşılaştır (özellikle 4.3 ise transform constraint mapping, slider vb.).
6. CLI yolu: `/Applications/Spine.app/Contents/MacOS/Spine` ve headless çalışıp çalışmadığı (image/video export OpenGL ister).

---

## 6. Karar: hedef Spine 4.3 (2026-10-16)

**Durum:** 4.3 stable 2026-05-14'te çıktı, son sürüm 4.3.26 (7 Eyl 2026). npm'de `@esotericsoftware/spine-core` `latest` = 4.3.13. Spine bu Mac'te kurulu (`/Applications/Spine.app/Contents/MacOS/Spine`).

**4.3 CLI (changelog):** `--set name=value` (4.3.73-beta, artık doğrulanmış), `SPINE_ARGS` env, `-i`/`-j`'de wildcard/regex, `--merge` import, `-a` ile tüm animasyonları import, `--last-export-settings`, `--extra-project-checks`. Editör eski JSON sürümlerine (4.2/4.1) de export edebiliyor.

**4.2 → 4.3 JSON farkları** (resmi `spine-core` `SkeletonJson.ts`, branch 4.2 vs 4.3 diff'i):

| Alan | 4.2 | 4.3 |
|---|---|---|
| Constraint'ler | Ayrı kök diziler: `ik`, `transform`, `path`, `physics` + her birinde `order` | **Tek `constraints` dizisi**, her öğede `type` (`ik`/`transform`/`path`/`physics`/`slider`); `order` yok (dizi sırası = sıra) |
| Transform constraint | `target`, `mixRotate/X/Y/...`, `relative`, `local` | `source` bone, `properties: { <from>: { offset, to: { <to>: { offset, max, scale } } } }` (property→property mapping), `localSource`, `localTarget`, `additive`, `clamp` |
| Slider (yeni) | — | `type:"slider"`: `bone`, `property`, `from`, `to`, `scale`, `max`, `local`, `additive`, `loop`, `mix`, `time`; skin'lerde `slider` referansı; slider animasyonları |
| IK | `uniform` | `uniform` kalktı (4.3.73: scaleY ayarı + volume) |
| Draw order | `drawOrder` + `offsets` | `drawOrder` + yeni `drawOrderFolder` (klasör bazlı draw order timeline) |
| Bone | — | `icon`, `iconRotation`, `iconSize` (editör görselleri) |
| Attachment | — | `inverse`, `convex` (clipping vb.) |
| Runtime API | — | `setupPose`/pose ayrımı → ART-PIPELINE'ın `pose.mjs`'i 4.3 API'sine port edilmeli |

**Sonuç:** ART-PIPELINE IR'ının constraint katmanı yeniden yazılacak (en büyük iş); bone/slot/skin/mesh/timeline büyük ölçüde aynı. Port'u tahmin yerine **gerçek 4.3 export'larıyla** yap: spine-runtimes 4.3 branch'indeki örnek JSON'lar + senin projelerin. Golden-file testleri: export → IR load → IR save → diff = boş olmalı.

## 7. Sıradaki adımlar

1. Kalıcı proje klasörü + hafif doküman yapısı (`GAME.md`→`PROJECT.md`, `STATUS.md`, `BACKLOG.md`, `DECISIONS.md`, `GOTCHAS.md`).
2. Faz 0 (yukarıdaki §5) — Spine kurulu olduğu için CLI denemelerini ben yapabilirim; senin tek örnek `.spine` projen (veya Spine'ın kendi örnekleri) yeter.
3. 4.3 IR + golden roundtrip testleri → sonra güvenlik katmanı → tool yüzeyi → önizleme.
