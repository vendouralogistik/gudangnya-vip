# Gudang VIP

Aplikasi web gudang untuk PT. VENDOURA INTI PERKASA.

## Stack

- Node.js + Express
- PostgreSQL Supabase
- Tailwind CSS CDN
- Lucide Icons CDN
- Vercel Serverless
- Auto-sync frontend setiap 10 detik + saat tab kembali focus

## Deploy ke Vercel

Set environment variables:

- `DATABASE_URL` = connection string PostgreSQL dari Supabase
- `SESSION_SECRET` = string rahasia acak yang panjang

Fitur laporan menggunakan `exceljs` untuk menghasilkan file `.xlsx` langsung dari backend Vercel.

Kemudian deploy repository ke Vercel.

## Login awal

Jika database `items` masih kosong, server membaca `data-gudang-vip.json` dan membuat akun admin serta item awal.

Default contoh dari file seed:

- Username: `admin`
- Password: `admin123`

**Ganti password seed sebelum deployment produksi.**

## Catatan Supabase

Gunakan connection string PostgreSQL Supabase. Untuk deployment serverless, Supabase menyediakan connection options/pooling yang lebih sesuai untuk banyak koneksi singkat. Aplikasi ini juga membatasi ukuran pool Node.js agar tidak membuat koneksi berlebihan.

## Local development

```bash
npm install
DATABASE_URL="postgresql://..." SESSION_SECRET="secret-acak" npm start
```

Buka `http://localhost:3000`.

## Sinkronisasi

Frontend memanggil `/api/sync` setiap 10 detik dan ketika browser/tab kembali focus. Semua perubahan stok dilakukan melalui transaksi PostgreSQL sehingga validasi stok keluar dilakukan di server dan aman terhadap dua perangkat yang melakukan transaksi secara bersamaan.
