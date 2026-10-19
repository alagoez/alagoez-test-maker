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
- Sorular orijinal PDF kalitesinde (vektörel) aktarılır
- Çalışma tarayıcıda otomatik kaydedilir

## Kullanım

- **Yerelde:** `index.html` dosyasına çift tıklayın.
- **Yayında:** Depo statik bir sitedir; Vercel'de derleme komutu gerekmez (Framework: *Other*, kök dizin: `/`).

## Kullanılan açık kaynak kütüphaneler

- [PDF.js](https://mozilla.github.io/pdf.js/) — PDF görüntüleme (Apache-2.0)
- [pdf-lib](https://pdf-lib.js.org/) — PDF oluşturma (MIT)
- [SortableJS](https://sortablejs.github.io/Sortable/) — sürükle-bırak sıralama (MIT)
- [Jost](https://fonts.google.com/specimen/Jost) yazı tipi (SIL Open Font License)
