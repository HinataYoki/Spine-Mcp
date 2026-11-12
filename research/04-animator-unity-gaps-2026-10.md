# Animatör ve Spine→Unity eksik analizi (2026-10-20, v0.31.x)

Kaynaklar: Esoteric forumu (`esotericsoftware.com/forum/d/<id>`), spine-runtimes issue'ları (`#<no>`), spine-unity dokümanı.
Reddit erişilemedi. "Sıklık", thread ve yorum sayısına göre bir tahmindir, ölçülmüş bir istatistik değildir.
Örnek olarak açılıp başlığı doğrulanan kaynaklar: /d/29234 (resmi spine-unity 4.2→4.3 yükseltme rehberi),
/d/24881 (Unity'de straight alpha ile beyaz dikişler), /d/7507 ("Animation clean up").
Bu dokümana bugün kliplerde gördüğümüz eksikler de eklendi: README videolarını kare kare incelerken bulundular.

## 0. Bugün bulunanlar: üreteçler rig'in bağlamını bilmiyordu

Videolardaki animasyonların "gerçek değil" görünmesinin asıl nedeni, üreteçlerin rig'in kurgusunu hesaba katmamasıydı.
Hepsi düzeltildi ve her biri spine-core'da ölçen bir testle korunuyor (`tests/motion-quality.test.ts`, `tests/deform.test.ts`):

| Sorun | Neden | Düzeltme |
|---|---|---|
| Yürürken kollar sallanmıyor (36° istenmişti, 11° oldu) | Kolu IK sürüyordu, rotasyon key'leri eziliyordu | IK hedefi omuz etrafında bir yay üzerinde key'leniyor; IK açık kalıyor |
| Squash'ta anten ve omuzlar kopuyor | Deform mesh'i taşıyor, mesh üstündeki kemikleri taşımıyor | "Binici" kemiklere mesh'in yer değiştirmesi kadar translate key'i yazılıyor |
| Kafa çevirmede anten bükülüyor | Uzun parça kürenin eğrisiyle deform ediliyordu | Feature'lar bütün olarak kayıyor; anten binici kemik olarak taşınıyor |
| Nefeste bacaklar kıvrılıyor | Gövde ölçeği çocuklara (uyluklara) geçiyordu, IK ayağı sabit tutunca diz kırılıyordu | Takipçi olmayan çocuklara ters ölçek (gövdenin altındakilere ters öteleme) |
| Önden çizilmiş karakter yandan adım atıyor | Yürüme üreteci yalnız profil biliyordu | `view: "front"`: yerinde marş, kalça salınımı; kalkan bacak yana açılmak yerine perspektifle kısalıyor (uyluk ölçeği, baldır miras alır), dizler dışa |
| Demo hop'ta dizler çapraz, ayak kayıyor | Squash, bacakları taşıyan kalçadaydı; açılar IK ile tutarlı değildi | IK'dan hesaplanan açılar ve gövdede squash |

Ders: bir üretecin çıktısı "doğru yazıldı" diye doğru görünmez. Kalite kapısı kontrol listesine artık hareketin kendisi de giriyor.
Listede şunlar var: parçalar kopmuyor, ayak kaymıyor, uzuvlar çaprazlanmıyor, istenen sallanma gerçekten oluşuyor.

Kalan ve düzeltilemeyen sınırlar (rig'in kendisinden):
- Ayak kemiği yoksa ayakkabı baldırla birlikte döner.
- Tek parça bir kafada (gözler ayrı değilse) 2.5D çevirme hafif kalır.

## 1. Spine kullanan animatör

| # | Dert | Kanıt | spine-mcp bugün | Ne yapılabilir (resmi kanallarla) |
|---|---|---|---|---|
| A1 | Sanat değişince rig bozuluyor (yeniden mesh, PSD re-import'ta kayan attachment'lar) | /d/17993, /d/30697, /d/23987, /d/29900 | Kısmen: `spine_snapshot` + `spine_reimport_diff`, `spine_update_images`; mesh uyumu 0.55.0 (`spine_rig_qa` mesh-*, `spine_update_images` fit) | **Mesh uyum raporu**: yeni PNG'nin alfasını mesh hull/UV'leriyle karşılaştırıp düzenlenmesi gereken mesh'leri listelemek (S, salt okuma) |
| A2 | Script ve toplu otomasyon yok | /d/8741, /d/28210, /d/29934 | Var: spine-mcp'nin varlık sebebi | — |
| A3 | Aynı `.spine` üzerinde birden çok animatör, merge "cehennem" | /d/28351, /d/26858, /d/15848, /d/10587 | Kısmen: staging + Import Project, transfer, re-import diff | **Animatör kopyalarını birleştirme**: animasyon başına 3 yönlü fark, seçilenleri doğrulanmış `-a` yazmasıyla toplu import (M) |
| A4 | Animasyonu ya da key'leri iskeletler arasında taşımak | /d/5853, /d/8681, /d/15140 | Var: `spine_transfer_animation` | Zaman aralığı ile transfer (küçük) |
| A5 | "Animation Clean Up" runtime'ın ihtiyaç duyduğu key'leri siliyor (mix'te pop, Mecanim geçişleri) | /d/7507, /d/16111, /d/27284, /d/29086 | Kısmen: `spine_mix_check` (yalnız AnimationState) | **Mecanim key kontrolü + `setupKeys` op'u** (S) |
| A6 | Physics loop olmuyor, tutarsız | /d/25166, /d/30650, /d/26750 | Var: `bakePhysics` | — |
| A7 | Mirror / flip yok | /d/625, /d/18395 | Var: `mirror` (deform dahil) | — |
| A8 | Atlas paketleme: fazla sayfa, kullanılmayan görseller, 4.3 vs 4.2 | /d/30204, /d/25014, /d/30520 | Kısmen: export presetleri, skin başına atlas, doluluk/MB; rig QA kullanılmayan görselleri buluyor | **Pack taraması**: N pack ayarını deneyip sayfa, doluluk ve MB'ye göre sıralamak (S–M) |
| A9 | Spine güncellemesi rig davranışını değiştiriyor | /d/30340, /d/30392 | Kısmen: uyum paketi CLI davranışını izliyor, rig hareketini değil | **Sürüm farkı render'ı**: aynı projeyi iki editör sürümüyle render edip kare farkı (M) |
| A10 | Skin ve skin constraint'leri | /d/14714, /d/29525 | Var: `spine_skins` | — |
| A11 | Event ve ses: authoring zahmetli, runtime'da event atlanıyor | /d/24602, /d/5248, /d/11133 | Kısmen: `events` op'u, footstep, lip sync | Mix penceresinde event kontrolü (U7) |
| A12 | Mevcut rig'de weight/mesh düzenleme zahmeti | /d/13325, /d/26945 | Kısmen: auto rig yalnız yeni dosya | Yapılamaz: mevcut rig'e kayıpsız mesh/weight yazmanın resmi yolu yok |
| A13 (bugün) | Üreteçler rig'i tanımıyordu (IK'lı kollar, ölçek mirası, deform üstündeki kemikler, ön/yan görünüş) | Bu çalışmada kliplerde görüldü | Düzeltildi (0.32) | Kalan: ayak kemiği önerisi (auto rig), bacakları yakın karakterlerde diz yönü sezgisi |

## 2. Spine'dan Unity'ye animasyon alan

| # | Dert | Kanıt | spine-mcp bugün | Ne yapılabilir |
|---|---|---|---|---|
| U1 | Yükseltme ve sürüm uyuşmazlığı: 4.2 verisi 4.3'te reddedilir, her şey yeniden export; 4.3'te bileşenler ayrıldı, `Skeleton.Physics` taşındı | /d/29234 (resmi rehber, 44 yorum), /d/30229, /d/29880, #3174, #3180 | Kısmen: doctor, `editorVersion`, uyum paketi; Unity araçları yalnız 4.3 | **Unity yükseltme denetimi + toplu yeniden export**: projedeki tüm `.json`/`.skel.bytes` başlıkları ve spine-unity sürümü, kaynak `.spine` eşlemesi, doğrulanmış toplu export, taşınan API kullanımlarının listesi (M) |
| U2 | PMA vs straight alpha: halo/dikiş, çoğu zaman cihazda; 4.3'te varsayılan straight oldu | /d/24881, /d/28369, /d/30208 | Kısmen: render farkı PMA uyumsuzluğunu yakalıyor, import uyarıyor | Cihaz sıkıştırmasıyla render (ASTC/ETC2 override, M; yapılabilirliği doğrulanmalı) |
| U3 | Draw call ve batching (Linear'da additive, çok sayfa, materyaller) | /d/15587, /d/28846, #1769 | Kısmen: `spine_budget` tahmini | **Ölçülmüş batching**: headless Unity'de SkeletonRenderer submesh talimatlarından gerçek draw call ve batch'i kıran attachment (M) |
| U4 | URP: 2D ışık, normal map, Forward+, SRP Batcher | /d/14259, /d/26632, /d/18083 | Kısmen: URP forward render kontrolü; 2D Renderer ve ışık yok | URP 2D Renderer render kontrolü (M–L) |
| U5 | SkeletonGraphic (UI): maske, çok atlas, CanvasGroup, 4.3 boyut regresyonu | /d/30471, /d/26510, #3134, #3157 | Kısmen: Graphic prefab üretiliyor, Canvas render karşılaştırması yok | **Canvas render kontrolü** (M) |
| U6 | SkeletonMecanim: geçişten kalan state, blend tree, 4.3'te geçiş süresinin yok sayılması | /d/29086, /d/28682, #3070, dokümandaki "Required Additional Keys" | Kısmen: yalnız controller üretiliyor | A5 ile aynı: Mecanim key kontrolü |
| U7 | Mix penceresinde event atlanması (footstep sesi) | /d/11133, /d/5248, EventThreshold | Yok | **Mix penceresi event kontrolü** (S) |
| U8 | Timeline: klip sonunda duraklatma, scrub, cutscene | /d/24455, /d/16190, #3102 | Yok (yol haritasında) | unity-mcp ile Timeline track'leri (L) |
| U9 | Root motion: loop/geçişte titreme, kemik kurgusu | /d/29507, /d/28483, /d/29675 | Yok | **Root motion hazırlığı**: hareket kemiği, döngü başına yer değiştirme, ayak kayması (S–M) |
| U10 | Skin'lerle doku belleği; Addressables'ta tam boy dokular | /d/27224, /d/28191, #3163 | Kısmen: skin başına atlas ve MB, import uyarıları | **Cihazda bellek denetimi** (S–M) |
| U11 | Runtime mix-and-match repack: beyaz kutular, kayma, blend mode kaybı | /d/16616, #3075, #3094 | Kısmen: `spine_skins` (spine-core) | Repack kontrolü: headless Unity'de GetRepackedSkin + render farkı (M) |
| U12 | Çok iskeletle CPU/GC, düşük donanım | /d/24125, #1348 | Kısmen: `spine_budget` | Headless performans testi (M–L) |

## 3. Öncelikli kısa liste (sonraki işler)

1. **Mecanim key kontrolü + `setupKeys` derive op'u (S).** Bir animasyonun key'leyip diğerinin t=0'da key'lemediği timeline'ları bulur, eksik ilk kare key'lerini yeni bir animasyon olarak ekler. Doküman bunu şart koşuyor ve iş tamamen JSON üzerinde.
2. **Mix penceresinde event kontrolü (S).** Gerçek mix süreleri ve EventThreshold ile hiç tetiklenmeyen event'leri listeler. Yayına çıkmış oyunlarda sessiz bir hata olarak kalıyor ve `spine_mix_check`'in doğal uzantısı.
3. **Unity yükseltme denetimi + toplu yeniden export (M).** Forumun en çok yorum alan güncel konusu bu. Esoteric'in kendi önerisi de yeniden export'u script'lemek.
4. **Animatör kopyalarını birleştirme (M).** Esoteric'in önerdiği iş akışını otomatikleştirir; transfer ve re-import diff kodunu büyük ölçüde yeniden kullanır.
5. **Ölçülmüş batching (M).** Unity'de en sık sorulan performans sorusu draw call. Bugün elimizde yalnız tahmin var.
6. **Root motion hazırlığı (S–M).** 2025–26'da sürekli soruluyor ve verinin tamamı spine-core'da.
7. **SkeletonGraphic Canvas render kontrolü (M).** 4.3'te UI tarafında sorunlar artıyor; render farkı altyapısı zaten var.
8. **Pack taraması + Unity bellek denetimi (S–M).** Mobil bütçe; mevcut export kodunu kullanır.

Ayrıca bugünden: auto rig için ayak kemiği önerisi ve bacakları birbirine yakın karakterlerde diz yönü sezgisi.
Generate araçlarına bir "hareket kalite kapısı" eklenebilir: yazmadan önce aynı ölçümler (kopan parça, kayan ayak,
çaprazlanan uzuv) uyarı olarak dönsün.

Dışarıda bırakılanlar:
- Timeline: büyük iş, zaten yol haritasında.
- URP 2D ışıkları: değerli ama büyük.
- Cihaz sıkıştırmasıyla render: önce yapılabilirlik denemesi gerekiyor.
- Mevcut rig'de mesh düzenleme: resmi kanalla yapılamıyor.
