# ngemilssby.mima

Toko resep PDF dengan katalog berdasarkan file resep, API Node.js/Express, dan penyimpanan SQLite lokal.

## Menjalankan

Persyaratan: Node.js 22.5 atau lebih baru.

```sh
npm install
npm start
```

Buka http://localhost:3000. Database dibuat otomatis di `data/dapur-rasa.sqlite` dan tetap tersimpan setelah server dimulai ulang.

Untuk menampilkan halaman maintenance kepada pengunjung, tambahkan `MAINTENANCE_MODE=true` ke `.env`, lalu restart server. Halaman admin `/admin` dan API admin tetap bisa diakses.

Checkout menerima domisili Indonesia dan Malaysia. Harga Indonesia tetap mengikuti katalog, sedangkan harga Malaysia memakai pengali `MALAYSIA_PRICE_MULTIPLIER` (default `1.35`), dibulatkan ke ribuan terdekat, lalu ditampilkan dalam MYR memakai kurs `MALAYSIA_IDR_PER_MYR` (default `3500`). Pembayaran tetap hanya melalui QRIS; nominal QRIS selalu ditampilkan dalam Rupiah.

## Push notification admin

Push notification membutuhkan tabel `public.push_subscriptions` di Supabase dan environment variables `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, dan `VAPID_SUBJECT` di server. Jangan pernah menaruh service-role atau private VAPID key di frontend. Buat pasangan VAPID secara lokal dengan `npx web-push generate-vapid-keys`, lalu masukkan hasilnya langsung ke environment variables Vercel. Admin harus membuka situs melalui HTTPS, memasukkan token dan PIN, lalu memilih **Aktifkan notifikasi order** pada perangkat yang ingin menerima push.

Untuk production Vercel, jalankan `supabase-orders.sql` satu kali di Supabase SQL Editor. Data order dan item order kemudian disimpan di Supabase, bukan di SQLite sementara Vercel, sehingga QR dan status pembayaran tetap tersedia setelah function berganti instance. SQLite lokal tetap dipakai saat menjalankan aplikasi di komputer.

Jalankan migration tersebut sebelum deploy versi yang memindahkan order ke Supabase. Tabel memakai Row Level Security tanpa policy publik; akses dilakukan dari server melalui `SUPABASE_SERVICE_ROLE_KEY`.

## Struktur folder

- `index.html`, `admin.html`, `server.js` - halaman toko, admin, dan backend.
- `assets/brand/` - logo situs.
- `assets/payments/` - aset pembayaran lama.
- `assets/uploads/` - gambar sumber.
- `recipes/` - PDF resep aktif.
- `recipes/images/` - foto pada katalog.
- `recipes/originals/` - PDF sumber.
- `data/` - database SQLite lokal.

## API

- `GET /api/health` - status server.
- `GET /api/courses` - katalog resep.
- `POST /api/orders` - membuat pesanan berstatus menunggu pembayaran QRIS.
- `GET /api/orders/:id/payment-status?token=...` - status pembayaran pada portal order privat.
- `POST /api/admin/orders/:id/confirm-payment` - verifikasi manual QRIS dan buka akses portal resep.
- `GET /api/admin/orders` - daftar pesanan yang perlu ditindaklanjuti (bearer token admin).
- `GET /api/admin/courses` - daftar resep dan status file (bearer token admin).
- `POST /api/admin/courses` - tambah resep dengan upload PDF dan foto (bearer token admin).
- `PUT /api/admin/courses/:id` - edit resep atau ganti file resep (bearer token admin).
- `DELETE /api/admin/courses/:id` - hapus resep yang belum pernah dipesan (bearer token admin).
- `GET /api/orders/:id/access?token=...` - status dan materi untuk portal pribadi pembeli.
- `GET /api/orders/:id/recipes/:courseId?token=...` - unduh PDF pesanan yang sudah lunas.
- `GET /watch/:orderId/:videoId?token=...` - streaming video pesanan yang sudah dibayar.

Contoh body `POST /api/orders`:

```json
{
  "customer": { "name": "Ayu Putri" },
  "paymentMethod": "qris",
  "items": [{ "courseId": "dubai-chewy-cookie", "quantity": 1 }]
}
```

## Kirim resep setelah pembayaran

Katalog berisi empat PDF resep. Produk Ayam Bawang Putih dilengkapi lima video panduan: penggorengan ayam, nasi bejek, nasi daun jeruk, sambal bawang, dan sambal matah. Video marinasi ayam dan bayam crispy belum tersedia. Pembeli membuat pesanan pending lalu membayar menggunakan QRIS statis toko. Checkout mengembalikan `orderUrl` privat; pembeli sebaiknya menyimpan tautan tersebut. Karena QRIS statis tidak memberi notifikasi ke server, admin harus mencocokkan pembayaran lalu menekan konfirmasi. Setelah lunas, PDF dan video terbuka di portal dan dapat diakses lagi kapan saja. Email pembeli tidak diperlukan.

1. Isi `ADMIN_TOKEN` dengan token acak yang kuat di `.env`. Jangan membagikan atau commit token.
2. Pastikan QRIS toko tersedia di `assets/payments/qris.png`.
3. Empat file PDF sudah disalin ke folder `recipes` dengan pemetaan berikut:
  - `dubai-chewy-cookie.pdf` - Dubai Chewy Cookie (Kue & Camilan)
  - `es-pisang-hijoo.pdf` - Es Pisang Hijoo (Dessert)
  - `mangga-ketan-sticky-rice.pdf` - Mangga & Nangka Sticky rice (Dessert)
  - `ayam-bawang-putih.pdf` - Ayam Bawang Putih (Masakan Gurih)
4. Jalankan `npm start`, lalu uji dengan pesanan dan pembayaran percobaan.
5. Saat di-host, gunakan HTTPS agar tautan portal pribadi terlindungi.

Pesanan yang belum dibayar tidak bisa membuka PDF atau video. Setelah admin mengonfirmasi pembayaran, materi tersedia di portal tanpa memerlukan pengiriman email. Tautan portal berisi token akses pribadi dan sebaiknya tidak dibagikan ke orang lain.

## Kelola resep tanpa maintenance

Buka `/admin`, masukkan `ADMIN_TOKEN`, lalu gunakan panel **Kelola resep** untuk menambah atau mengedit judul, kategori, harga, deskripsi, PDF, dan foto. Perubahan katalog dibaca langsung oleh pengunjung tanpa restart atau maintenance. Saat deploy ke hosting, arahkan `RECIPE_FILES_DIR` ke storage persisten; folder lokal dapat terhapus pada redeploy di beberapa platform.
