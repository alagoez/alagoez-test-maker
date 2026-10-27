# Alagoez Test Maker

PDF soru kitapçıklarından ya da sayfa fotoğraflarından soruları kırpıp baskıya hazır yeni bir test oluşturan web uygulaması. Soru sınırı yoktur ve tamamen tarayıcıda çalışır: yüklenen dosyalar hiçbir sunucuya gönderilmez.

## Özellikler

- PDF ve resim (JPG/PNG) dosyalarından fareyle soru kırpma; kenar boşluklarını otomatik temizleme
- Kırpma kutusunu sonradan taşıma ve boyutlandırma
- Kırparken A–E cevap seçimi (klavyeden de), sürükle-bırak ile soru sıralama
- Yaprak Test, Yazılı Kağıdı ve Deneme Sınavı şablonları
- Okul adı, sınav adı, sınıf/şube, öğrenci bilgi satırı, öğretmen adı
- Kağıt boyutu (A4, A5, A3, B5, Letter, Legal), dikey/yatay, 1–4 sütun, kenar boşlukları
- Sayfa tasarım rengi, filigran, sayfa numarası, cevap anahtarı sayfası
- **Optik cevap formu:** testin başına ya da sonuna eklenir veya ayrı indirilir
  - 4 ya da 5 şık, otomatik ya da elle soru sayısı (200'e kadar), öğrenci numarası kodlama ızgarası, kitapçık türü (A–B / A–D)
  - Bir A4'e 1 ya da 2 form (kesme çizgili), soru sayısına göre otomatik büyüyen/sıkışan kabarcık düzeni
  - Köşelerde tarama (çapa) işaretleri, kodlama örneği ve yönerge; öğretmen için cevapları dolu anahtar optik
  - Ayarlar panelinde canlı önizleme
- Sorular orijinal PDF kalitesinde (vektörel) aktarılır
- Her açılışta temiz başlar; yalnızca sayfa ayarları (okul adı, şablon vb.) hatırlanır

## Kullanım

- **Yerelde:** `index.html` dosyasına çift tıklayın.
- **Yayında:** Depo statik bir sitedir; Vercel'de derleme komutu gerekmez (Framework: *Other*, kök dizin: `/`).

## Kullanılan açık kaynak kütüphaneler

- [PDF.js](https://mozilla.github.io/pdf.js/) — PDF görüntüleme (Apache-2.0)
- [pdf-lib](https://pdf-lib.js.org/) — PDF oluşturma (MIT)
- [SortableJS](https://sortablejs.github.io/Sortable/) — sürükle-bırak sıralama (MIT)
- [Jost](https://fonts.google.com/specimen/Jost) yazı tipi (SIL Open Font License)
